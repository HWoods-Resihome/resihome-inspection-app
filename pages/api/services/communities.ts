/**
 * GET /api/services/communities → live Community name list (id, name, units) for
 * the create-service community picker. Services-gated. Read-only. Stays current
 * as communities are added in HubSpot (no cache).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { listServiceCommunities } from '@/lib/hubspot';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  const ok = await servicesEnabled(session?.email).catch(() => false);
  if (!ok) return res.status(403).json({ error: 'Not available' });
  try {
    const communities = await listServiceCommunities();
    return res.status(200).json({ communities: communities || [] });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
