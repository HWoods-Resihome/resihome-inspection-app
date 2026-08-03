/**
 * POST /api/services/admin/migrate-community-nov-weekly — one-click cadence fix.
 *
 * For every COMMUNITY LANDSCAPING (grass cut) rule (active AND paused), move
 * NOVEMBER into the 7-day (weekly) cadence and re-base the CONTRACT math on the
 * new jobs-per-year — while keeping the per-service cost CONSTANT:
 *   1. Move November (month 10) into the weekly cadence, out of every other one.
 *   2. Recompute jobs/year (e.g. 47 → 48).
 *   3. Keep vendor_cost (per-cut) and common_area_cost (per-service) EXACTLY as
 *      they are, and recompute the friendly INPUTS from them × the NEW jobs/year:
 *        monthly_cut_cost            = vendor_cost × jobs/yr ÷ 12
 *        common_area_annual_contract = common_area_cost × jobs/yr
 *   So the contract total / monthly cost now reflect 48 jobs, and the per-service
 *   price the crew is paid is unchanged.
 *
 * Note: existing OPEN orders keep the price they were generated with (dispatched
 * work isn't re-priced) — only future generated orders use the (unchanged) rate.
 *
 * Default is a DRY RUN. Pass { apply: true } to write. Admin-gated. Idempotent —
 * once November is weekly, a re-run reports "already weekly" and changes nothing.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isAppAdmin } from '@/lib/adminAccess';
import { searchServiceRuleRecords, upsertServiceRuleRecord } from '@/lib/hubspot';
import { jobsPerYear, monthlyFromPerService, annualFromPerService } from '@/lib/services/cadenceJobs';

const NOV = 10; // month index (Jan = 0)
const parseArr = (s: any): any[] => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const numOrNull = (v: any): number | null => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) ? n : null; };
// Days a cadence steps by (monthly → -1 so it's never picked as the "weekly" one).
const intervalDays = (c: any): number => {
  const u = String(c?.unit);
  if (u === 'months') return -1;
  const n = Number(c?.interval) || 0;
  return u === 'weeks' ? n * 7 : n;
};

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

    let updated = 0; let skipped = 0; let failed = 0; let persisted = 0;
    const items: any[] = [];

    for (const { id, props: p } of targets) {
      const cads = parseArr(p.cadences_json);
      const skip = parseArr(p.skip_months_json);
      const item: any = { id, name: p.rule_name || 'Rule' };

      const weeklyIdx = cads.findIndex((c) => intervalDays(c) === 7);
      if (weeklyIdx < 0) { item.action = 'skip'; item.reason = 'no 7-day (weekly) cadence to move November into'; skipped++; items.push(item); continue; }
      const monthsOf = (c: any): number[] => (Array.isArray(c?.months) ? c.months.map(Number) : []);
      const novAlreadyWeekly = monthsOf(cads[weeklyIdx]).includes(NOV);
      const novElsewhere = cads.some((c, i) => i !== weeklyIdx && monthsOf(c).includes(NOV));
      if (novAlreadyWeekly && !novElsewhere) { item.action = 'skip'; item.reason = 'November is already on the weekly cadence'; skipped++; items.push(item); continue; }

      const oldJpy = jobsPerYear(cads, skip);
      // Move November: add to the weekly cadence, remove from every other one.
      const newCads = cads.map((c, i) => {
        const months = monthsOf(c);
        if (i === weeklyIdx) return { ...c, months: Array.from(new Set([...months, NOV])).sort((a, b) => a - b) };
        return { ...c, months: months.filter((m) => m !== NOV) };
      });
      const newJpy = jobsPerYear(newCads, skip);
      item.oldJobsPerYear = oldJpy; item.newJobsPerYear = newJpy;

      // Keep the per-service cost CONSTANT (vendor_cost / common_area_cost are NOT
      // rewritten). Re-base the friendly INPUTS on that constant per-service × the
      // NEW jobs/year — so the monthly cost / annual contract now reflect 48 jobs.
      const vendorCost = numOrNull(p.vendor_cost);
      const commonCost = numOrNull(p.common_area_cost);
      const commonOn = p.include_common_areas === 'true';

      const write: Record<string, any> = { cadences_json: JSON.stringify(newCads) };
      if (vendorCost != null) {
        write.monthly_cut_cost = monthlyFromPerService(vendorCost, newJpy);   // per-cut × jobs/yr ÷ 12
        item.per_cut_constant = vendorCost; item.monthly_cut_cost = write.monthly_cut_cost;
      }
      if (commonOn && commonCost != null) {
        write.common_area_annual_contract = annualFromPerService(commonCost, newJpy);   // per-service × jobs/yr
        item.per_service_constant = commonCost; item.common_area_annual_contract = write.common_area_annual_contract;
      }

      if (!apply) { item.action = 'WOULD-UPDATE'; updated++; items.push(item); continue; }
      try {
        await upsertServiceRuleRecord(id, write);
        item.action = 'updated'; updated++; items.push(item);
      } catch (e: any) {
        item.action = 'error'; item.error = String(e?.message || e).slice(0, 200); failed++; items.push(item);
      }
    }

    // Verify writes stuck (cadence + recomputed cost), so a silent drop is visible.
    if (apply && updated > 0) {
      const after = await searchServiceRuleRecords().catch(() => null);
      if (after) {
        const byId = new Map(after.map((r) => [r.id, r.props]));
        for (const it of items) {
          if (it.action !== 'updated') continue;
          const pp: any = byId.get(it.id) || {};
          const novWeekly = parseArr(pp.cadences_json).some((c) => intervalDays(c) === 7 && (Array.isArray(c.months) ? c.months.map(Number) : []).includes(NOV));
          it.persisted = novWeekly;
          if (novWeekly) persisted++;
        }
      }
    }

    return res.status(200).json({
      ok: true, mode: apply ? 'apply' : 'dry-run',
      communityLandscapingRules: targets.length, updated, skipped, failed, persisted,
      provisionWarning: apply && updated > 0 && persisted < updated
        ? 'Some rules did NOT persist the change — check the Service Rule object is provisioned and re-run.'
        : undefined,
      items,
    });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
