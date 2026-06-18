/**
 * POST /api/auth/otp-request  — send an email sign-in code.
 *
 * Login fallback for users who can't complete Google/Microsoft OAuth (e.g. a
 * Zoho mailbox). Validates the typed email is an ACTIVE HubSpot user, generates
 * a 6-digit code, emails it from the system mailbox, and sets a signed, HTTP-
 * only OTP cookie (see lib/auth: createOtpCookie) that carries only a HASH of
 * the code. The code is completed at /api/auth/otp-verify. No session is minted
 * here. Public route (runs before a session exists) — see middleware.ts.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import { createOtpCookie } from '@/lib/auth';
import { fetchActiveUsers } from '@/lib/hubspot';
import { sendSystemEmail } from '@/lib/gmail';

export const config = { maxDuration: 30 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email is required' });
  }

  // Only active HubSpot users may receive a code (mirrors /api/auth/login).
  let users;
  try {
    users = await fetchActiveUsers();
  } catch (e) {
    console.error('[otp-request] HubSpot user lookup failed:', e);
    return res.status(500).json({ error: 'Could not verify users right now. Please try again.' });
  }
  const match = users.find((u) => u.email.toLowerCase() === email);
  if (!match) return res.status(401).json({ error: 'Email not recognized' });

  // 6-digit code, cryptographically random.
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

  const subject = 'Your ResiWalk Sign-In Code';
  const textBody =
    `Your ResiWalk Sign-In Code is ${code}\n\n` +
    `Enter it on the sign-in screen to continue. It expires in 10 minutes.\n\n` +
    `If you didn't request this, you can ignore this email.`;
  const htmlBody =
    `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:8px">` +
    `<p style="font-size:15px;color:#111">Your ResiWalk Sign-In Code is:</p>` +
    `<p style="font-size:34px;font-weight:700;letter-spacing:6px;color:#ff0060;margin:8px 0">${code}</p>` +
    `<p style="font-size:13px;color:#555">Enter it on the sign-in screen to continue. It expires in 10 minutes.</p>` +
    `<p style="font-size:12px;color:#999;margin-top:20px">If you didn't request this, you can ignore this email.</p>` +
    `</div>`;

  const sent = await sendSystemEmail({ to: match.email, subject, htmlBody, textBody });
  if (!sent.sent) {
    if (sent.error === 'system_email_not_configured') {
      console.error('[otp-request] SYSTEM_GMAIL_REFRESH_TOKEN / SYSTEM_GMAIL_FROM not set');
      return res.status(503).json({ error: 'Email sign-in is not set up yet. Use Google or Microsoft, or contact your administrator.' });
    }
    console.error('[otp-request] send failed:', sent.error);
    return res.status(502).json({ error: 'Could not send the code right now. Please try again.' });
  }

  // Stash the signed OTP cookie (carries the code HASH, not the code).
  res.setHeader('Set-Cookie', await createOtpCookie(match.email, code));
  return res.status(200).json({ ok: true });
}
