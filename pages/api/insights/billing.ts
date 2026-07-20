/**
 * GET /api/insights/billing?object=inspections|services&regions=&portfolios=&
 *     inspectors=&from=&to=[&format=xlsx]
 *
 * Insights-access-gated billing report. Default returns { rows, facets, columns }
 * as JSON for the on-page table; ?format=xlsx streams a real Excel file. Filters:
 * region / portfolio / inspector(or vendor) / completed-date range.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { canViewInsights } from '@/lib/insightsAccess';
import { fetchBillingRows, billingColumns, billingFacetsFast, type BillingFilters } from '@/lib/insightsBilling';
import { buildBillingXlsx, billingFilename } from '@/lib/insightsBillingXlsx';
import { fetchPropertyCoverage } from '@/lib/hubspot';

export const config = { maxDuration: 60 };

const arr = (v: unknown): string[] =>
  typeof v === 'string' && v.trim() ? v.split(',').map((s) => s.trim()).filter(Boolean)
    : Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
const day = (v: unknown): string | undefined => {
  const s = String(v || '').trim(); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await canViewInsights(session.realEmail || session.email).catch(() => false))) {
    return res.status(403).json({ error: 'Insights access required.' });
  }
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Method not allowed' }); }

  const object = String(req.query.object || 'inspections') === 'services' ? 'services' : 'inspections';
  const filters: BillingFilters = {
    regions: arr(req.query.regions), portfolios: arr(req.query.portfolios), inspectors: arr(req.query.inspectors),
    types: arr(req.query.types),
    from: day(req.query.from), to: day(req.query.to),
  };
  try {
    const rows = await fetchBillingRows(object, filters);
    if (String(req.query.format || '') === 'xlsx') {
      const buf = await buildBillingXlsx(object, rows);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${billingFilename(object)}"`);
      return res.status(200).send(buf);
    }
    // Facets from the UNFILTERED set so the dropdowns don't collapse as you
    // filter — derived cheaply (no second heavy enrichment pass). Region +
    // Portfolio additionally include the FULL property catalog (excludes sold/
    // not-managed) so an admin can filter on a region/portfolio that has no
    // completed record yet.
    const facets = await billingFacetsFast(object);
    const coverage = await fetchPropertyCoverage().catch(() => null);
    if (coverage) {
      const covRegions = (coverage.regions || []).map((r: any) => (typeof r === 'string' ? r : r.key)).filter(Boolean);
      const covPortfolios = (coverage.portfolios || []).map((p: any) => (typeof p === 'string' ? p : p.key)).filter(Boolean);
      facets.regions = Array.from(new Set([...facets.regions, ...covRegions])).sort((a, b) => a.localeCompare(b));
      facets.portfolios = Array.from(new Set([...facets.portfolios, ...covPortfolios])).sort((a, b) => a.localeCompare(b));
    }
    return res.status(200).json({ object, columns: billingColumns(object), rows, facets, total: rows.length });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
