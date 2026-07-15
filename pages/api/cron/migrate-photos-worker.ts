/**
 * GET /api/cron/migrate-photos-worker — watchdog for the background photo
 * migration. If the job is marked running but its heartbeat has gone stale (the
 * self-chaining link died), re-kick a worker so it resumes. No-op otherwise.
 * Vercel attaches Authorization: Bearer $CRON_SECRET; we require it.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { readPhotoMigrationState } from '@/lib/hubspot';
import { kickWorker, type PhotoMigrationState } from '@/lib/photoMigrationJob';

export const config = { maxDuration: 30 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = (process.env.CRON_SECRET || '').trim();
  if (!secret) return res.status(503).json({ error: 'CRON_SECRET not configured.' });
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : (typeof req.query.key === 'string' ? req.query.key : '');
  if (provided !== secret) return res.status(401).json({ error: 'Unauthorized' });

  const st = await readPhotoMigrationState<PhotoMigrationState>().catch(() => null);
  if (!st || !st.running || st.stopRequested) return res.status(200).json({ resumed: false, reason: 'not running' });
  const stale = !st.heartbeatAt || Date.now() - Date.parse(st.heartbeatAt) > 5 * 60_000;
  if (!stale) return res.status(200).json({ resumed: false, reason: 'worker active' });

  const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const origin = host ? `${proto}://${host}` : '';
  kickWorker(origin, secret);
  return res.status(200).json({ resumed: true });
}
