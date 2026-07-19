/**
 * POST /api/auth/vendor-check  — { email } → { approved, hasPassword, name }
 *
 * Pre-session probe for the vendor login UI: is this email an approved ResiWalk
 * vendor (a Company with resiwalk_access = Yes AND eligible_for_recurring = Yes)?
 * If so, does it already have a password set (→ enter it) or not (→ create one)?
 * Reveals nothing sensitive; a generic {approved:false} for anything else.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { findVendorForAuth } from '@/lib/hubspot';
import { enforceRateLimit } from '@/lib/rateLimit';

function clientIp(req: NextApiRequest): string {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  // Rate-limit so the approved-vendor roster can't be harvested by walking an
  // email list (this probe necessarily reveals whether an email is a vendor).
  if (enforceRateLimit(res, { key: clientIp(req), route: 'vendor-check', max: 30, windowMs: 15 * 60_000 })) return;
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const vendor = await findVendorForAuth(email);
    if (!vendor) return res.status(200).json({ approved: false });
    return res.status(200).json({ approved: true, hasPassword: vendor.hasPassword, name: vendor.name });
  } catch (e: any) {
    return res.status(500).json({ error: 'Lookup failed' });
  }
}
