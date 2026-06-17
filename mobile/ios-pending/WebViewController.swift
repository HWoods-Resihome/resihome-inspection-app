import UIKit
import Capacitor
import WebKit

/// Capacitor bridge view controller for ResiWALK.
///
/// PARKED — two native behaviors are intended here but are deliberately NOT
/// implemented yet, because in Capacitor 6 the WKNavigationDelegate / WKUIDelegate
/// live on an internal `WebViewDelegationHandler`, NOT on `CAPBridgeViewController`.
/// Overriding `webView(_:decidePolicyFor:decisionHandler:)` or
/// `webView(_:requestMediaCapturePermissionFor:…)` on this subclass does not
/// compile ("does not override any method from its superclass") and would never
/// be invoked as a delegate callback. The intended behaviors are:
///
///   1. Auto-grant the in-app WebView's getUserMedia (camera + microphone) so the
///      app doesn't show a second prompt on top of the one-time iOS permission.
///   2. Divert Google OAuth to the SYSTEM browser (Google blocks OAuth in embedded
///      web views); the sign-in returns via the `resiwalk://auth-callback` deep
///      link handled by the @capacitor/app appUrlOpen listener in the web app.
///
/// Reimplement against Capacitor 6 (e.g. install a custom delegate on
/// `bridge?.webView` in `viewDidLoad`, or a CAPPlugin) and verify on a real
/// device — emulator camera/OAuth behavior is unreliable. Tracked as native
/// follow-up work; not required for the wrapper to build and ship.
///
/// Wire-up: Base.lproj/Main.storyboard sets the Bridge VC's Custom Class to
/// `WebViewController` (Module: App).
class WebViewController: CAPBridgeViewController {
}
