/**
 * POST /api/services/admin/migrate-community-landscaping-costs — one-time backfill.
 *
 * For every COMMUNITY LANDSCAPING (grass cut) rule, compute the cadence's
 * jobs-per-year and back-fill the friendly cost INPUTS from the existing
 * per-service values (which are left unchanged):
 *   monthly_cut_cost            = vendor_cost × jobs/yr ÷ 12   (per-property monthly)
 *   common_area_annual_contract = common_area_cost × jobs/yr   (only if common areas on)
 *
 * Default is a DRY RUN (reports what it would write). Pass { apply: true } to write.
 * Admin-gated. Idempotent — re-running just recomputes the same values.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isAppAdmin } from '@/lib/adminAccess';
import { searchServiceRuleRecords, upsertServiceRuleRecord } from '@/lib/hubspot';
import { jobsPerYear, monthlyFromPerService, annualFromPerService } from '@/lib/services/cadenceJobs';

const parseArr = (s: any): any[] => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const numOrNull = (v: any): number | null => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) ? n : null; };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  const ok = (await servicesEnabled(email).catch(() => false)) && (await isAppAdmin(email).catch(() => false));
  if (!ok) return res.status(403).json({ error: 'Admin only' });

  const apply = (req.body || {}).apply === true || String(req.query.apply || '') === '1';

  try {
    const all = await searchServiceRuleRecords();
    if (all === null) return res.status(200).json({ ok: true, preview: true, reason: 'Service Rule object not configured.' });

    const targets = all.filter(({ props: p }) =>
      String(p.scope) === 'community' && String(p.worktype) === 'landscaping' && String(p.subtype) === 'cut');

    let updated = 0; let skipped = 0; let failed = 0;
    const items: any[] = [];
    for (const { id, props: p } of targets) {
      const jpy = jobsPerYear(parseArr(p.cadences_json), parseArr(p.skip_months_json));
      const vendorCost = numOrNull(p.vendor_cost);
      const commonOn = p.include_common_areas === 'true';
      const commonCost = numOrNull(p.common_area_cost);

      const item: any = { id, name: p.rule_name || 'Rule', jobsPerYear: jpy };
      if (jpy <= 0) { item.action = 'skip'; item.reason = 'no cadence / jobs-per-year is 0'; skipped++; items.push(item); continue; }

      const write: Record<string, any> = {};
      if (vendorCost != null) { write.monthly_cut_cost = monthlyFromPerService(vendorCost, jpy); item.monthly_cut_cost = write.monthly_cut_cost; item.from_vendor_cost = vendorCost; }
      if (commonOn && commonCost != null) { write.common_area_annual_contract = annualFromPerService(commonCost, jpy); item.common_area_annual_contract = write.common_area_annual_contract; item.from_common_area_cost = commonCost; }

      if (!Object.keys(write).length) { item.action = 'skip'; item.reason = 'no vendor_cost / common_area_cost to derive from'; skipped++; items.push(item); continue; }

      if (!apply) { item.action = 'WOULD-UPDATE'; updated++; items.push(item); continue; }
      try {
        await upsertServiceRuleRecord(id, write);   // auto-provisions the new props on first write
        item.action = 'updated'; updated++; items.push(item);
      } catch (e: any) {
        item.action = 'error'; item.error = String(e?.message || e).slice(0, 200); failed++; items.push(item);
      }
    }

    return res.status(200).json({
      ok: true, mode: apply ? 'apply' : 'dry-run',
      communityLandscapingRules: targets.length, updated, skipped, failed, items,
    });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
