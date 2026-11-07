import SwiftUI

/// Intesa: a thin native shell around the Intesa web page.
/// Native code owns the microphone (SpeechAnalyzer) and the Contacts picker; the page owns everything else.
@main
struct IntesaApp: App {
    var body: some Scene {
        WindowGroup {
            IntesaWebView()
                .ignoresSafeArea()
                .background(Color(red: 1, green: 1, blue: 0.973)) // paper, matches --bg while the page loads
        }
    }
}
