// Server-side auth helpers. SERVER-ONLY.
//
// Session model: HTTP-only cookie containing a JWT signed with SESSION_SECRET.
// JWT payload: { userId, email, name, exp }.

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { serialize, parse } from 'cookie';
import crypto from 'crypto';
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
    // Set BOTH Max-Age and an explicit Expires: some iOS Safari / standalone-PWA
    // versions drop a Max-Age-only cookie on app close (treating it as a session
    // cookie), which forced inspectors to re-sign-in every time they reopened the
    // app. A concrete Expires date makes it a persistent 30-day cookie everywhere.
    expires: new Date(Date.now() + SESSION_DURATION_HOURS * 60 * 60 * 1000),
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
    // Defense in depth: a real session token carries NO `typ`. Reject anything
    // typed (e.g. the short-lived `oauth_exchange` token) so it can never be
    // replayed as a session cookie — even within its 60s window.
    if (payload.typ) return null;
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
// Email one-time-code (OTP) login — stateless
// ---------------------------------------------------------------------------
// A login fallback for users who can't complete Google/Microsoft OAuth (e.g. a
// Zoho mailbox). After the typed email is validated as an active HubSpot user,
// we email a 6-digit code and stash a SIGNED, HTTP-only cookie that carries a
// HASH of the code (never the code itself) + the email + an attempt counter.
// Verification recomputes the hash from the entered code — so there's NO server
// store to coordinate across serverless instances. Possession of the inbox is
// the second factor.
//
// Hardening: 10-minute TTL, code never stored client-readable (hash only, and
// the cookie is signed so it can't be forged), and a 5-attempt cap enforced by
// re-issuing the cookie with an incremented counter on each wrong guess.

export const OTP_COOKIE_NAME = 'resihome_otp';
const OTP_TYPE = 'otp';
const OTP_TTL_SECONDS = 10 * 60;
const OTP_MAX_ATTEMPTS = 5;

/** Hash a code against the email + server secret (so the cookie never holds the
 *  raw code, and a hash from one email/secret can't verify another). */
function otpHash(email: string, code: string): string {
  const secret = process.env.SESSION_SECRET || '';
  return crypto.createHash('sha256').update(`${email.trim().toLowerCase()}:${code}:${secret}`).digest('hex');
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; }
}

async function signOtpToken(email: string, codeHash: string, attempts: number, expSeconds?: number): Promise<string> {
  const builder = new SignJWT({ typ: OTP_TYPE, email: email.trim().toLowerCase(), ch: codeHash, att: attempts } as JWTPayload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    // jose accepts an absolute epoch-seconds number — used to PRESERVE the
    // original expiry when re-issuing after a wrong guess.
    .setExpirationTime(expSeconds ?? `${OTP_TTL_SECONDS}s`);
  return builder.sign(sessionSecret());
}

function otpCookie(token: string, maxAgeSeconds: number): string {
  return serialize(OTP_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
  });
}

/** Mint the OTP cookie for a freshly-generated code (attempt counter = 0). */
export async function createOtpCookie(email: string, code: string): Promise<string> {
  const token = await signOtpToken(email, otpHash(email, code), 0);
  return otpCookie(token, OTP_TTL_SECONDS);
}

export function clearOtpCookie(): string {
  return serialize(OTP_COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

export function readOtpToken(req: NextApiRequest): string | undefined {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;
  return parse(cookieHeader)[OTP_COOKIE_NAME];
}

export type OtpVerifyResult =
  | { status: 'ok' }
  | { status: 'expired' }               // no/invalid/expired cookie → request a new code
  | { status: 'locked' }                // too many wrong guesses → request a new code
  | { status: 'mismatch'; reissue: string }; // wrong code, retry allowed (re-issued cookie)

/** Verify an entered code against the signed OTP cookie. Stateless. */
export async function verifyOtp(token: string | undefined, email: string, code: string): Promise<OtpVerifyResult> {
  if (!token) return { status: 'expired' };
  let payload: JWTPayload;
  try { ({ payload } = await jwtVerify(token, sessionSecret())); }
  catch { return { status: 'expired' }; }
  if (payload.typ !== OTP_TYPE) return { status: 'expired' };
  if (String(payload.email || '').toLowerCase() !== email.trim().toLowerCase()) return { status: 'expired' };
  const attempts = Number(payload.att || 0);
  if (attempts >= OTP_MAX_ATTEMPTS) return { status: 'locked' };
  const expected = String(payload.ch || '');
  if (expected && timingSafeEqualHex(expected, otpHash(email, code))) return { status: 'ok' };
  // Wrong code → re-issue the cookie with attempts+1, PRESERVING the original
  // expiry so the 10-minute window isn't extended by guessing.
  const exp = Number(payload.exp || 0);
  const remaining = Math.max(1, exp - Math.floor(Date.now() / 1000));
  const reToken = await signOtpToken(email, expected, attempts + 1, exp || undefined);
  return { status: 'mismatch', reissue: otpCookie(reToken, remaining) };
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

export async function createOAuthExchangeToken(user: SessionUser, gmailEnc?: string): Promise<string> {
  const claims: JWTPayload = {
    typ: EXCHANGE_TOKEN_TYPE,
    userId: user.userId,
    email: user.email,
    name: user.name,
  };
  // Optionally carry the Gmail refresh token so the app webview ends up with the
  // SAME gmail cookie the browser flow would set (otherwise the token granted
  // during the system-browser login lands only in the browser's cookie jar and
  // the webview keeps showing "Connect Gmail"). The value passed here is ALREADY
  // AES-encrypted (lib/gmailAuth.encryptToken) — never a raw credential — so even
  // though this JWT is signed-not-encrypted and rides a resiwalk:// deep link,
  // an interceptor can't read the refresh token without the server's key.
  if (gmailEnc) claims.gt = gmailEnc;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${EXCHANGE_TOKEN_TTL_SECONDS}s`)
    .sign(sessionSecret());
}

// Validate an exchange token and return the bound session user, or null.
// Rejects anything that isn't a well-formed, unexpired, correctly-typed
// exchange token (e.g. a session JWT presented here won't have the right typ).
export async function verifyOAuthExchangeToken(
  token: string
): Promise<(SessionUser & { gmailEnc?: string }) | null> {
  try {
    const { payload } = await jwtVerify(token, sessionSecret());
    if (payload.typ !== EXCHANGE_TOKEN_TYPE) return null;
    if (!payload.userId || !payload.email || !payload.name) return null;
    return {
      userId: String(payload.userId),
      email: String(payload.email),
      name: String(payload.name),
      gmailEnc: typeof payload.gt === 'string' ? payload.gt : undefined,
    };
  } catch {
    return null;
  }
}
