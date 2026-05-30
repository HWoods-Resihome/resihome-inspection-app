// Server-side auth helpers. SERVER-ONLY.
//
// Session model: HTTP-only cookie containing a JWT signed with SESSION_SECRET.
// JWT payload: { userId, email, name, exp }.

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { serialize, parse } from 'cookie';
import type { NextApiRequest, NextApiResponse } from 'next';

export const SESSION_COOKIE_NAME = 'resihome_session';
// 30 days. Auth is gated by Google sign-in at login (proves the user controls
// the email); after that the session is good for 30 days without re-doing Google.
const SESSION_DURATION_HOURS = 24 * 30;

export interface SessionUser {
  userId: string;  // HubSpot user ID
  email: string;
  name: string;    // Full name from HubSpot user record
}

function sessionSecret(): Uint8Array {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error('SESSION_SECRET env var is missing or shorter than 32 chars');
  }
  return new TextEncoder().encode(s);
}

export async function createSessionCookie(user: SessionUser): Promise<string> {
  const token = await new SignJWT({
    userId: user.userId,
    email: user.email,
    name: user.name,
  } as JWTPayload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DURATION_HOURS}h`)
    .sign(sessionSecret());

  return serialize(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DURATION_HOURS * 60 * 60,
  });
}

export function clearSessionCookie(): string {
  return serialize(SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

export async function verifySessionToken(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, sessionSecret());
    if (!payload.userId || !payload.email || !payload.name) return null;
    return {
      userId: String(payload.userId),
      email: String(payload.email),
      name: String(payload.name),
    };
  } catch {
    return null;
  }
}

export async function getSessionFromRequest(req: NextApiRequest): Promise<SessionUser | null> {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  const cookies = parse(cookieHeader);
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return null;
  return verifySessionToken(token);
}

export async function requireSession(
  req: NextApiRequest,
  res: NextApiResponse
): Promise<SessionUser | null> {
  const user = await getSessionFromRequest(req);
  if (!user) {
    res.status(401).json({ error: 'Not authenticated' });
    return null;
  }
  return user;
}

// ---------------------------------------------------------------------------
// Native OAuth return — short-lived exchange token
// ---------------------------------------------------------------------------
// Used ONLY by the native (Capacitor) login flow. On Android the system browser
// completes the Google OAuth and the session cookie lands in the BROWSER's
// cookie jar, which the app's webview can't see. To bridge that, the callback
// mints a short-TTL token here, hands it to the app via the `resiwalk://` deep
// link, and the app loads /api/auth/exchange?t=<token> in its OWN webview to set
// the session cookie in the webview jar.
//
// Security properties:
//  - Signed with the SAME SESSION_SECRET via jose HS256 — no new long-lived secret.
//  - DISTINCT token type (`typ: 'oauth_exchange'`) so an exchange token can never
//    be presented as a session cookie (verifySessionToken doesn't check typ, but
//    the exchange token has no session cookie name and a <=60s expiry, and the
//    exchange endpoint re-checks typ before minting a real session).
//  - <=60s TTL: a stolen token is only replayable for under a minute.
//  - Carries only the session claims needed to re-mint the session (userId,
//    email, name) — same data the session itself holds, no privilege escalation.
//
// NOTE ON SINGLE-USE: true single-use would require server-side state (a used-jti
// store / KV). We intentionally do NOT add that infra here. The residual risk is
// a <=60s replay window on an HTTPS-only token that already encodes the same
// identity the user just proved via Google. Documented in mobile/NATIVE_OAUTH_RETURN.md.

const EXCHANGE_TOKEN_TTL_SECONDS = 60;
const EXCHANGE_TOKEN_TYPE = 'oauth_exchange';

export async function createOAuthExchangeToken(user: SessionUser): Promise<string> {
  return new SignJWT({
    typ: EXCHANGE_TOKEN_TYPE,
    userId: user.userId,
    email: user.email,
    name: user.name,
  } as JWTPayload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${EXCHANGE_TOKEN_TTL_SECONDS}s`)
    .sign(sessionSecret());
}

// Validate an exchange token and return the bound session user, or null.
// Rejects anything that isn't a well-formed, unexpired, correctly-typed
// exchange token (e.g. a session JWT presented here won't have the right typ).
export async function verifyOAuthExchangeToken(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, sessionSecret());
    if (payload.typ !== EXCHANGE_TOKEN_TYPE) return null;
    if (!payload.userId || !payload.email || !payload.name) return null;
    return {
      userId: String(payload.userId),
      email: String(payload.email),
      name: String(payload.name),
    };
  } catch {
    return null;
  }
}
