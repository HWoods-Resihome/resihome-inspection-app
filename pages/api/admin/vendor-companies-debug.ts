/**
 * GET /api/admin/vendor-companies-debug[?email=someone@x.com]  (app-admin only)
 *
 * Diagnose why a vendor company is / isn't recognized. Reports:
 *  - approvedCount + a sample from the live approved-vendor query (both flags Yes),
 *    or the raw HubSpot error if that query fails (e.g. a missing property).
 *  - when ?email= is given: every Company with that `email`, showing the RAW
 *    stored resiwalk_access / eligible_for_recurring values + whether it matched.
 * Admin-gated; errors include HubSpot detail so setup gaps are visible.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { fetchApprovedVendorCompanies } from '@/lib/hubspot';

// Local copy of hubspotFetch access via the exported helpers isn't possible
// (hubspotFetch is private), so we use a tiny direct call through the same base.
async function companiesSearch(body: any): Promise<any> {
  const token = (process.env.HUBSPOT_TOKEN || process.env.HUBSPOT_SANDBOX_TOKEN || '').trim();
  const r = await fetch(`https://api.hubapi.com/crm/v3/objects/companies/search`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  if (!r.ok) throw new Error(`HubSpot ${r.status}: ${text.slice(0, 300)}`);
  return json;
}

const truthy = (v: any) => ['true', 'yes', '1'].includes(String(v ?? '').trim().toLowerCase());

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email || !(await isAppAdmin(session.realEmail || session.email).catch(() => false))) {
    return res.status(403).json({ error: 'Admin only' });
  }
  const email = String(req.query.email || '').trim().toLowerCase();
  const out: any = {};

  // 1) The live approved list (what the app actually uses).
  try {
    const approved = await fetchApprovedVendorCompanies(true);
    out.approvedCount = approved.length;
    out.approvedSample = approved.slice(0, 10).map((v) => ({ name: v.name, email: v.email, hasPassword: v.hasPassword }));
  } catch (e: any) {
    out.approvedError = String(e?.message || e).slice(0, 300);
  }

  // 2) Raw lookup by email (no flag filter) — shows the actual stored values.
  if (email) {
    const props = ['name', 'email', 'resiwalk_access', 'eligible_for_recurring', 'resiwalk_password'];
    for (const attempt of [props, props.filter((p) => p !== 'resiwalk_password')]) {
      try {
        const resp = await companiesSearch({
          limit: 20, properties: attempt,
          filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
        });
        out.byEmail = (resp.results || []).map((r: any) => {
          const p = r.properties || {};
          const matches = truthy(p.resiwalk_access) && truthy(p.eligible_for_recurring) && !!String(p.email || '').trim() && !!String(p.name || '').trim();
          return {
            id: r.id, name: p.name || null, email: p.email || null,
            resiwalk_access: p.resiwalk_access ?? null,
            eligible_for_recurring: p.eligible_for_recurring ?? null,
            resiwalk_password_set: !!String(p.resiwalk_password || '').trim(),
            wouldMatch: matches,
          };
        });
        if (!out.byEmail.length) out.byEmailNote = 'No Company found with that exact `email` value.';
        break;
      } catch (e: any) {
        out.byEmailError = String(e?.message || e).slice(0, 300);
        // retry loop drops resiwalk_password if it was the culprit
      }
    }
  }

  return res.status(200).json(out);
}
