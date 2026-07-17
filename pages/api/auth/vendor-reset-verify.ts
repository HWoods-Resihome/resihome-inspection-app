/**
 * POST /api/auth/vendor-reset-verify — { email, code, password, confirm }
 *
 * Completes the vendor forgot-password flow: verifies the emailed one-time code
 * (OTP cookie), then — for an approved vendor only — stores the new password
 * (salted scrypt hash) and signs them in. Pre-session route (allowlisted).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { createSessionCookie, verifyOtp, readOtpToken, clearOtpCookie, readReturnTo, clearReturnToCookie, isSafeReturnPath, type SessionUser } from '@/lib/auth';
import { findApprovedVendorByEmail, setVendorPasswordHash } from '@/lib/hubspot';
import { hashVendorPassword, vendorPasswordError } from '@/lib/vendorPassword';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const email = String(req.body?.email || '').trim().toLowerCase();
  const code = String(req.body?.code || '').trim();
  const password = String(req.body?.password || '');
  const confirm = String(req.body?.confirm || '');
  if (!email || !code) return res.status(400).json({ error: 'Email and code are required.' });

  let vendor;
  try { vendor = await findApprovedVendorByEmail(email); }
  catch { return res.status(500).json({ error: 'Reset is temporarily unavailable. Please try again.' }); }
  if (!vendor) return res.status(401).json({ error: 'This email is not set up for ResiWalk access.' });

  // Verify the emailed code (same OTP machinery as email sign-in).
  const result = await verifyOtp(readOtpToken(req), email, code);
  if (result.status === 'expired') return res.status(401).json({ error: 'That code expired. Request a new one.', expired: true });
  if (result.status === 'locked') return res.status(429).json({ error: 'Too many attempts. Request a new code.', expired: true });
  if (result.status === 'mismatch') { res.setHeader('Set-Cookie', result.reissue); return res.status(401).json({ error: 'Incorrect code. Try again.' }); }

  // Code OK → set the new password.
  const policyErr = vendorPasswordError(password);
  if (policyErr) return res.status(400).json({ error: policyErr });
  if (password !== confirm) return res.status(400).json({ error: 'Passwords do not match.' });
  try { await setVendorPasswordHash(vendor.id, hashVendorPassword(password)); }
  catch { return res.status(500).json({ error: 'Could not save your new password. Please try again.' }); }

  const user: SessionUser = { userId: `vendor:${vendor.id}`, email: vendor.email, name: vendor.name, vendor: true };
  const rawReturn = readReturnTo(req);
  const redirect = isSafeReturnPath(rawReturn) && rawReturn.startsWith('/services') ? rawReturn : '/services';
  res.setHeader('Set-Cookie', [await createSessionCookie(user), clearOtpCookie(), clearReturnToCookie()]);
  return res.status(200).json({ ok: true, redirect });
}
