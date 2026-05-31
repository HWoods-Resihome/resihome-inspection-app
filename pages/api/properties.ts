import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { fetchProperties } from '@/lib/hubspot';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Defense-in-depth: middleware already gates this, but verify the
  // session here too so the route is never reachable unauthenticated
  // even if the middleware matcher changes.
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const q = req.query.q;
    const search = Array.isArray(q) ? q[0] : q;
    const properties = await fetchProperties({ search });
    return res.status(200).json({ properties });
  } catch (e: any) {
    // Surface HubSpot's actual rejection reason (attached as `.detail` by
    // hubspotFetch). This is an authenticated internal tool, and the message
    // is what we need to diagnose a 400 — e.g. an unknown property in a filter,
    // or a bad object type id. It renders under the picker via propertiesError.
    console.error('GET /api/properties failed:', e?.message, e?.detail);
    const detail = e?.detail ? ` — ${e.detail}` : '';
    return res.status(500).json({ error: `${String(e.message || e)}${detail}`, detail: e?.detail });
  }
}
