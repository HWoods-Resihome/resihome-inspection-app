import UIKit
import Capacitor
import WebKit

/// Capacitor bridge view controller for ResiWALK with two native behaviors the
/// generated default doesn't provide:
///
///  1. Auto-grant the in-app WebView's getUserMedia (camera + microphone), so the
///     app never shows a SECOND "Allow camera/mic?" prompt on top of the one-time
///     iOS permission. ResiWALK only ever loads its own site (server.url), so the
///     app IS the trusted container; the Info.plist usage prompts (asked once)
///     still gate the hardware. iOS 15+.
///
///  2. Divert Google OAuth to the SYSTEM browser. Google blocks OAuth inside
///     embedded web views ("disallowed_useragent"), so the sign-in start path is
///     opened in Safari and returns via the `resiwalk://auth-callback` deep link
///     (registered in Info.plist URL Types; the @capacitor/app appUrlOpen handler
///     in the web app finishes login). Mirrors Android MainActivity.
///
/// Wire-up: in Base.lproj/Main.storyboard set the Bridge View Controller's
/// Custom Class to `WebViewController` (Module: App).
class WebViewController: CAPBridgeViewController {

    private let oauthStartPath = "/api/auth/google-login"

    // MARK: - Camera / mic auto-grant
    @available(iOS 15.0, *)
    override func webView(_ webView: WKWebView,
                          requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                          initiatedByFrame frame: WKFrameInfo,
                          type: WKMediaCaptureType,
                          decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.grant)
    }

    // MARK: - OAuth → system browser
    override func webView(_ webView: WKWebView,
                          decidePolicyFor navigationAction: WKNavigationAction,
                          decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url,
           navigationAction.targetFrame?.isMainFrame ?? true,
           shouldDivertToSystemBrowser(url) {
            openOAuthInSystemBrowser(url)
            decisionHandler(.cancel)
            return
        }
        // Not an OAuth start URL — allow it. (We can't chain to
        // `super.webView(_:decidePolicyFor:decisionHandler:)` because the
        // `webView` property on CAPBridgeViewController shadows the method name,
        // so the call won't compile. Allowing is the correct default here: the
        // app only loads its own site and the OAuth return arrives via the
        // resiwalk:// deep link, not in-WebView navigation.)
        decisionHandler(.allow)
    }

    private func shouldDivertToSystemBrowser(_ url: URL) -> Bool {
        guard url.path.contains(oauthStartPath) else { return false }
        let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let alreadyNative = comps?.queryItems?.first(where: { $0.name == "client" })?.value == "native"
        return !alreadyNative
    }

    private func openOAuthInSystemBrowser(_ url: URL) {
        guard var comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return }
        var items = comps.queryItems ?? []
        items.append(URLQueryItem(name: "client", value: "native"))
        comps.queryItems = items
        if let marked = comps.url {
            UIApplication.shared.open(marked, options: [:], completionHandler: nil)
        }
    }
}
