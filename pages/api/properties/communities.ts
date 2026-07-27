/**
 * POST /api/properties/communities — admin-only. Given a batch of property ids,
 * return { map: { [propertyId]: communityName } } for those with an associated
 * community. Lets the admin Properties page enrich the client-cached full list
 * (which has no community field) with community names as rows come into view.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { communityNamesForProperties } from '@/lib/hubspot';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email || !(await isAppAdmin(session.email).catch(() => false))) {
    return res.status(403).json({ error: 'Admins only' });
  }
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((x: any) => String(x)).filter(Boolean).slice(0, 200) : [];
    if (!ids.length) return res.status(200).json({ map: {} });
    const m = await communityNamesForProperties(ids);
    const map: Record<string, string> = {};
    for (const [k, v] of m) map[k] = v;
    return res.status(200).json({ map });
  } catch (e: any) {
    console.error('POST /api/properties/communities failed:', e?.message, e?.detail);
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
