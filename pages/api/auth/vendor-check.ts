/**
 * POST /api/auth/vendor-check  — { email } → { approved, hasPassword, name }
 *
 * Pre-session probe for the vendor login UI: is this email an approved ResiWalk
 * vendor (a Company with resiwalk_access = Yes AND eligible_for_recurring = Yes)?
 * If so, does it already have a password set (→ enter it) or not (→ create one)?
 * Reveals nothing sensitive; a generic {approved:false} for anything else.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { findApprovedVendorByEmail } from '@/lib/hubspot';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const vendor = await findApprovedVendorByEmail(email);
    if (!vendor) return res.status(200).json({ approved: false });
    return res.status(200).json({ approved: true, hasPassword: vendor.hasPassword, name: vendor.name });
  } catch (e: any) {
    return res.status(500).json({ error: 'Lookup failed' });
  }
}
