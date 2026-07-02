/**
 * GET /api/admin/cache-status  (admin only)
 *
 * Definitive health check for the cross-instance (Vercel KV / Upstash) cache that
 * fronts /api/inspections. Reports whether the store is wired up (env vars seen),
 * a LIVE round-trip probe (SET + GET from this running function), and the current
 * shared invalidation generation. Use it to confirm the cache is actually live
 * after connecting the store + redeploying — `enabled:true` + `ping.ok:true`
 * means it's working.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { sharedCacheEnabled, sharedCacheBackend, sharedCachePing, getSharedGen } from '@/lib/sharedCache';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.email))) return res.status(403).json({ error: 'Admin only.' });

  const [ping, generation] = await Promise.all([sharedCachePing(), getSharedGen()]);
  return res.status(200).json({
    enabled: sharedCacheEnabled,        // are the KV env vars present in this function?
    backend: sharedCacheBackend(),      // 'vercel-kv' | 'upstash' | 'disabled'
    ping,                               // { ok, latencyMs } — a live SET+GET round trip
    generation,                         // current shared invalidation counter
    hint: sharedCacheEnabled
      ? (ping.ok ? 'Shared cache is LIVE.' : 'Env vars present but the store did not respond — check the token/URL.')
      : 'No KV env vars in this deployment — connect the store and REDEPLOY so functions pick them up.',
  });
}
