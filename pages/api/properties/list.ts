/**
 * GET /api/properties/list — admin-only Properties list (search + region filter,
 * cursor-paginated). Backs the admin Properties page (pages/properties.tsx).
 *
 * Query: ?search= &regions=GA: Atlanta,TX: Dallas &after=<cursor> &limit=30
 * Returns { properties: AdminPropertyRow[], after: string | null }.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { searchPropertiesAdmin } from '@/lib/hubspot';

const one = (q: string | string[] | undefined): string => (Array.isArray(q) ? q[0] : q) || '';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email || !(await isAppAdmin(session.email).catch(() => false))) {
    return res.status(403).json({ error: 'Admins only' });
  }
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Method not allowed' }); }
  try {
    const search = one(req.query.search).trim();
    const regionsRaw = one(req.query.regions).trim();
    const regions = regionsRaw ? regionsRaw.split(',').map((r) => r.trim()).filter(Boolean) : [];
    const after = one(req.query.after).trim() || undefined;
    const limit = Math.min(Math.max(Number(one(req.query.limit)) || 30, 1), 100);
    const { properties, after: next } = await searchPropertiesAdmin({ search, regions, after, limit });
    return res.status(200).json({ properties, after: next || null });
  } catch (e: any) {
    console.error('GET /api/properties/list failed:', e?.message, e?.detail);
    return res.status(500).json({ error: String(e?.message || e), detail: e?.detail || null });
  }
}
