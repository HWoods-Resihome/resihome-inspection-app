import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';

const PUBLIC_PATHS = new Set<string>([
  '/login',
  // PWA install + on-device diagnostics page — reachable without a session.
  '/install',
  '/api/auth/login',
  '/api/auth/logout',
  // Pre-auth Google sign-in: these run before a session exists. The callback
  // does its own verification (login flow needs no session; the legacy connect
  // flow checks the session itself).
  '/api/auth/google-login',
  '/api/auth/gmail/callback',
  // Native OAuth return: validates a short-TTL token and sets the session in the
  // app webview's cookie jar. Must be reachable pre-session, like the callbacks.
  '/api/auth/exchange',
  // Client error telemetry must accept reports even before/without a session
  // (e.g. a crash on the login page) — it stores no sensitive data.
  '/api/telemetry/error',
  // Version check for the update prompt — must work even when the session has
  // gone stale (so we can still tell the inspector to reload).
  '/api/version',
  // Vercel Cron hits this with no session cookie; it enforces its own
  // CRON_SECRET bearer auth inside the handler.
  '/api/cron/sftp-watch',
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
    pathname.endsWith('.js')
  );
}

async function verifySession(token: string, secret: Uint8Array): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, secret);
    return Boolean(payload.userId && payload.email);
  } catch {
    return false;
  }
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

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
    return new NextResponse(JSON.stringify({ error: 'Not authenticated' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|logo.png).*)'],
};
