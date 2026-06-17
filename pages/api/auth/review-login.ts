/**
 * POST /api/auth/review-login  — App Store / Google Play review sign-in.
 *
 * Apple's (and Google's) app reviewers can't complete our Google OAuth + 2FA, so
 * they need a plain username/password demo login. This endpoint validates a
 * SINGLE designated review account against SERVER env secrets and, on success,
 * mints the exact same session cookie a normal Google login would — bypassing
 * OAuth/2FA for that one account only.
 *
 * Security:
 *   - The password is read from APP_REVIEW_PASSWORD (server env). It is NEVER in
 *     the client bundle. If that env var is unset, this endpoint is DISABLED
 *     (returns 404) — so the review login can be turned off after approval by
 *     clearing the env var.
 *   - Only the configured APP_REVIEW_EMAIL (default apptest@resihome.com) is
 *     accepted; password compared in constant time; failures are generic + delayed.
 *   - The minted session carries the real HubSpot identity for that email when it
 *     exists (so the app behaves normally), else a synthetic review identity.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import { createSessionCookie, type SessionUser } from '@/lib/auth';
import { fetchActiveUsers } from '@/lib/hubspot';

const REVIEW_EMAIL = (process.env.APP_REVIEW_EMAIL || 'apptest@resihome.com').trim().toLowerCase();

// Constant-time string compare (length-safe).
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const expected = process.env.APP_REVIEW_PASSWORD || '';
  // Disabled unless a password is configured — clearing the env var turns the
  // whole review-login path off (404, as if it doesn't exist).
  if (!expected) return res.status(404).json({ error: 'Not available' });

  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  // Generic, delayed failure to blunt online guessing.
  const fail = async () => {
    await new Promise((r) => setTimeout(r, 600));
    return res.status(401).json({ error: 'Invalid credentials' });
  };

  if (email !== REVIEW_EMAIL || !password) return fail();
  if (!safeEqual(password, expected)) return fail();

  // Use the real HubSpot identity for this email when present (so inspector
  // assignment etc. work); otherwise a synthetic review identity so the reviewer
  // can still sign in and navigate even if the user record isn't set up.
  let user: SessionUser = { userId: 'app-review', email: REVIEW_EMAIL, name: 'App Review' };
  try {
    const users = await fetchActiveUsers();
    const match = users.find((u) => u.email.toLowerCase() === REVIEW_EMAIL);
    if (match) user = { userId: match.id, email: match.email, name: match.fullName || match.email };
  } catch { /* HubSpot unavailable — keep synthetic identity */ }

  const cookie = await createSessionCookie(user);
  res.setHeader('Set-Cookie', cookie);
  console.log(`[review-login] App Review account signed in (${user.userId === 'app-review' ? 'synthetic identity' : 'HubSpot user ' + user.userId})`);
  return res.status(200).json({ ok: true });
}
