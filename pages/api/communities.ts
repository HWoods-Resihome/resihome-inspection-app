// GET /api/communities
//
// Unique list of Community objects (by name) for the Community / Visit
// inspection picker. Internal-only. Short per-instance cache — communities
// change rarely. Fail-open: returns [] if the Community object isn't present.

import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isExternalEmail } from '@/lib/userAccess';
import { listCommunities, type CommunityOption } from '@/lib/hubspot';

let cache: { at: number; data: CommunityOption[] } | null = null;
const TTL_MS = 5 * 60 * 1000;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (isExternalEmail(session.email)) return res.status(403).json({ error: 'Not authorized.' });
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Method not allowed' }); }
  try {
    if (!cache || Date.now() - cache.at > TTL_MS) {
      cache = { at: Date.now(), data: await listCommunities() };
    }
    return res.status(200).json({ ok: true, communities: cache.data });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 200) });
  }
}
