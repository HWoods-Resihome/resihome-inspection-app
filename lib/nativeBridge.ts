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
// Both provider sign-in start paths must open in the system browser (and carry
// the native marker) so the resiwalk:// deep-link return works on Android.
const OAUTH_START_PATHS = ['/api/auth/google-login', '/api/auth/microsoft-login'];
const isOAuthStartPath = (u: string) => typeof u === 'string' && OAUTH_START_PATHS.some((p) => u.includes(p));

let installed = false;

// Recolor the NATIVE status bar in the Capacitor shell (Android). The web/PWA
// status bar is handled separately by swapping the <meta name="theme-color">.
// Driven through the runtime-registered global plugin (window.Capacitor.Plugins
// .StatusBar) so we DON'T pull @capacitor/status-bar into the web bundle — the
// plugin already ships in the native binary (mobile/package.json), and the
// native app loads this live web app via server.url, so the call resolves there.
// HARD GATE: no-op in any normal browser (isNativePlatform() === false).
export function setNativeStatusBarColor(color: string): void {
  if (typeof window === 'undefined') return;
  const cap = (window as any).Capacitor;
  if (!cap?.isNativePlatform?.()) return;
  const sb = cap.Plugins?.StatusBar;
  if (!sb) return;
  try {
    // Keep light icons (Style.Dark == light content) — both black and brand
    // pink are dark enough to need them.
    sb.setBackgroundColor?.({ color });
    sb.setStyle?.({ style: 'DARK' });
  } catch { /* iOS no-op / plugin unavailable — fine */ }
}

// Hide/show the NATIVE keyboard accessory toolbar (the iOS "< >  Done / AutoFill"
// bar that sits just above the keys). Driven through the runtime-registered
// global plugin (window.Capacitor.Plugins.Keyboard) so we DON'T pull
// @capacitor/keyboard into the web bundle — the plugin ships in the native
// binary (mobile/package.json) and the native app loads this live web app via
// server.url, so the call resolves there. iOS-only in Capacitor; a no-op on
// Android (no such bar) and in any normal browser (isNativePlatform() === false).
// Safe to call before the plugin exists in the native build — it just no-ops.
export function setNativeKeyboardAccessoryBarVisible(visible: boolean): void {
  if (typeof window === 'undefined') return;
  const cap = (window as any).Capacitor;
  if (!cap?.isNativePlatform?.()) return;
  const kb = cap.Plugins?.Keyboard;
  if (!kb?.setAccessoryBarVisible) return;
  try { kb.setAccessoryBarVisible({ isVisible: visible }); } catch { /* plugin unavailable — fine */ }
}

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

    

    // Patch location.assign
    try {
      Object.defineProperty(loc, 'assign', {
        configurable: true,
        value: (url: string) => {
          if (isOAuthStartPath(url)) { openInSystemBrowser(url); return; }
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
            if (isOAuthStartPath(url)) { openInSystemBrowser(url); return; }
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
      if (isOAuthStartPath(href)) {
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

// ---------------------------------------------------------------------------
// Native push (FCM / APNs) registration bridge.
//
// In the Capacitor shell, the @capacitor/push-notifications plugin yields a
// native device token; we register it with the server (POST /api/push/subscribe
// platform:'native') so approval alerts reach the installed app via FCM. Web
// (PWA) push is handled separately by lib/pushClient — this path is native-only
// and a complete no-op in a normal browser (the isNativePlatform gate).
// ---------------------------------------------------------------------------
let pushInstalled = false;

export async function installPushBridge(): Promise<void> {
  if (typeof window === 'undefined' || pushInstalled) return;

  let Capacitor: typeof import('@capacitor/core').Capacitor;
  try { ({ Capacitor } = await import('@capacitor/core')); } catch { return; }
  if (!Capacitor.isNativePlatform()) return; // browser → PWA push path handles it

  let PushNotifications: typeof import('@capacitor/push-notifications').PushNotifications;
  try { ({ PushNotifications } = await import('@capacitor/push-notifications')); } catch { return; }

  pushInstalled = true;

  const sendToken = (value: string) => {
    if (!value) return;
    void fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'native', token: value }),
    }).catch(() => { /* best-effort; re-registers next launch */ });
  };

  try {
    // Register the token (idempotent server-side) and route notification taps.
    await PushNotifications.addListener('registration', (t: { value: string }) => sendToken(t.value));
    await PushNotifications.addListener('registrationError', (e: unknown) => {
      try { console.warn('[push] native registration error:', e); } catch { /* noop */ }
    });
    await PushNotifications.addListener('pushNotificationActionPerformed', (action: any) => {
      const url = action?.notification?.data?.url;
      if (typeof url === 'string' && url) window.location.href = url;
    });

    // Ask for permission (Android 13+ / iOS prompt), then register if granted.
    let perm = await PushNotifications.checkPermissions();
    if (perm.receive === 'prompt') perm = await PushNotifications.requestPermissions();
    if (perm.receive === 'granted') await PushNotifications.register();
  } catch (e) {
    try { console.warn('[push] native bridge setup failed:', e); } catch { /* noop */ }
  }
}
