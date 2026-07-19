/**
 * /api/admin/vendors  (app-admin only)
 *
 *  GET  → { vendors, regionOptions }  — every Company with ResiWalk access (full
 *         admin fields) + the region option list for the multi-select (the same
 *         "GA: Atlanta"-style region set the rest of the app uses).
 *  POST { name, email, regionsServiced, eligibleForRecurring?, afterHoursService? }
 *       → creates the Company in HubSpot with resiwalk_access = Yes. Name, email,
 *         and regions are REQUIRED. Returns { id }.
 *
 * Writes go straight to HubSpot and bust the approved-vendors cache, so pickers
 * and vendor logins re-read live.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { fetchVendorAdminList, createVendorCompany, fetchPropertyCoverage } from '@/lib/hubspot';

export const config = { maxDuration: 60 };

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.realEmail || session.email).catch(() => false))) {
    return res.status(403).json({ error: 'Admin only.' });
  }

  if (req.method === 'GET') {
    try {
      const [vendors, coverage] = await Promise.all([
        fetchVendorAdminList(),
        fetchPropertyCoverage().catch(() => null),
      ]);
      const regionOptions = (coverage?.regions || []).map((r: any) => (typeof r === 'string' ? r : r.key)).filter(Boolean);
      return res.status(200).json({ vendors, regionOptions });
    } catch (e: any) {
      console.error('[admin/vendors] list failed:', e);
      return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
    }
  }

  if (req.method === 'POST') {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const email = String(b.email || '').trim().toLowerCase();
    const regionsServiced = String(b.regionsServiced || '').trim();
    if (!name) return res.status(400).json({ error: 'Vendor name is required.' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid email is required.' });
    if (!regionsServiced) return res.status(400).json({ error: 'At least one region is required.' });
    try {
      // No duplicate vendors: same email = same login identity.
      const existing = await fetchVendorAdminList();
      if (existing.some((v) => v.email.toLowerCase() === email)) {
        return res.status(409).json({ error: 'A vendor with this email already has ResiWalk access.' });
      }
      const id = await createVendorCompany({
        name, email, regionsServiced,
        eligibleForRecurring: b.eligibleForRecurring !== false,   // default Yes
        afterHoursService: b.afterHoursService === true,
      });
      return res.status(200).json({ ok: true, id });
    } catch (e: any) {
      console.error('[admin/vendors] create failed:', e);
      return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
