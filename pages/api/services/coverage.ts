/**
 * GET /api/services/coverage → the rules-engine coverage catalog: real portfolios
 * and per-portfolio regions (with counts) from the Property object, plus the
 * Community name list. Services-gated. Read-only. Falls back to empty lists when
 * the objects aren't resolvable so the UI can still render.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { fetchPropertyCoverage, listCommunities } from '@/lib/hubspot';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  const ok = await servicesEnabled(session?.email).catch(() => false);
  if (!ok) return res.status(403).json({ error: 'Not available' });

  try {
    const [coverage, communities] = await Promise.all([
      fetchPropertyCoverage().catch(() => null),
      listCommunities().catch(() => null),
    ]);
    return res.status(200).json({
      portfolios: coverage?.portfolios || [],
      regionsByPortfolio: coverage?.regionsByPortfolio || {},
      regions: coverage?.regions || [],
      communities: communities || [],
      capped: coverage?.capped || false,
      scanned: coverage?.scanned || 0,
    });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
