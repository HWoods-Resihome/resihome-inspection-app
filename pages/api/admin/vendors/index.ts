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
import { fetchVendorAdminList, createVendorCompany, updateVendorCompany, fetchPropertyCoverage, fetchRegionEnumOptions, ensureInspectionAccessProp, ensureVendorFlagOptions } from '@/lib/hubspot';
import { parseRegions, normalizeRegionsString } from '@/lib/vendorRegions';
import { sendVendorWelcomeEmail } from '@/lib/notifications/vendorWelcome';
import { readLoginActivity } from '@/lib/loginActivity';

export const config = { maxDuration: 60 };

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Region OPTION list for the multi-select. Two paths:
//  • FAST (never blocks the page): the cached list, or the `region` enum
//    property's option set (a single API call).
//  • FULL (only via ?only=regions, fetched by the client in the background):
//    falls back to the multi-page property coverage scan when region isn't an
//    enum. That scan was what made the page hang on a spinner for 10s+ cold.
let _regionOptsCache: { at: number; regions: string[] } | null = null;
async function regionOptionsFast(): Promise<string[] | null> {
  if (_regionOptsCache && Date.now() - _regionOptsCache.at < 15 * 60 * 1000) return _regionOptsCache.regions;
  const enumOpts = await fetchRegionEnumOptions().catch(() => null);
  if (enumOpts?.length) { _regionOptsCache = { at: Date.now(), regions: enumOpts }; return enumOpts; }
  return null;
}
async function regionOptionsFull(): Promise<string[]> {
  const fast = await regionOptionsFast();
  if (fast) return fast;
  const coverage = await fetchPropertyCoverage().catch(() => null);
  const regions = (coverage?.regions || []).map((r: any) => (typeof r === 'string' ? r : r.key)).filter(Boolean);
  _regionOptsCache = { at: Date.now(), regions };
  return regions;
}

// Field provisioning (Access To Inspections property + missing Yes/No options on
// the enum flags) is idempotent but costs HubSpot round-trips — memoize the
// OUTCOME (success or the error string) for 10 min so repeat page loads don't
// re-pay it, while a fixed scope still gets noticed within minutes.
let _provisionMemo: { at: number; error: string | null } | null = null;
async function ensureProvisioned(): Promise<string | null> {
  if (_provisionMemo && Date.now() - _provisionMemo.at < 10 * 60 * 1000) return _provisionMemo.error;
  const [a, b] = await Promise.allSettled([ensureInspectionAccessProp(), ensureVendorFlagOptions()]);
  const errs: string[] = [];
  if (a.status === 'rejected') errs.push(String((a.reason as any)?.message || a.reason).slice(0, 400));
  if (b.status === 'rejected') errs.push(String((b.reason as any)?.message || b.reason).slice(0, 400));
  const error = errs.length ? errs.join(' · ').slice(0, 600) : null;
  _provisionMemo = { at: Date.now(), error };
  return error;
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
      // Background fill for the option list when the fast path had nothing:
      // the client calls ?only=regions AFTER the page has painted, so the heavy
      // coverage scan never sits between the admin and their vendor list.
      if (String(req.query.only || '') === 'regions') {
        const regions = await regionOptionsFull();
        return res.status(200).json({ regionOptions: regions.map((r) => parseRegions(r)[0] || r).sort() });
      }
      const force = String(req.query.refresh || '') === '1';
      // Everything in flight AT ONCE — the list, the fast region options, and
      // the provisioning checks (which used to run serially after the fetch).
      const provisionP = ensureProvisioned();
      const [rawVendors, fastRegions, activity] = await Promise.all([
        fetchVendorAdminList(force),
        regionOptionsFast(),
        readLoginActivity().catch(() => ({} as Record<string, { lastAt: string }>)),
      ]);
      // Serve NORMALIZED regions (display + option list are clean even before the
      // background repair lands in HubSpot), and kick the repair for any rows
      // whose stored string differs from canonical.
      repairMalformedRegions(rawVendors);
      // Last active = the vendor's most recent sign-in (login activity, keyed by
      // email). Null until they've logged in at least once.
      const vendors = rawVendors.map((v) => ({
        ...v,
        regionsServiced: normalizeRegionsString(v.regionsServiced),
        lastActive: activity[v.email.trim().toLowerCase()]?.lastAt || null,
      }));
      const optionSet = new Set<string>((fastRegions || []).map((r) => parseRegions(r)[0] || r));
      for (const v of vendors) for (const r of parseRegions(v.regionsServiced)) optionSet.add(r);
      const regionOptions = Array.from(optionSet).sort();
      // Provisioning failures never block the list — the reason is returned so
      // the UI can explain why a toggle won't stick.
      const inspectionAccessError = await provisionP;
      return res.status(200).json({
        vendors, regionOptions, inspectionAccessError,
        // No full catalog yet → the client should fetch ?only=regions quietly.
        regionOptionsPending: fastRegions == null,
      });
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
      const eligibleForRecurring = b.eligibleForRecurring !== false;   // default Yes
      const id = await createVendorCompany({
        name, email, regionsServiced,
        eligibleForRecurring,
        afterHoursService: b.afterHoursService === true,
        inspectionAccess: b.inspectionAccess === true,            // default No
      });
      // Welcome email — ONLY for newly created vendors with recurring on (never
      // mass-sent to existing vendors; those get the per-card resend button).
      // Best-effort: a mail failure must not fail the create.
      let welcomeSent = false;
      if (eligibleForRecurring) {
        const w = await sendVendorWelcomeEmail({ name, email }, req).catch(() => ({ sent: false }));
        welcomeSent = w.sent;
      }
      return res.status(200).json({ ok: true, id, welcomeSent });
    } catch (e: any) {
      console.error('[admin/vendors] create failed:', e);
      return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
