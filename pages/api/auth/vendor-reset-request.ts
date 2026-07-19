/**
 * POST /api/auth/vendor-reset-request — { email } → email a one-time reset code.
 *
 * Forgot-password for approved ResiWalk vendors ONLY. If the email is an approved
 * Company (resiwalk_access = Yes AND eligible_for_recurring = Yes), a 6-digit code
 * is emailed to the company's `email` and a signed OTP cookie (code HASH only) is
 * set. Completed at /api/auth/vendor-reset-verify. No session minted here.
 * Pre-session route (allowlisted in middleware). Generic OK for non-vendors so it
 * can't be used to probe which companies exist.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import { createOtpCookie } from '@/lib/auth';
import { findVendorForAuth } from '@/lib/hubspot';
import { sendSystemEmail } from '@/lib/gmail';
import { enforceRateLimit } from '@/lib/rateLimit';

export const config = { maxDuration: 30 };

function clientIp(req: NextApiRequest): string {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  if (enforceRateLimit(res, { key: clientIp(req), route: 'vendor-reset', max: 5, windowMs: 15 * 60_000 })) return;

  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email is required' });
  if (enforceRateLimit(res, { key: email, route: 'vendor-reset-email', max: 5, windowMs: 15 * 60_000 })) return;

  let vendor;
  try { vendor = await findVendorForAuth(email); }
  catch { return res.status(500).json({ error: 'Could not send a code right now. Please try again.' }); }
  // Not an approved vendor → generic OK (no enumeration) but send nothing.
  if (!vendor) return res.status(200).json({ ok: true });

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const subject = 'Your ResiWalk Password Reset Code';
  const textBody =
    `Your ResiWalk password reset code is ${code}\n\n` +
    `Enter it on the sign-in screen to set a new password. It expires in 10 minutes.\n\n` +
    `If you didn't request this, you can ignore this email.`;
  const htmlBody =
    `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:8px">` +
    `<p style="font-size:15px;color:#111">Your ResiWalk password reset code is:</p>` +
    `<p style="font-size:34px;font-weight:700;letter-spacing:6px;color:#ff0060;margin:8px 0">${code}</p>` +
    `<p style="font-size:13px;color:#555">Enter it on the sign-in screen to set a new password. It expires in 10 minutes.</p>` +
    `<p style="font-size:12px;color:#999;margin-top:20px">If you didn't request this, you can ignore this email.</p>` +
    `</div>`;

  const sent = await sendSystemEmail({ to: vendor.email, subject, htmlBody, textBody });
  if (!sent.sent) {
    if (sent.error === 'system_email_not_configured') return res.status(503).json({ error: 'Password reset email is not set up yet. Contact your ResiHome admin.' });
    return res.status(502).json({ error: 'Could not send the code right now. Please try again.' });
  }
  res.setHeader('Set-Cookie', await createOtpCookie(vendor.email, code));
  return res.status(200).json({ ok: true });
}
