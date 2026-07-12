/**
 * GET /api/services/properties?portfolios=a,b&regions=c,d → live Property records
 * within a coverage selection, for the rules-engine 'list' mode drill-down.
 * Services-gated. Read-only. Returns { properties: [{id,address,locality,region,portfolio,status}] }.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { searchPropertiesForCoverage } from '@/lib/hubspot';

const list = (v: unknown): string[] =>
  typeof v === 'string' && v.trim() ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  const ok = await servicesEnabled(session?.email).catch(() => false);
  if (!ok) return res.status(403).json({ error: 'Not available' });

  const portfolios = list(req.query.portfolios);
  const regions = list(req.query.regions);
  if (!portfolios.length) return res.status(200).json({ properties: [] });
  try {
    const properties = await searchPropertiesForCoverage({ portfolios, regions, limit: 2000 });
    return res.status(200).json({ properties });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
