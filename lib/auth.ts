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
