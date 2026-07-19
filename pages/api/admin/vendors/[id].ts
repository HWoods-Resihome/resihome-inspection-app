/**
 * /api/admin/vendors/[id]  (app-admin only)
 *
 *  PATCH { name?, email?, regionsServiced?, eligibleForRecurring?,
 *          afterHoursService?, resiwalkAccess? }
 *        → updates the Company in HubSpot. resiwalkAccess:false = DEACTIVATE
 *          (vendor immediately loses ResiWalk access — pickers + logins re-check
 *          the live list).
 *  DELETE → archives the Company in HubSpot (removed from active records; loses
 *          ResiWalk access).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { updateVendorCompany, archiveVendorCompany, fetchVendorAdminList, type VendorWritePatch } from '@/lib/hubspot';
import { normalizeRegionsString } from '@/lib/vendorRegions';
import { sendVendorWelcomeEmail } from '@/lib/notifications/vendorWelcome';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.realEmail || session.email).catch(() => false))) {
    return res.status(403).json({ error: 'Admin only.' });
  }
  const id = String(req.query.id || '');
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Missing vendor id' });

  if (req.method === 'PATCH') {
    const b = req.body || {};
    const patch: VendorWritePatch = {};
    if (b.name != null) {
      const name = String(b.name).trim();
      if (!name) return res.status(400).json({ error: 'Vendor name cannot be blank.' });
      patch.name = name;
    }
    if (b.email != null) {
      const email = String(b.email).trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid email is required.' });
      patch.email = email;
    }
    if (b.regionsServiced != null) {
      const regions = normalizeRegionsString(String(b.regionsServiced));
      if (!regions) return res.status(400).json({ error: 'At least one region is required.' });
      patch.regionsServiced = regions;
    }
    if (typeof b.eligibleForRecurring === 'boolean') patch.eligibleForRecurring = b.eligibleForRecurring;
    if (typeof b.afterHoursService === 'boolean') patch.afterHoursService = b.afterHoursService;
    if (typeof b.inspectionAccess === 'boolean') patch.inspectionAccess = b.inspectionAccess;
    if (typeof b.resiwalkAccess === 'boolean') patch.resiwalkAccess = b.resiwalkAccess;
    // Dependency rule: only an ACTIVE vendor can be recurring-eligible or hold
    // Inspections access. Deactivating force-clears both (in the same HubSpot
    // patch), so a deactivated vendor can never keep assignment eligibility or a
    // live inspections session claim on next sign-in.
    if (patch.resiwalkAccess === false) {
      patch.eligibleForRecurring = false;
      patch.inspectionAccess = false;
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to update.' });
    try {
      await updateVendorCompany(id, patch);
      return res.status(200).json({ ok: true });
    } catch (e: any) {
      console.error('[admin/vendors] update failed:', e);
      return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
    }
  }

  // POST { action: 'welcome' } → (re)send this vendor's welcome email. Admin-
  // triggered per card — never bulk. Vendor data comes from the live roster;
  // the body's fields are the fallback for a just-created record HubSpot's
  // search index hasn't surfaced yet.
  if (req.method === 'POST') {
    if (String(req.body?.action || '') !== 'welcome') return res.status(400).json({ error: 'Unknown action.' });
    try {
      const list = await fetchVendorAdminList().catch(() => []);
      const row = list.find((v) => v.id === id);
      const name = row?.name || String(req.body?.name || '').trim();
      const email = (row?.email || String(req.body?.email || '')).trim().toLowerCase();
      if (!name || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Vendor name/email not found.' });
      const w = await sendVendorWelcomeEmail({ name, email }, req);
      if (!w.sent) return res.status(502).json({ error: w.error === 'system_email_not_configured' ? 'System email is not configured (SYSTEM_GMAIL_*).' : `Email failed: ${w.error || 'unknown'}` });
      return res.status(200).json({ ok: true });
    } catch (e: any) {
      console.error('[admin/vendors] welcome send failed:', e);
      return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
    }
  }

  if (req.method === 'DELETE') {
    try {
      await archiveVendorCompany(id);
      return res.status(200).json({ ok: true });
    } catch (e: any) {
      console.error('[admin/vendors] delete failed:', e);
      return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
    }
  }

  res.setHeader('Allow', 'PATCH, POST, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
