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
import { fetchVendorAdminList, createVendorCompany, updateVendorCompany, fetchPropertyCoverage } from '@/lib/hubspot';
import { parseRegions, normalizeRegionsString } from '@/lib/vendorRegions';

export const config = { maxDuration: 60 };

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// The coverage scan (region options) is heavy and near-static — cache ~15 min.
let _regionOptsCache: { at: number; regions: string[] } | null = null;
async function regionOptionList(): Promise<string[]> {
  if (_regionOptsCache && Date.now() - _regionOptsCache.at < 15 * 60 * 1000) return _regionOptsCache.regions;
  const coverage = await fetchPropertyCoverage().catch(() => null);
  const regions = (coverage?.regions || []).map((r: any) => (typeof r === 'string' ? r : r.key)).filter(Boolean);
  _regionOptsCache = { at: Date.now(), regions };
  return regions;
}

// Lazy DATA REPAIR: any vendor whose stored regions_serviced isn't in canonical
// form (typo'd city, broken "O :" prefix, colon-joined multi-regions) gets its
// Company record patched to the normalized string. Bounded + fire-and-forget so
// a read never blocks on writes; each repair is permanent, so the set drains.
function repairMalformedRegions(vendors: { id: string; regionsServiced: string }[]): void {
  const broken = vendors
    .filter((v) => v.regionsServiced && normalizeRegionsString(v.regionsServiced) !== v.regionsServiced)
    .slice(0, 15);
  if (!broken.length) return;
  void Promise.allSettled(broken.map((v) =>
    updateVendorCompany(v.id, { regionsServiced: normalizeRegionsString(v.regionsServiced) })
  )).then(() => console.log(`[admin/vendors] repaired regions_serviced on ${broken.length} compan${broken.length === 1 ? 'y' : 'ies'}`));
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.realEmail || session.email).catch(() => false))) {
    return res.status(403).json({ error: 'Admin only.' });
  }

  if (req.method === 'GET') {
    try {
      const force = String(req.query.refresh || '') === '1';
      const [rawVendors, coverageRegions] = await Promise.all([
        fetchVendorAdminList(force),
        regionOptionList(),
      ]);
      // Serve NORMALIZED regions (display + option list are clean even before the
      // background repair lands in HubSpot), and kick the repair for any rows
      // whose stored string differs from canonical.
      repairMalformedRegions(rawVendors);
      const vendors = rawVendors.map((v) => ({ ...v, regionsServiced: normalizeRegionsString(v.regionsServiced) }));
      const optionSet = new Set<string>(coverageRegions.map((r) => parseRegions(r)[0] || r));
      for (const v of vendors) for (const r of parseRegions(v.regionsServiced)) optionSet.add(r);
      const regionOptions = Array.from(optionSet).sort();
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
    const regionsServiced = normalizeRegionsString(String(b.regionsServiced || ''));
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
