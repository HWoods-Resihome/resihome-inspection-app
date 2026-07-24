/**
 * GET /api/insights/billing?object=inspections|services&regions=&portfolios=&
 *     inspectors=&from=&to=[&format=xlsx]
 *
 * Insights-access-gated billing report. Default returns { rows, facets, columns }
 * as JSON for the on-page table; ?format=xlsx streams a real Excel file. Filters:
 * region / portfolio / inspector(or vendor) / completed-date range.
 *
 * FAST PATH: reads the precomputed billing snapshot (banked every 30 min by
 * /api/insights/rebuild) and filters/sorts/facets IN MEMORY — no live HubSpot, so
 * the table renders effectively instantly. Falls back to a live compute only when
 * the snapshot hasn't been built yet (fresh deploy / before the first cron).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { canViewInsights } from '@/lib/insightsAccess';
import { fetchBillingRows, billingColumns, billingFacetsFast, rowToCells, type BillingFilters, type BillingRow } from '@/lib/insightsBilling';
import { buildBillingXlsx, billingFilename } from '@/lib/insightsBillingXlsx';
import { readBillingSnapshot, filterBillingRows, type BillingFacets } from '@/lib/insightsBillingSnapshot';
import { fetchPropertyCoverage, fetchRegionEnumOptions, fetchPortfolioEnumOptions } from '@/lib/hubspot';

export const config = { maxDuration: 60 };

type Obj = 'inspections' | 'services';

const arr = (v: unknown): string[] =>
  typeof v === 'string' && v.trim() ? v.split(',').map((s) => s.trim()).filter(Boolean)
    : Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
const day = (v: unknown): string | undefined => {
  const s = String(v || '').trim(); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;
};
const byDateThenAddr = (a: BillingRow, b: BillingRow) =>
  b.completedDate.localeCompare(a.completedDate) || a.fullAddress.localeCompare(b.fullAddress);

/** Resolve { rows, facets } for a request — from the banked snapshot when present
 *  (in-memory filter/sort/facets), else a live compute. */
async function resolve(object: Obj, filters: BillingFilters): Promise<{ rows: BillingRow[]; facets: BillingFacets; asOf: string | null }> {
  const snap = await readBillingSnapshot().catch(() => null);
  if (snap) {
    const rows = filterBillingRows(snap[object], filters).sort(byDateThenAddr);
    return { rows, facets: snap.facets[object], asOf: snap.asOf };
  }
  return { ...(await resolveLive(object, filters)), asOf: null };
}

/** Live fallback (snapshot not built yet): rows + facets + dropdown catalog,
 *  computed concurrently so wall time is the slowest, not the sum. */
async function resolveLive(object: Obj, filters: BillingFilters): Promise<{ rows: BillingRow[]; facets: BillingFacets }> {
  const [rows, facets, regionEnum, portfolioEnum] = await Promise.all([
    fetchBillingRows(object, filters),
    billingFacetsFast(object),
    fetchRegionEnumOptions().catch(() => null),
    fetchPortfolioEnumOptions().catch(() => null),
  ]);
  let catRegions = regionEnum;
  let catPortfolios = portfolioEnum;
  if (!catRegions || !catPortfolios) {
    const coverage = await fetchPropertyCoverage().catch(() => null);
    if (coverage) {
      if (!catRegions) catRegions = (coverage.regions || []).map((r: any) => (typeof r === 'string' ? r : r.key)).filter(Boolean);
      if (!catPortfolios) catPortfolios = (coverage.portfolios || []).map((p: any) => (typeof p === 'string' ? p : p.key)).filter(Boolean);
    }
  }
  facets.regions = Array.from(new Set([...facets.regions, ...(catRegions || [])])).sort((a, b) => a.localeCompare(b));
  facets.portfolios = Array.from(new Set([...facets.portfolios, ...(catPortfolios || [])])).sort((a, b) => a.localeCompare(b));
  return { rows, facets };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await canViewInsights(session.realEmail || session.email).catch(() => false))) {
    return res.status(403).json({ error: 'Insights access required.' });
  }
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Method not allowed' }); }

  const object: Obj = String(req.query.object || 'inspections') === 'services' ? 'services' : 'inspections';
  const filters: BillingFilters = {
    regions: arr(req.query.regions), portfolios: arr(req.query.portfolios), inspectors: arr(req.query.inspectors),
    types: arr(req.query.types),
    from: day(req.query.from), to: day(req.query.to),
  };
  try {
    if (String(req.query.format || '') === 'xlsx') {
      // Export the same filtered set — from the snapshot when present, else live.
      const snap = await readBillingSnapshot().catch(() => null);
      const rows = snap ? filterBillingRows(snap[object], filters).sort(byDateThenAddr) : await fetchBillingRows(object, filters);
      const buf = await buildBillingXlsx(object, rows);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${billingFilename(object)}"`);
      return res.status(200).send(buf);
    }
    const { rows, facets, asOf } = await resolve(object, filters);
    // Send pre-formatted CELL ARRAYS (M-D-YY dates, services Due Date, community
    // master_id / property entity_id) so the on-screen table matches the xlsx
    // exactly — both go through rowToCells.
    return res.status(200).json({ object, columns: billingColumns(object), rows: rows.map((r) => rowToCells(r, object)), facets, total: rows.length, asOf });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
