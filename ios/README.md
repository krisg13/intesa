# Intesa for iPhone

A thin SwiftUI shell around the Intesa web page. Native code owns the microphone
(Apple SpeechAnalyzer, on device) and the Contacts picker; the page owns the rest.

## Build

1. Xcode 26 or later (the iOS SDK and Simulator come with it).
2. `brew install xcodegen`.
3. In this folder: `./sync-web.sh && xcodegen generate`, open `Intesa.xcodeproj`, pick an iPhone simulator, Run.

## How the page and the shell talk

Page → native (injected as `window.intesaNative`): `startListening(json)`, `stopListening()`, `pickContacts()`.
Native → page: `window.intesaNativeEvent({type, ...})` with `status`, `partial`, `final`, `error`, `contacts`.
An Android shell implements the same two surfaces with its own recogniser.

Set the user default `intesa.remote` to a URL to load the hosted page instead of the bundled copy while designing.
