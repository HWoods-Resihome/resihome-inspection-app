/**
 * GET /api/cron/sftp-watch — background sweep of the SFTP watch queue.
 *
 * Scheduled by Vercel Cron (see vercel.json, every minute). Vercel attaches
 * `Authorization: Bearer $CRON_SECRET` automatically when CRON_SECRET is set, so
 * we require it. Each run checks every in-flight Tenant Chargeback upload for a
 * processed/errored result and replies-with-the-error-file on failure.
 *
 * Runs silently — there are no user-facing alerts anywhere in this path.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { runSftpWatchSweep } from '@/lib/sftpWatch';

export const config = { maxDuration: 60 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Also accept
  // `?key=` for manual/local triggering. If CRON_SECRET isn't set, refuse
  // (so the endpoint can't be hit anonymously in production).
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return res.status(503).json({ error: 'CRON_SECRET not configured.' });
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : (typeof req.query.key === 'string' ? req.query.key : '');
  if (provided !== secret) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const summary = await runSftpWatchSweep();
    return res.status(200).json({ ok: true, ...summary });
  } catch (e: any) {
    console.error('[cron/sftp-watch] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
