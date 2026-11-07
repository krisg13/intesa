import Foundation
import AVFoundation
import Speech

/// Listens and reports words to the page as they arrive.
///
/// First choice: Apple's on-device SpeechAnalyzer (iOS 26) with the dictation transcriber, which is built for short
/// utterances and accepts contextual strings. The page sends the names, companies and places already in the person's
/// network so they are heard correctly, and audio never leaves the phone.
/// Fallback: the older SFSpeechRecognizer (also takes contextual strings), used where the analyzer is unavailable,
/// such as the Simulator or a device without the speech model.
/// Ends on its own after a pause, or when the page says stop.
@MainActor
final class SpeechBridge {
    /// (type, payload) → the page. Types: status, partial, final, error.
    var onEvent: ((String, [String: Any]) -> Void)?

    // One engine for the life of the app: tearing one down and building another between listens
    // trips Core Audio's remote I/O on the Simulator and costs time on a device.
    private let engine = AVAudioEngine()
    private var tapInstalled = false
    private var sessionReady = false
    private var analyzer: SpeechAnalyzer?
    private var transcriber: DictationTranscriber?
    private var input: AsyncStream<AnalyzerInput>.Continuation?
    private var resultsTask: Task<Void, Never>?
    private var legacyRequest: SFSpeechAudioBufferRecognitionRequest?
    private var legacyTask: SFSpeechRecognitionTask?
    private var pauseTask: Task<Void, Never>?
    private var committed = ""      // finalised segments so far
    private var volatile = ""       // the segment still being heard
    private var running = false
    private(set) var engineName = ""

    private let pauseSeconds: Double = 1.8

    func start(terms: [String], localeID: String) {
        Task { await begin(terms: terms, localeID: localeID) }
    }

    func stopFromPage() {
        Task { await finish(report: true) }
    }

    // MARK: - lifecycle

    private func begin(terms: [String], localeID: String) async {
        await finish(report: false)
        committed = ""; volatile = ""

        guard await micAllowed() else {
            emit("error", ["message": "Intesa needs the microphone. Allow it in Settings, or type what you would have said."])
            return
        }
        let terms = Array(terms.prefix(100))
        let locale = await pickLocale(localeID)
        do {
            try await startAnalyzer(terms: terms, locale: locale)
            engineName = "SpeechAnalyzer"
        } catch {
            await finish(report: false)
            do {
                try await startLegacy(terms: terms, locale: locale)
                engineName = "SFSpeechRecognizer"
            } catch {
                await finish(report: false)
                emit("error", ["message": "Listening is unavailable here. Type it instead."])
                return
            }
        }
        running = true
        emit("status", ["message": "Listening…"])
    }

    /// iOS 26 on-device path.
    private func startAnalyzer(terms: [String], locale: Locale) async throws {
        let transcriber = DictationTranscriber(
            locale: locale,
            contentHints: [.shortForm],
            transcriptionOptions: [],
            reportingOptions: [.volatileResults],
            attributeOptions: []
        )
        self.transcriber = transcriber

        // The speech model lives in system storage; fetch it once per language.
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            emit("status", ["message": "Getting the speech model…"])
            try await request.downloadAndInstall()
        }

        let analyzer = SpeechAnalyzer(modules: [transcriber])
        self.analyzer = analyzer

        // Names and places from the person's own map: the single biggest accuracy lever for this app.
        if !terms.isEmpty {
            let context = AnalysisContext()
            context.contextualStrings = [.general: terms]
            try await analyzer.setContext(context)
        }

        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            throw BridgeError.noAudioFormat
        }
        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        input = continuation

        resultsTask = Task { [weak self] in
            do {
                for try await result in transcriber.results {
                    let text = String(result.text.characters)
                    self?.heard(text, isFinal: result.isFinal, wholeTranscript: false)
                }
            } catch {
                if self?.running == true { await self?.fail("Could not hear you. Type it instead.") }
            }
        }

        try startAudio { buffer in
            guard let out = Self.convert(buffer, to: format) else { return }
            continuation.yield(AnalyzerInput(buffer: out))
        }
        try await analyzer.start(inputSequence: stream)
    }

    /// Older recogniser: Simulator, devices without the model, or iOS before 26.
    private func startLegacy(terms: [String], locale: Locale) async throws {
        let status = await withCheckedContinuation { (c: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
            SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) }
        }
        guard status == .authorized else { throw BridgeError.notAuthorized }
        guard let recognizer = SFSpeechRecognizer(locale: locale) ?? SFSpeechRecognizer(), recognizer.isAvailable else {
            throw BridgeError.unavailable
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        request.contextualStrings = terms
        legacyRequest = request

        try startAudio { buffer in request.append(buffer) }

        legacyTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                guard let self, self.running else { return }
                if let result { self.heard(result.bestTranscription.formattedString, isFinal: result.isFinal, wholeTranscript: true) }
                if error != nil { await self.fail("Could not hear you. Type it instead.") }
            }
        }
    }

    private func heard(_ text: String, isFinal: Bool, wholeTranscript: Bool) {
        if wholeTranscript { committed = ""; volatile = text; if isFinal { committed = text; volatile = "" } }
        else if isFinal { committed = joined(committed, text); volatile = "" }
        else { volatile = text }
        emit("partial", ["text": joined(committed, volatile)])
        // A pause after something was said ends the turn.
        pauseTask?.cancel()
        guard !joined(committed, volatile).isEmpty else { return }
        pauseTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(self?.pauseSeconds ?? 1.8))
            guard !Task.isCancelled else { return }
            await self?.finish(report: true)
        }
    }

    private func fail(_ message: String) async {
        await finish(report: false)
        emit("error", ["message": message])
    }

    /// Stop the microphone, let the recogniser flush, and (optionally) hand the page the sentence.
    private func finish(report: Bool) async {
        pauseTask?.cancel(); pauseTask = nil
        let wasRunning = running
        running = false
        if tapInstalled { engine.inputNode.removeTap(onBus: 0); tapInstalled = false }
        if engine.isRunning { engine.stop() }
        input?.finish(); input = nil
        legacyRequest?.endAudio(); legacyRequest = nil
        legacyTask?.cancel(); legacyTask = nil
        if let analyzer, wasRunning {
            try? await analyzer.finalizeAndFinishThroughEndOfInput()
        }
        resultsTask?.cancel(); resultsTask = nil
        analyzer = nil
        transcriber = nil
        if report {
            emit("final", ["text": joined(committed, volatile)])
        }
    }

    // MARK: - audio

    private func startAudio(_ sink: @escaping @Sendable (AVAudioPCMBuffer) -> Void) throws {
        if !sessionReady {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
            try session.setActive(true, options: [])
            sessionReady = true
        }
        let node = engine.inputNode
        let micFormat = node.outputFormat(forBus: 0)
        if tapInstalled { node.removeTap(onBus: 0) }
        node.installTap(onBus: 0, bufferSize: 4096, format: micFormat) { buffer, _ in sink(buffer) }
        tapInstalled = true
        engine.prepare()
        try engine.start()
    }

    nonisolated private static func convert(_ buffer: AVAudioPCMBuffer, to format: AVAudioFormat) -> AVAudioPCMBuffer? {
        if buffer.format == format { return buffer }
        guard let converter = AVAudioConverter(from: buffer.format, to: format) else { return nil }
        let ratio = format.sampleRate / buffer.format.sampleRate
        let frames = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 16
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return nil }
        var consumed = false
        var err: NSError?
        converter.convert(to: out, error: &err) { _, status in
            if consumed { status.pointee = .noDataNow; return nil }
            consumed = true; status.pointee = .haveData; return buffer
        }
        return (err == nil && out.frameLength > 0) ? out : nil
    }

    // MARK: - helpers

    private func micAllowed() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return true
        case .denied: return false
        default: return await AVAudioApplication.requestRecordPermission()
        }
    }

    private func pickLocale(_ id: String) async -> Locale {
        let wanted = Locale(identifier: id)
        let supported = await DictationTranscriber.supportedLocales
        if let exact = supported.first(where: { $0.identifier(.bcp47) == wanted.identifier(.bcp47) }) { return exact }
        if let sameLanguage = supported.first(where: { $0.language.languageCode == wanted.language.languageCode }) { return sameLanguage }
        return supported.first(where: { $0.identifier(.bcp47) == "en-US" }) ?? wanted
    }

    private func joined(_ a: String, _ b: String) -> String {
        let x = a.trimmingCharacters(in: .whitespaces), y = b.trimmingCharacters(in: .whitespaces)
        if x.isEmpty { return y }
        if y.isEmpty { return x }
        return x + " " + y
    }

    private func emit(_ type: String, _ payload: [String: Any]) { onEvent?(type, payload) }

    enum BridgeError: Error { case noAudioFormat, notAuthorized, unavailable }
}
