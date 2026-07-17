/**
 * GET /api/cron/fc-migrate-worker — watchdog for the background FC-photo-migration
 * job. Resumes the self-chaining worker if its heartbeat went stale, and finalizes
 * a wedged "stopping" job. No-op otherwise. Vercel attaches Authorization: Bearer
 * $CRON_SECRET. Mirrors reclaim-photos-worker.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { readFcMigrateState, writeFcMigrateState } from '@/lib/hubspot';
import { kickFcMigrateWorker, type FcMigrateState } from '@/lib/fcMigrateJob';

export const config = { maxDuration: 30 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = (process.env.CRON_SECRET || '').trim();
  if (!secret) return res.status(503).json({ error: 'CRON_SECRET not configured.' });
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : (typeof req.query.key === 'string' ? req.query.key : '');
  if (provided !== secret) return res.status(401).json({ error: 'Unauthorized' });

  const st = await readFcMigrateState<FcMigrateState>().catch(() => null);
  if (!st || !st.running) return res.status(200).json({ resumed: false, reason: 'not running' });

  const stale = !st.heartbeatAt || Date.now() - Date.parse(st.heartbeatAt) > 120_000;
  if (st.stopRequested) {
    if (stale) {
      await writeFcMigrateState({ ...st, stopRequested: false, running: false, finishedAt: new Date().toISOString() });
      return res.status(200).json({ resumed: false, reason: 'stop finalized' });
    }
    return res.status(200).json({ resumed: false, reason: 'stopping' });
  }
  if (!stale) return res.status(200).json({ resumed: false, reason: 'worker active' });

  const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const origin = host ? `${proto}://${host}` : '';
  await kickFcMigrateWorker(origin, secret);
  return res.status(200).json({ resumed: true });
}
