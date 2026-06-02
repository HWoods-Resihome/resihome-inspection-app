package com.resihome.resiwalk;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

/**
 * ResiWALK native shell.
 *
 * Native OUTBOUND OAuth interception (no web deploy required).
 *
 * The web login starts Google sign-in with `window.location.href =
 * '/api/auth/google-login?…'`. The JS bridge (lib/nativeBridge.ts) tries to divert
 * that to the system browser with a `client=native` marker, but redefining
 * `window.location.href` is blocked in the Android System WebView, so the marker is
 * never applied — the OAuth flow then completes in the system browser and never
 * returns to the app (see mobile/OAUTH_WEBVIEW.md / OAUTH_OUTBOUND_FIX.md).
 *
 * We intercept the navigation here, in the native WebViewClient, where it reliably
 * fires for JS-initiated main-frame loads. When the webview is about to load the
 * OAuth start path we cancel that in-webview load and instead open the URL — with
 * `client=native` appended — in the system browser. The already-deployed server
 * then marks the OAuth `state` `.native` and, after Google, 302s to
 * `resiwalk://auth-callback?t=…`, which the existing `appUrlOpen` handler catches to
 * finish login inside the app.
 *
 * Only the `/api/auth/google-login` path is diverted; all other navigation falls
 * through to Capacitor's normal handling.
 */
public class MainActivity extends BridgeActivity {

    private static final String OAUTH_START_PATH = "/api/auth/google-login";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // super.onCreate() has already run load(), so the bridge + WebView exist.
        WebView webView = this.bridge.getWebView();
        webView.setWebViewClient(
            new BridgeWebViewClient(this.bridge) {
                @Override
                public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    if (request.isForMainFrame() && shouldDivertToSystemBrowser(request.getUrl())) {
                        openOAuthInSystemBrowser(request.getUrl());
                        return true; // cancel the in-webview navigation
                    }
                    return super.shouldOverrideUrlLoading(view, request);
                }

                @Override
                @SuppressWarnings("deprecation")
                public boolean shouldOverrideUrlLoading(WebView view, String url) {
                    Uri uri = Uri.parse(url);
                    if (shouldDivertToSystemBrowser(uri)) {
                        openOAuthInSystemBrowser(uri);
                        return true;
                    }
                    return super.shouldOverrideUrlLoading(view, url);
                }
            }
        );
    }

    /** True only for the OAuth start path, and only if not already marked native. */
    private boolean shouldDivertToSystemBrowser(Uri url) {
        if (url == null) return false;
        String path = url.getPath();
        return path != null
            && path.contains(OAUTH_START_PATH)
            && !"native".equals(url.getQueryParameter("client"));
    }

    /**
     * Open the OAuth start URL in the system browser with `client=native` appended,
     * so the server returns via the resiwalk:// deep link. Uses a plain ACTION_VIEW
     * intent (the real system browser is what Google requires for OAuth, and it
     * needs no extra dependency).
     */
    private void openOAuthInSystemBrowser(Uri url) {
        Uri marked = url.buildUpon().appendQueryParameter("client", "native").build();
        Intent intent = new Intent(Intent.ACTION_VIEW, marked);
        // Launched from an Activity context, so no NEW_TASK flag is required, but it
        // keeps the browser as a separate task which is the desired behavior here.
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(intent);
    }
}
