/**
 * POST /api/auth/vendor-login — email + password sign-in for ResiWalk vendors.
 *
 * A vendor is an approved Company (resiwalk_access = Yes AND
 * eligible_for_recurring = Yes). Two modes:
 *   - First login (no password set): body { email, password, confirm } — the two
 *     must match and meet the policy; we store a salted scrypt hash in the
 *     company's `resiwalk_password` and sign the vendor in.
 *   - Returning login (password set): body { email, password } — verified against
 *     the stored hash.
 * On success mints the standard session cookie with a `vendor` claim, so
 * middleware restricts the account to /services (services-only, own WOs).
 * Pre-session: reachable without a cookie (allowlisted in middleware).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { createSessionCookie, readReturnTo, clearReturnToCookie, isSafeReturnPath, type SessionUser } from '@/lib/auth';
import { findApprovedVendorByEmail, setVendorPasswordHash } from '@/lib/hubspot';
import { hashVendorPassword, verifyVendorPassword, vendorPasswordError } from '@/lib/vendorPassword';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const confirm = String(req.body?.confirm || '');

  const fail = async (msg = 'Invalid email or password.') => {
    await new Promise((r) => setTimeout(r, 500)); // blunt online guessing
    return res.status(401).json({ error: msg });
  };
  if (!email || !password) return fail('Email and password are required.');

  let vendor;
  try { vendor = await findApprovedVendorByEmail(email); }
  catch { return res.status(500).json({ error: 'Sign-in is temporarily unavailable. Please try again.' }); }
  // Same generic failure whether the email is unknown or not approved — don't
  // reveal which companies have access.
  if (!vendor) return fail('This email is not set up for ResiWalk access.');

  if (!vendor.hasPassword) {
    // First-time setup: require the confirmation to match + meet the policy.
    const policyErr = vendorPasswordError(password);
    if (policyErr) return res.status(400).json({ error: policyErr, needsSetup: true });
    if (password !== confirm) return res.status(400).json({ error: 'Passwords do not match.', needsSetup: true });
    try {
      await setVendorPasswordHash(vendor.id, hashVendorPassword(password));
    } catch (e: any) {
      return res.status(500).json({ error: 'Could not save your password. Please try again.' });
    }
  } else {
    // Returning login: verify against the stored hash.
    if (!verifyVendorPassword(password, vendor.passwordHash)) return fail();
  }

  const user: SessionUser = {
    userId: `vendor:${vendor.id}`,
    email: vendor.email,     // the company's notification email = the vendor identity
    name: vendor.name,
    vendor: true,
  };
  const rawReturn = readReturnTo(req);
  // A vendor may only land inside /services.
  const redirect = isSafeReturnPath(rawReturn) && rawReturn.startsWith('/services') ? rawReturn : '/services';
  res.setHeader('Set-Cookie', [await createSessionCookie(user), clearReturnToCookie()]);
  return res.status(200).json({ ok: true, redirect });
}
