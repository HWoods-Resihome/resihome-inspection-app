/**
 * /api/admin/migrate-photos-bg — server-side (unattended) photo migration.
 *
 *   GET (or ?action=status)          → current job state (admin)
 *   POST ?action=start               → begin the background job (admin)
 *   POST ?action=stop                → request stop after the current batch (admin)
 *   POST ?action=work&token=<secret> → a worker invocation (secret-gated); runs
 *                                      batches then chains the next itself.
 *
 * Once started it runs on the server with NO browser open — each worker chains
 * the next, and an hourly cron watchdog resumes it if a link dies.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { readPhotoMigrationState, writePhotoMigrationState } from '@/lib/hubspot';
import { freshState, kickWorker, runMigrationWorker, type PhotoMigrationState } from '@/lib/photoMigrationJob';

export const config = { maxDuration: 300 };

function originOf(req: NextApiRequest): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return host ? `${proto}://${host}` : '';
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const action = String(req.query.action || (req.method === 'GET' ? 'status' : '')).toLowerCase();
  const secret = (process.env.CRON_SECRET || '').trim();

  // The worker is machine-to-machine → gate on the shared secret. Everything
  // else is an admin action → gate on the admin session.
  if (action === 'work') {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!secret || token !== secret) return res.status(401).json({ error: 'Unauthorized' });
    try { await runMigrationWorker(originOf(req), secret); return res.status(200).json({ ok: true }); }
    catch (e: any) { return res.status(500).json({ error: String(e?.message || e).slice(0, 200) }); }
  }

  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email || !(await isAppAdmin(session.realEmail || session.email).catch(() => false))) {
    return res.status(403).json({ error: 'Admin only' });
  }

  if (action === 'status') {
    const st = await readPhotoMigrationState<PhotoMigrationState>().catch(() => null);
    return res.status(200).json({ state: st || null });
  }

  if (action === 'stop') {
    const st = await readPhotoMigrationState<PhotoMigrationState>().catch(() => null);
    if (st) await writePhotoMigrationState({ ...st, stopRequested: true });
    return res.status(200).json({ ok: true });
  }

  if (action === 'start') {
    if (!secret) return res.status(400).json({ error: 'CRON_SECRET is not set — background jobs are disabled.' });
    const existing = await readPhotoMigrationState<PhotoMigrationState>().catch(() => null);
    // Already actively running (fresh heartbeat) → don't start a second chain.
    if (existing?.running && existing.heartbeatAt && Date.now() - Date.parse(existing.heartbeatAt) < 120_000) {
      return res.status(200).json({ ok: true, already: true, state: existing });
    }
    const state = freshState();
    await writePhotoMigrationState(state);
    kickWorker(originOf(req), secret);
    return res.status(200).json({ ok: true, state });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(400).json({ error: 'Unknown action' });
}
