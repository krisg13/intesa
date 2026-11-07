import SwiftUI
import WebKit

/// Hosts the bundled Intesa page and carries messages both ways.
///
/// Page → native: `window.intesaNative.startListening(json)`, `.stopListening()`, `.pickContacts()`
/// Native → page: `window.intesaNativeEvent({type, ...})` with types
///   status {message}, partial {text}, final {text}, error {message}, contacts {items:[{name,email,phone,company,title}]}
///
/// The same contract is what an Android shell would implement, with its own recogniser behind it.
struct IntesaWebView: UIViewRepresentable {
    /// Set `intesa.remote` in UserDefaults to a URL to load the hosted page instead of the bundled copy (handy while designing).
    private var remoteURL: URL? {
        guard let s = UserDefaults.standard.string(forKey: "intesa.remote"), let u = URL(string: s) else { return nil }
        return u
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.defaultWebpagePreferences.allowsContentJavaScript = true

        let bridge = """
        (function(){
          if (window.intesaNative) return;
          const post = (cmd, payload) => window.webkit.messageHandlers.intesa.postMessage({cmd: cmd, payload: payload === undefined ? null : payload});
          window.intesaNative = {
            platform: 'ios',
            startListening: function(json){ post('startListening', json); },
            stopListening: function(){ post('stopListening'); },
            pickContacts: function(){ post('pickContacts'); }
          };
        })();
        """
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(source: bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        controller.add(context.coordinator, name: "intesa")
        config.userContentController = controller

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never // the page handles safe areas itself with env()
        webView.allowsBackForwardNavigationGestures = false
        webView.navigationDelegate = context.coordinator
        #if DEBUG
        webView.isInspectable = true
        #endif
        context.coordinator.webView = webView

        if let remote = remoteURL {
            webView.load(URLRequest(url: remote))
        } else if let index = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "Web") {
            webView.loadFileURL(index, allowingReadAccessTo: index.deletingLastPathComponent())
        }
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        weak var webView: WKWebView?
        lazy var speech: SpeechBridge = {
            let s = SpeechBridge()
            s.onEvent = { [weak self] type, payload in self?.send(type: type, payload: payload) }
            return s
        }()
        lazy var contacts: ContactsBridge = {
            let c = ContactsBridge()
            c.onPicked = { [weak self] items in self?.send(type: "contacts", payload: ["items": items]) }
            c.onCancelled = { [weak self] in self?.send(type: "contacts", payload: ["items": []]) }
            return c
        }()

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "intesa", let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else { return }
            switch cmd {
            case "startListening":
                var terms: [String] = [], locale = Locale.current.identifier
                if let json = body["payload"] as? String, let data = json.data(using: .utf8),
                   let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    terms = (obj["terms"] as? [String]) ?? []
                    locale = (obj["locale"] as? String) ?? locale
                }
                speech.start(terms: terms, localeID: locale)
            case "stopListening":
                speech.stopFromPage()
            case "pickContacts":
                contacts.present()
            default:
                break
            }
        }

        /// Deliver an event to the page as `window.intesaNativeEvent({...})`.
        func send(type: String, payload: [String: Any]) {
            var obj = payload
            obj["type"] = type
            guard let data = try? JSONSerialization.data(withJSONObject: obj), let json = String(data: data, encoding: .utf8) else { return }
            webView?.evaluateJavaScript("window.intesaNativeEvent && window.intesaNativeEvent(\(json));", completionHandler: nil)
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            // Links out of the page (LinkedIn, mail, phone) open in the system, not inside the shell.
            if navigationAction.navigationType == .linkActivated, let url = navigationAction.request.url, url.scheme != "file", url.host != webView.url?.host {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }
    }
}
