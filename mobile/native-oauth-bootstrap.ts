// native-oauth-bootstrap.ts
//
// REFERENCE implementation for Part A of OAUTH_WEBVIEW.md. This runs in the
// native shell (not the web app). It opens the Google sign-in step in the system
// browser and handles the deep-link return, so OAuth doesn't get blocked by
// Google's embedded-webview policy.
//
// How to wire it in: import and call `installOAuthBridge()` once at app start.
// On iOS this typically lives in a small TS entry compiled into the shell; for a
// pure server.url shell with no bundled JS, the equivalent logic is added in the
// native layer (AppDelegate / MainActivity) — but most teams add a tiny bundled
// bootstrap. Keep it minimal; it must not alter the web app.

import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';

const APP_SCHEME = 'resiwalk';
const OAUTH_START_PATH = '/api/auth/google-login';

export function installOAuthBridge() {
  // 1) Intercept clicks/navigations to the Google sign-in start path and route
  //    them through the SYSTEM browser instead of the embedded webview.
  document.addEventListener(
    'click',
    (e) => {
      const a = (e.target as HTMLElement)?.closest?.('a') as HTMLAnchorElement | null;
      const href = a?.href || '';
      if (href.includes(OAUTH_START_PATH)) {
        e.preventDefault();
        // Append a marker so the callback can return via the app scheme.
        const url = href + (href.includes('?') ? '&' : '?') + 'client=native';
        void Browser.open({ url });
      }
    },
    true
  );

  // The web app uses window.location.href for the handoff (not an <a>), so also
  // patch that path: a MutationObserver/location shim is fragile; the robust
  // approach is the small web-side change in OAUTH_WEBVIEW.md Part B that makes
  // the handoff an actual link or posts a message the shell can catch. See that
  // doc — test first to learn whether this is even necessary.

  // 2) Handle the deep-link return from the system browser.
  App.addListener('appUrlOpen', async ({ url }: { url: string }) => {
    if (url.startsWith(`${APP_SCHEME}://auth-callback`)) {
      await Browser.close();
      // Session cookie is already set on the Vercel origin by the callback.
      // Reload the webview to the authenticated home route.
      window.location.href = '/';
      // Android isolated-cookie variant: if the session doesn't carry over,
      // parse a one-time token from `url` and navigate to
      // `/api/auth/exchange?t=...` instead (see OAUTH_WEBVIEW.md).
    }
  });
}
