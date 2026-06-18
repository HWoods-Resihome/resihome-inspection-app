/**
 * POST /api/auth/otp-verify  — complete the email sign-in code.
 *
 * Reads the signed OTP cookie set by /api/auth/otp-request, checks the entered
 * 6-digit code against it (stateless — see lib/auth.verifyOtp), and on success
 * mints the SAME session cookie a Google/Microsoft login would, carrying the
 * real HubSpot identity for that email. Public route — see middleware.ts.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { verifyOtp, readOtpToken, clearOtpCookie, createSessionCookie, readReturnTo, clearReturnToCookie, type SessionUser } from '@/lib/auth';
import { fetchActiveUsers } from '@/lib/hubspot';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const email = String(req.body?.email || '').trim().toLowerCase();
  const code = String(req.body?.code || '').trim();
  if (!email || !/^\d{4,8}$/.test(code)) {
    return res.status(400).json({ error: 'Enter the code from your email.' });
  }

  const result = await verifyOtp(readOtpToken(req), email, code);

  if (result.status === 'expired') {
    res.setHeader('Set-Cookie', clearOtpCookie());
    return res.status(401).json({ error: 'That code has expired. Request a new one.' });
  }
  if (result.status === 'locked') {
    res.setHeader('Set-Cookie', clearOtpCookie());
    return res.status(429).json({ error: 'Too many attempts. Request a new code.' });
  }
  if (result.status === 'mismatch') {
    // Re-issued cookie carries the incremented attempt counter.
    res.setHeader('Set-Cookie', result.reissue);
    return res.status(401).json({ error: 'Incorrect code. Please try again.' });
  }

  // Success → mint the session with the real HubSpot identity for this email.
  let user: SessionUser | null = null;
  try {
    const users = await fetchActiveUsers();
    const match = users.find((u) => u.email.toLowerCase() === email);
    if (match) user = { userId: match.id, email: match.email, name: match.fullName || match.email };
  } catch (e) {
    console.error('[otp-verify] HubSpot identity lookup failed:', e);
  }
  // The code only validates because otp-request already confirmed an active
  // HubSpot user, but guard anyway in case the user was deactivated meanwhile.
  if (!user) {
    res.setHeader('Set-Cookie', clearOtpCookie());
    return res.status(401).json({ error: 'Account not found. Contact your administrator.' });
  }

  const redirect = readReturnTo(req); // capture before clearing
  res.setHeader('Set-Cookie', [await createSessionCookie(user), clearOtpCookie(), clearReturnToCookie()]);
  return res.status(200).json({ ok: true, redirect });
}
