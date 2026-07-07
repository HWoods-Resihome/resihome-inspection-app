import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';

const PUBLIC_PATHS = new Set<string>([
  '/login',
  // PWA install + on-device diagnostics page — reachable without a session.
  '/install',
  // PWA manifest MUST be public. Android Chrome mints the installed app (a
  // WebAPK) via Google's WebAPK server, which fetches this file with NO cookies.
  // If it's auth-gated it gets the /login redirect instead of the manifest,
  // minting fails, and Chrome silently falls back to a plain home-screen
  // shortcut that opens in a browser tab ("it's just a web page"). The icons
  // (.png) and /sw.js (.js) are already public via isStaticAsset().
  '/manifest.webmanifest',
  '/api/auth/login',
  '/api/auth/logout',
  // App Store review sign-in: a server-validated email+password path (password
  // is a server env secret, disabled unless set) that mints a session without
  // Google/2FA — for Apple's App Review demo account. Pre-session like /login.
  '/api/auth/review-login',
  // Email sign-in code (OTP) — fallback for users who can't complete Google/
  // Microsoft OAuth (e.g. a Zoho mailbox). Both run before a session exists.
  '/api/auth/otp-request',
  '/api/auth/otp-verify',
  // Pre-auth Google sign-in: these run before a session exists. The callback
  // does its own verification (login flow needs no session; the legacy connect
  // flow checks the session itself).
  '/api/auth/google-login',
  '/api/auth/gmail/callback',
  // Microsoft/Outlook sign-in (external 1099 agents) — same pre-session pair as
  // Google: these run before a session exists; the callback verifies itself.
  '/api/auth/microsoft-login',
  '/api/auth/microsoft/callback',
  // Native OAuth return: validates a short-TTL token and sets the session in the
  // app webview's cookie jar. Must be reachable pre-session, like the callbacks.
  '/api/auth/exchange',
  // Client error telemetry must accept reports even before/without a session
  // (e.g. a crash on the login page) — it stores no sensitive data.
  '/api/telemetry/error',
  // Real-user Web Vitals beacon — same rationale (may fire pre-auth / on unload).
  '/api/telemetry/vitals',
  // Version check for the update prompt — must work even when the session has
  // gone stale (so we can still tell the inspector to reload).
  '/api/version',
  // Vercel Cron hits these with no session cookie; each enforces its own
  // CRON_SECRET bearer auth inside the handler.
  '/api/cron/sftp-watch',
  '/api/cron/blob-cleanup',
  '/api/cron/auto-cancel-stale',
  '/api/cron/training-guide-sync',
  '/api/cron/warm-inspections',
  // HubSpot change webhook → cache invalidation. Called with no session cookie;
  // self-enforces HUBSPOT_WEBHOOK_SECRET (Bearer / ?key=) inside the handler.
  '/api/webhooks/hubspot',
  // Slack Events API (conversational Resiwalk bot). Slack POSTs with no session
  // cookie; the handler self-enforces the Slack request signature (HMAC v0 +
  // replay window) and answers the url_verification handshake. Must be public or
  // Slack's requests get redirected to /login and never reach the endpoint.
  '/api/slack/events',
  // Insights snapshot rebuild: reached by Vercel Cron (no session cookie) and by
  // admins. Self-enforces CRON_SECRET bearer / app-admin session in the handler.
  '/api/insights/rebuild',
  // Image proxy/resizer. Must be public so the PUBLIC share viewer (/d/...) can
  // render legacy HEIC photos (converted to JPEG) and request small thumbnails.
  // Safe: it is SSRF-guarded to HubSpot file hosts and only ever returns files
  // that are already public (PUBLIC_INDEXABLE) — it exposes nothing new.
  '/api/photo-proxy',
]);

function isStaticAsset(pathname: string): boolean {
  return (
    pathname.startsWith('/_next/') ||
    pathname === '/favicon.ico' ||
    pathname === '/logo.png' ||
    pathname.endsWith('.png') ||
    pathname.endsWith('.jpg') ||
    pathname.endsWith('.svg') ||
    pathname.endsWith('.css') ||
    pathname.endsWith('.js') ||
    pathname.endsWith('.webmanifest')
  );
}

async function verifySession(token: string, secret: Uint8Array): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, secret);
    // Reject typed tokens (e.g. the short-lived `oauth_exchange` token) just like
    // lib/auth.verifySessionToken does — only a real session (no `typ`) gates a
    // page. Defense-in-depth: the exchange token only ever travels as a ?t= param
    // and API data-fetches already reject it, but mirror the check here too.
    if ((payload as { typ?: unknown }).typ) return false;
    return Boolean(payload.userId && payload.email);
  } catch {
    return false;
  }
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Already signed in AND hitting the login page → skip it, go straight to the
  // app. If the session is missing/expired, fall through to the normal login.
  if (pathname === '/login') {
    const token = req.cookies.get('resihome_session')?.value;
    const secret = process.env.SESSION_SECRET;
    if (token && secret && (await verifySession(token, new TextEncoder().encode(secret)))) {
      const url = req.nextUrl.clone();
      url.pathname = '/';
      url.search = '';
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  if (PUBLIC_PATHS.has(pathname) || isStaticAsset(pathname)) {
    return NextResponse.next();
  }

  // Public marketing/legal pages for the "ResiWalk - 1099" Google OAuth app
  // (home, privacy, terms) — must be reachable WITHOUT login for verification.
  if (pathname === '/1099' || pathname.startsWith('/1099/')) {
    return NextResponse.next();
  }

  // Short share-link resolver (/d/...) is public: it only 302-redirects to an
  // already-public HubSpot file URL, and the link itself is HMAC-signed.
  if (pathname.startsWith('/d/')) {
    return NextResponse.next();
  }

  const token = req.cookies.get('resihome_session')?.value;
  if (!token) return redirectToLogin(req);

  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    return new NextResponse(
      'SESSION_SECRET env var is not set. The app cannot verify sessions.',
      { status: 500 }
    );
  }
  const ok = await verifySession(token, new TextEncoder().encode(secret));
  if (!ok) return redirectToLogin(req);

  return NextResponse.next();
}

function redirectToLogin(req: NextRequest): NextResponse {
  if (req.nextUrl.pathname.startsWith('/api/')) {
    // A real fetch() (Accept: */* or application/json) gets the 401 the app's
    // session guard expects. But a BROWSER NAVIGATION to a protected API — e.g.
    // a link opened in the system browser without the app's cookie — should land
    // on /login, not a raw {"error":"Not authenticated"} dead-end page.
    const accept = req.headers.get('accept') || '';
    if (!accept.includes('text/html')) {
      return new NextResponse(JSON.stringify({ error: 'Not authenticated' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
  const intended = req.nextUrl.pathname + req.nextUrl.search;
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  const res = NextResponse.redirect(url);
  // Stash the originally-requested path so the auth callback can return the user
  // there after login (deep-link preservation). Validated here (mirrors
  // lib/auth.isSafeReturnPath) to prevent open-redirect; cookie survives the
  // OAuth/OTP round-trip where a query param would be dropped.
  if (isSafeReturnPath(intended)) {
    res.cookies.set('resihome_return_to', intended, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 600, // 10 minutes — just long enough to complete a sign-in
    });
  }
  return res;
}

// Open-redirect guard — keep in sync with lib/auth.isSafeReturnPath. Only
// same-origin RELATIVE page paths; rejects //host, backslash tricks, /api/* and
// /login, and control chars.
function isSafeReturnPath(p: string): boolean {
  if (!p || p.length > 512) return false;
  if (!p.startsWith('/')) return false;
  if (p.startsWith('//') || p.startsWith('/\\')) return false;
  if (p.startsWith('/login') || p.startsWith('/api/')) return false;
  if (/[\u0000-\u001f]/.test(p)) return false;
  return true;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|logo.png).*)'],
};
