import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { fetchPropertiesPage } from '@/lib/hubspot';

/**
 * GET /api/properties/all?after=<cursor>
 *
 * One page of the FULL property list (lean projection) for the device's offline
 * full-list cache (lib/propertyCache → IndexedDB). The client loops on the
 * returned `after` cursor until it's absent. Paginated (not one giant response)
 * so no request can hit the Vercel function timeout, and a sync can resume.
 *
 * Cheap, short-TTL per-page memory cache so many devices doing their daily pull
 * within the same window don't each re-hit HubSpot for identical pages (cold
 * serverless instances simply rebuild — correctness doesn't depend on it).
 */
const PAGE_TTL_MS = 60 * 60 * 1000; // 1h
const pageCache = new Map<string, { at: number; data: { properties: any[]; after?: string } }>();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const after = typeof req.query.after === 'string' ? req.query.after : undefined;
  const cacheKey = after || '__first__';
  try {
    const hit = pageCache.get(cacheKey);
    if (hit && Date.now() - hit.at < PAGE_TTL_MS) {
      return res.status(200).json(hit.data);
    }
    const data = await fetchPropertiesPage({ after, limit: 100 });
    pageCache.set(cacheKey, { at: Date.now(), data });
    // Bound the map (a full pull is ~150 pages; keep a couple of pulls' worth).
    if (pageCache.size > 400) {
      for (const [k, v] of pageCache) { if (Date.now() - v.at >= PAGE_TTL_MS) pageCache.delete(k); }
    }
    return res.status(200).json(data);
  } catch (e: any) {
    console.error('GET /api/properties/all failed:', e?.message, e?.detail);
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
