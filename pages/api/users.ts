import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isExternalEmail } from '@/lib/userAccess';
import { fetchActiveUsers } from '@/lib/hubspot';
import type { HubSpotUser } from '@/lib/types';

/**
 * GET /api/users — the inspector/owner roster for the home filters and the
 * new-inspection assignee dropdown. ACTIVE users only (deactivated/archived
 * HubSpot owners are excluded) so you can't assign an inspection to someone who
 * no longer works here. The roster changes rarely (staff list), so we cache it
 * for 10 minutes with single-flight + serve-stale, instead of hitting HubSpot on
 * every load from every one of ~100 concurrent users.
 * ?refresh=1 forces a fresh fetch after onboarding/offboarding.
 */

let CACHE: { data: HubSpotUser[]; fetchedAt: number } | null = null;
let INFLIGHT: Promise<HubSpotUser[]> | null = null;
const TTL_MS = 10 * 60 * 1000; // 10 minutes

async function load(forceRefresh: boolean): Promise<HubSpotUser[]> {
  if (!INFLIGHT || forceRefresh) {
    INFLIGHT = (async () => {
      try {
        const users = await fetchActiveUsers();
        CACHE = { data: users, fetchedAt: Date.now() };
        return users;
      } finally {
        INFLIGHT = null;
      }
    })();
  }
  return INFLIGHT;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Defense-in-depth: middleware already gates this, but verify the
  // session here too so the route is never reachable unauthenticated
  // even if the middleware matcher changes.
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  // External (1099) users must NOT receive the internal staff/inspector directory
  // (name + email of every user) — that's a ready-made phishing/enumeration list.
  // Mirrors the external gate on /api/templates and /api/communities.
  if (isExternalEmail(session.email)) return res.status(200).json({ users: [] });
  const refresh = String(req.query.refresh || '') === '1';
  const now = Date.now();
  if (CACHE && now - CACHE.fetchedAt < TTL_MS && !refresh) {
    return res.status(200).json({ users: CACHE.data, cached: true });
  }
  try {
    const users = await load(refresh);
    return res.status(200).json({ users });
  } catch (e: any) {
    console.error('GET /api/users failed:', e);
    if (CACHE) return res.status(200).json({ users: CACHE.data, stale: true });
    return res.status(500).json({ error: String(e.message || e) });
  }
}
