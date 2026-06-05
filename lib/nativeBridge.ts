// lib/nativeBridge.ts
//
// Gated native-only OAuth bridge for the ResiWalk Capacitor shell.
//
// WHY: Google blocks OAuth inside embedded webviews (`disallowed_useragent`), so
// the Google step must run in the SYSTEM browser. But on Android the resulting
// session cookie lands in the system browser's cookie jar, which the app's
// webview can't read — so after auth the user is stuck in Chrome and the app
// never becomes authenticated. This bridge:
//
//   1) Routes the `/api/auth/google-login` navigation through the system browser
//      with a `client=native` marker (so the server returns via a deep link).
//   2) Listens for the `resiwalk://auth-callback?t=<token>` deep link and loads
//      `/api/auth/exchange?t=<token>` in the app's OWN webview, which sets the
//      session cookie in the webview jar and lands on `/`.
//
// HARD GATE: every code path here is behind `Capacitor.isNativePlatform()`.
// `installOAuthBridge()` is a no-op (returns immediately) in a normal browser,
// so web users' behavior is byte-for-byte unchanged. The Capacitor packages are
// imported dynamically so they're never pulled into the browser bundle's
// critical path and a missing native runtime can't throw.

const APP_SCHEME = 'resiwalk';
const OAUTH_START_PATH = '/api/auth/google-login';

let installed = false;

export async function installOAuthBridge(): Promise<void> {
  // SSR / non-browser guard.
  if (typeof window === 'undefined') return;
  if (installed) return;

  // Dynamically import so the browser bundle doesn't eagerly evaluate native code.
  let Capacitor: typeof import('@capacitor/core').Capacitor;
  try {
    ({ Capacitor } = await import('@capacitor/core'));
  } catch {
    return; // Capacitor not available — nothing to do.
  }

  // THE GATE: do nothing at all in a normal browser.
  if (!Capacitor.isNativePlatform()) return;

  installed = true;

  const { App } = await import('@capacitor/app');
  const { Browser } = await import('@capacitor/browser');

  // (1) Open the Google sign-in start URL in the SYSTEM browser, tagged native.
  const openInSystemBrowser = (rawUrl: string) => {
    const abs = rawUrl.startsWith('http')
      ? rawUrl
      : `${window.location.origin}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`;
    const marked = abs + (abs.includes('?') ? '&' : '?') + 'client=native';
    void Browser.open({ url: marked });
  };

  // The login page navigates via `window.location.href = '/api/auth/google-login?…'`
  // (not an <a>), so we intercept assignments to window.location for that one
  // path. We patch `assign` and the `href` setter; both funnel to the same
  // handler. Only the OAuth start path is diverted — every other navigation is
  // passed through untouched, so in-app routing is unaffected.
  try {
    const loc = window.location;
    const originalAssign = loc.assign.bind(loc);

    const isOAuthStart = (u: string) => typeof u === 'string' && u.includes(OAUTH_START_PATH);

    // Patch location.assign
    try {
      Object.defineProperty(loc, 'assign', {
        configurable: true,
        value: (url: string) => {
          if (isOAuthStart(url)) { openInSystemBrowser(url); return; }
          originalAssign(url);
        },
      });
    } catch { /* some webviews lock location.assign; the href patch below still covers it */ }

    // Patch the `href` setter (this is what login.tsx actually uses).
    const proto = Object.getPrototypeOf(loc);
    const hrefDesc = Object.getOwnPropertyDescriptor(proto, 'href')
      || Object.getOwnPropertyDescriptor(loc, 'href');
    if (hrefDesc && hrefDesc.set) {
      const originalHrefSet = hrefDesc.set.bind(loc);
      try {
        Object.defineProperty(loc, 'href', {
          configurable: true,
          get: hrefDesc.get ? hrefDesc.get.bind(loc) : undefined,
          set: (url: string) => {
            if (isOAuthStart(url)) { openInSystemBrowser(url); return; }
            originalHrefSet(url);
          },
        });
      } catch { /* fall through to click interception */ }
    }
  } catch {
    /* location patching unsupported — click interception below is the fallback */
  }

  // Fallback: also catch <a href> clicks pointing at the OAuth start path.
  document.addEventListener(
    'click',
    (e) => {
      const a = (e.target as HTMLElement)?.closest?.('a') as HTMLAnchorElement | null;
      const href = a?.href || '';
      if (href.includes(OAUTH_START_PATH)) {
        e.preventDefault();
        openInSystemBrowser(href);
      }
    },
    true
  );

  // (2) Handle the deep-link return from the system browser.
  await App.addListener('appUrlOpen', async ({ url }: { url: string }) => {
    if (!url.startsWith(`${APP_SCHEME}://auth-callback`)) return;
    try { await Browser.close(); } catch { /* already closed */ }

    // Extract the one-time exchange token and load the exchange endpoint in the
    // app's OWN webview so the session cookie is set in the webview's jar.
    let token = '';
    try {
      const q = url.split('?')[1] || '';
      const params = new URLSearchParams(q);
      token = params.get('t') || '';
    } catch { /* no token */ }

    if (token) {
      window.location.href = `/api/auth/exchange?t=${encodeURIComponent(token)}`;
    } else {
      // No token (shouldn't happen on Android) — best effort: go home. If the
      // session cookie happened to carry over (iOS shared jar), we're authed;
      // otherwise the route guard sends us back to /login.
      window.location.href = '/';
    }
  });
}
