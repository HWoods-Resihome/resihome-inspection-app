# Camera & Microphone — making the prompt one-time / seamless

The "Allow camera / microphone?" prompt is enforced by the browser/OS for
privacy. **A website cannot add itself to a "safe/allowed" list or self-approve**
— there is no web API for it. How seamless it feels depends entirely on WHERE
ResiWALK runs. Solved per surface below.

## 1. Native Android app — already one-time ✅
Capacitor's `BridgeWebChromeClient.onPermissionRequest` requests the OS runtime
permission (CAMERA / RECORD_AUDIO — declared in `AndroidManifest.xml`) **once** at
first camera/mic use, then auto-grants every in-webview `getUserMedia` after that.
So the Android app already behaves correctly: a single OS prompt at first use,
seamless thereafter. **Do not replace the WebChromeClient** in `MainActivity` —
that would break Capacitor's file-chooser / JS dialogs and the smart grant.

Nothing to change here. Verify after install: first photo/video/voice → one OS
prompt → never again.

## 2. Native iOS app — the fix that ends iOS prompting (must be built on a Mac)
There is **no iOS project yet** (`mobile/ios/` is not generated), which is why iOS
inspectors fall back to Safari/Chrome and keep getting prompted. Building the iOS
Capacitor app makes it one-time, exactly like Android:

```
# on macOS with Xcode installed
cd mobile
npx cap add ios
npx cap sync ios
```

Then two changes in the generated `ios/App` project:

### a) Info.plist — usage strings (required or iOS kills the app on first use)
```xml
<key>NSCameraUsageDescription</key>
<string>ResiWALK uses the camera to photograph and record inspection evidence.</string>
<key>NSMicrophoneUsageDescription</key>
<string>ResiWALK uses the microphone for voice call-outs during inspections.</string>
<key>NSLocationWhenInUseUsageDescription</key>
<string>ResiWALK stamps inspection photos with the property location.</string>
```

### b) Auto-grant getUserMedia in the WKWebView (iOS 15+)
Capacitor's web view is a `WKWebView`. Implement the media-capture delegate so the
web layer's `getUserMedia` is granted automatically (the OS still asks ONCE via the
Info.plist prompt). Add to the bridge view controller (e.g. a small plugin or an
`AppDelegate`/`CAPBridgeViewController` subclass):

```swift
import WebKit

// In the WKUIDelegate for Capacitor's web view:
@available(iOS 15.0, *)
func webView(_ webView: WKWebView,
             requestMediaCapturePermissionFor origin: WKSecurityOrigin,
             initiatedByFrame frame: WKFrameInfo,
             type: WKMediaCaptureType,
             decisionHandler: @escaping (WKPermissionDecision) -> Void) {
    // The app IS the trusted container (it only ever loads resiwalk's own URL via
    // server.url), so grant — the one-time OS prompt from Info.plist still gates
    // the hardware.
    decisionHandler(.grant)
}
```

Result: one OS prompt at first use, seamless forever after — matching Android.

> Parity reminder (see CLAUDE.md): camera ⇒ `CAMERA`/`NSCameraUsageDescription`,
> mic ⇒ `RECORD_AUDIO`/`NSMicrophoneUsageDescription`. Both are already declared on
> Android; add the iOS Info.plist keys when the iOS project is generated.

## 3. Mobile browser (Safari / Chrome on iOS, Chrome on Android) — cannot auto-approve
In a browser the OS requires user consent; no code can pre-approve it. Two levers:

- **Per-site "Allow" (the closest thing to a domain allowlist), set once per device:**
  - **iOS Safari:** tap **aA** in the address bar → **Website Settings** → set
    **Camera** and **Microphone** to **Allow**.
  - **iOS Chrome:** ⋯ → **Settings → Content Settings → Camera/Microphone**, or accept
    the prompt once (Chrome remembers per site for the session).
  - **Android Chrome:** the lock icon → **Permissions** → **Camera/Microphone → Allow**.
- **App-side reduction (shipped on `main`):** the voice mic now reuses ONE stream
  for the whole voice session instead of re-acquiring on every tap, so the browser
  only prompts once per session rather than every time you tap the mic.

The camera still prompts once per browser session (re-acquired on each open); the
only way to make THAT fully seamless is the native app (sections 1–2).

## TL;DR
- Android app: already one-time. ✅
- iOS app: build it (above) → one-time. The definitive iOS fix.
- Browser: can't auto-approve; set the site to "Allow" once, and the shipped
  mic-stream reuse removes the repeat mic prompts.
