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

// Start an OAuth provider sign-in from the SYSTEM browser when running inside
// the Capacitor shell, tagged `client=native` so the server returns via the
// resiwalk:// deep link (handled by installOAuthBridge's appUrlOpen listener
// below → /api/auth/exchange). Call this from the login UI BEFORE the in-webview
// navigation fallback:
//
//   if (await openOAuthStartNative(url)) return;   // native handled it
//   window.location.href = url;                    // normal browser
//
// Returns true ONLY if it opened the system browser (native). In a normal
// browser it returns false and does nothing, so web/PWA is byte-for-byte
// unchanged. Unlike installOAuthBridge's window.location monkey-patch (which is
// unreliable in the iOS WKWebView and silently no-ops — the reason the iOS
// deep-link return previously failed), this is an explicit, reliable call.
export async function openOAuthStartNative(rawUrl: string): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  let Capacitor: typeof import('@capacitor/core').Capacitor;
  try { ({ Capacitor } = await import('@capacitor/core')); } catch { return false; }
  if (!Capacitor.isNativePlatform()) return false;
  try {
    const { Browser } = await import('@capacitor/browser');
    const abs = rawUrl.startsWith('http')
      ? rawUrl
      : `${window.location.origin}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`;
    const marked = abs + (abs.includes('?') ? '&' : '?') + 'client=native';
    await Browser.open({ url: marked });
    return true;
  } catch {
    return false; // fall back to normal in-webview navigation
  }
}

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

// Prompt for Location ("When In Use") early, on first app open, instead of
// waiting until the first photo is captured — so GPS is ready to stamp evidence
// photos from the start. We use the WEB geolocation API (the camera/evidence
// code already uses navigator.geolocation), which inside the Capacitor WKWebView
// surfaces the OS permission sheet IFF the native build declares the usage
// string (iOS Info.plist NSLocationWhenInUseUsageDescription; Android
// ACCESS_FINE/COARSE_LOCATION in the manifest). NATIVE-ONLY: never prompts on
// web/PWA, where asking for location at launch (before any feature needs it)
// would be intrusive. Best-effort and silent — a denial/timeout just no-ops and
// the evidence stamp falls back to "no GPS" as it does today.
export function primeLocationPermissionNative(): void {
  if (typeof window === 'undefined') return;
  const cap = (window as any).Capacitor;
  if (!cap?.isNativePlatform?.()) return;
  if (typeof navigator === 'undefined' || !navigator.geolocation) return;
  try {
    navigator.geolocation.getCurrentPosition(
      () => { /* granted — fix discarded; we only wanted the prompt */ },
      () => { /* denied/unavailable — silent, feature degrades gracefully */ },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 }
    );
  } catch { /* no geolocation — fine */ }
}

// History-state markers that an in-app overlay pushes while it's open, so the
// back gesture can dismiss the overlay (pop its entry → popstate → close)
// instead of leaving the page. Keep in sync with:
//   • lib/useBackToClose.ts        → { rwOverlay: true }   (camera, number pad, modals)
//   • components/PdfViewer.tsx     → { __pdfViewer: true } / { __pdfGallery: true }
const OVERLAY_STATE_KEYS = ['rwOverlay', '__pdfViewer', '__pdfGallery'];
function hasOpenOverlay(): boolean {
  const st: any = window.history.state;
  return !!st && OVERLAY_STATE_KEYS.some((k) => st[k]);
}

/** What a back press should do, given the current page + overlay state. Pure so
 *  it can be unit-tested without the native runtime:
 *    'overlay'  → an overlay is open; pop history to close it (stay put)
 *    'minimize' → leave the app (home screen / nothing left to go back to)
 *    'home'     → route to the inspections list ('/')
 *    'back'     → ordinary history back
 */
export type BackAction = 'overlay' | 'minimize' | 'home' | 'back';
export function decideBackAction(opts: {
  pathname: string;
  overlayOpen: boolean;
  canGoBack: boolean;
}): BackAction {
  if (opts.overlayOpen) return 'overlay';
  if (opts.pathname === '/') return 'minimize';        // home → exit the app
  if (opts.pathname.startsWith('/inspection/')) return 'home'; // inspection → home list
  return opts.canGoBack ? 'back' : 'minimize';         // elsewhere → history back
}

// Android hardware/gesture back-button guard for the Capacitor shell.
//
// By DEFAULT, Capacitor's back behavior is: go back in the WebView's page
// history, and if there's nothing to go back to, QUIT the app. That's both
// destructive (a back inside a PDF could quit the app) and — because the in-app
// Back button and the prev/next pager navigate with router.push (STACKING
// history) — unreliable: a plain history.back() from an inspection can land on a
// previously-viewed inspection instead of the home list. This installs a
// `backButton` listener (Android-only) that makes back DETERMINISTIC:
//   1. An open overlay (camera / number pad / modal / PDF viewer or gallery)
//      owns the press → pop its history entry so it closes (stay on the page).
//   2. On the HOME/root screen ('/'), back LEAVES the app (minimize → device
//      home screen) — the inspections list is the app's top level / exit point.
//   3. Inside an inspection ('/inspection/...', any template), back returns to
//      the home list — routed explicitly, NOT via history depth, so it always
//      lands on home regardless of how many inspections the pager walked through.
//   4. Any other route → ordinary history back (minimize when nothing's left).
//
// `goHome` performs the SPA navigation to '/' (router.push from _app); a full-
// reload fallback is used if it's not supplied or throws. Registering a
// backButton listener disables Capacitor's default handling, so we drive
// navigation ourselves. Uses the runtime-registered global plugin
// (window.Capacitor.Plugins.App) — same approach as the StatusBar/Keyboard
// helpers — so @capacitor/app isn't forced into the browser bundle's critical
// path. HARD GATE: no-op in any normal browser (isNativePlatform() === false).
let backGuardInstalled = false;
export function installNativeBackGuard(goHome?: () => void): void {
  if (typeof window === 'undefined' || backGuardInstalled) return;
  const cap = (window as any).Capacitor;
  if (!cap?.isNativePlatform?.()) return;
  const app = cap.Plugins?.App;
  if (!app?.addListener) return;
  backGuardInstalled = true;
  const minimize = () => {
    // Don't exitApp() — backgrounding is the expected Android behavior and
    // keeps the session/state alive for when the user reopens the app.
    try { app.minimizeApp?.(); } catch { /* older plugin — just ignore */ }
  };
  const navHome = () => {
    if (window.location.pathname === '/') return;
    try { if (goHome) { goHome(); return; } } catch { /* fall through to reload */ }
    try { window.location.assign('/'); } catch { /* nothing else to try */ }
  };
  try {
    app.addListener('backButton', (e: { canGoBack?: boolean }) => {
      const action = decideBackAction({
        pathname: window.location.pathname,
        overlayOpen: hasOpenOverlay(),
        canGoBack: !!e?.canGoBack || window.history.length > 1,
      });
      switch (action) {
        // An open overlay owns the press: pop its pushed entry so popstate
        // closes it and we stay on the current page.
        case 'overlay': window.history.back(); break;
        case 'minimize': minimize(); break;
        case 'home': navHome(); break;
        case 'back': window.history.back(); break;
      }
    });
  } catch { /* plugin unavailable in this build — default behavior stands */ }
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
