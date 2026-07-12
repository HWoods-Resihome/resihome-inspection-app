/**
 * GET /api/services/coverage → the rules-engine coverage catalog: real portfolios
 * and per-portfolio regions (with counts) from the Property object, plus the
 * Community name list. Services-gated. Read-only. Falls back to empty lists when
 * the objects aren't resolvable so the UI can still render.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { fetchPropertyCoverage, listServiceCommunities, fetchPropertyStatusOptions } from '@/lib/hubspot';

// The coverage catalog is a full Property scan — slow (a few seconds). It changes
// rarely, so cache the built payload in-process for a few minutes. This is what
// makes the rules page's property counts land fast on repeat visits (the client
// also caches in localStorage; this covers the first visit per warm lambda + all
// concurrent users). A single in-flight scan is shared so a burst of loads on a
// cold cache doesn't fan out into N scans.
type Payload = Record<string, unknown>;
const TTL_MS = 5 * 60 * 1000;
let cached: { at: number; data: Payload } | null = null;
let inflight: Promise<Payload> | null = null;

async function build(): Promise<Payload> {
  const [coverage, communities, statuses] = await Promise.all([
    fetchPropertyCoverage().catch(() => null),
    listServiceCommunities().catch(() => null),
    fetchPropertyStatusOptions().catch(() => []),
  ]);
  return {
    portfolios: coverage?.portfolios || [],
    regionsByPortfolio: coverage?.regionsByPortfolio || {},
    regions: coverage?.regions || [],
    communities: communities || [],
    statuses: statuses || [],
    capped: coverage?.capped || false,
    scanned: coverage?.scanned || 0,
  };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  const ok = await servicesEnabled(session?.email).catch(() => false);
  if (!ok) return res.status(403).json({ error: 'Not available' });

  const fresh = req.query.refresh === '1';
  try {
    if (!fresh && cached && Date.now() - cached.at < TTL_MS) {
      res.setHeader('X-Coverage-Cache', 'hit');
      return res.status(200).json(cached.data);
    }
    if (!inflight) inflight = build().finally(() => { inflight = null; });
    const data = await inflight;
    cached = { at: Date.now(), data };
    res.setHeader('X-Coverage-Cache', fresh ? 'refresh' : 'miss');
    return res.status(200).json(data);
  } catch (e: any) {
    // On error, serve stale cache if we have any rather than failing the page.
    if (cached) { res.setHeader('X-Coverage-Cache', 'stale'); return res.status(200).json(cached.data); }
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
