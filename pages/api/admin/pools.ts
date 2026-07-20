/**
 * /api/admin/pools  (app-admin only)
 *
 *  GET   → { pools } — every Property with pool_fee > 0 (address/city/st/zip,
 *          region, status, pool fee, and the pool_servicer field).
 *  PATCH { id, poolServicer: 'ResiHome' | 'Tenant Service' } → set the servicer.
 *          Marking a pool "Tenant Service" excludes it from new pool work
 *          orders WHILE the home is Tenant Leased; it's auto-flipped back to
 *          ResiHome once it leaves that status (services-generate cron).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { fetchPoolProperties, setPoolServicer, setPoolServicerNote, isTenantServicedPool, POOL_SERVICER_RESIHOME, POOL_SERVICER_TENANT } from '@/lib/hubspot';

export const config = { maxDuration: 60 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.realEmail || session.email).catch(() => false))) {
    return res.status(403).json({ error: 'Admin only.' });
  }

  if (req.method === 'GET') {
    try {
      const force = String(req.query.refresh || '') === '1';
      const raw = await fetchPoolProperties(force);
      // Attach the SERVER-side classification so the UI groups exactly how
      // generation excludes (tolerant "tenant"/"resident" match).
      const pools = raw.map((p) => ({ ...p, isTenant: isTenantServicedPool(p.poolServicer) }));
      return res.status(200).json({ pools, servicers: { resihome: POOL_SERVICER_RESIHOME, tenant: POOL_SERVICER_TENANT } });
    } catch (e: any) {
      return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
    }
  }

  if (req.method === 'PATCH') {
    const b = req.body || {};
    const id = String(b.id || '').trim();
    if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'A valid property id is required.' });
    const hasServicer = b.poolServicer != null;
    const hasNote = b.note !== undefined;
    if (!hasServicer && !hasNote) return res.status(400).json({ error: 'Nothing to update.' });
    try {
      if (hasServicer) {
        const val = String(b.poolServicer).trim();
        if (val !== POOL_SERVICER_RESIHOME && val !== POOL_SERVICER_TENANT) {
          return res.status(400).json({ error: `poolServicer must be "${POOL_SERVICER_RESIHOME}" or "${POOL_SERVICER_TENANT}".` });
        }
        // Servicer + note in ONE HubSpot write (ResiHome clears the note).
        await setPoolServicer(id, val, hasNote ? String(b.note || '') : undefined);
      } else if (hasNote) {
        await setPoolServicerNote(id, String(b.note || ''));
      }
      return res.status(200).json({ ok: true });
    } catch (e: any) {
      return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
    }
  }

  res.setHeader('Allow', 'GET, PATCH');
  return res.status(405).json({ error: 'Method not allowed' });
}
