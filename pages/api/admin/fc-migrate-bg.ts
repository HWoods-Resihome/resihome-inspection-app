/**
 * /api/admin/fc-migrate-bg — server-side (unattended) Final Checklist photo
 * migration: moves restored FC photos HubSpot → Blob and reconnects the records.
 *
 *   GET (no action)                  → current job state (admin) — plain URL
 *   GET/POST ?action=start           → begin the background job (admin) — plain URL OK
 *   GET/POST ?action=stop            → request stop after the current batch (admin)
 *   POST ?action=work&token=<secret> → a worker invocation (secret-gated); chains itself.
 *
 * Runs on the server with no browser open; an every-minute cron watchdog resumes
 * a dead chain. Mirrors reclaim-photos-bg. START is GET-friendly so you can just
 * open the URL — then close the tab and let it run.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { readFcMigrateState, writeFcMigrateState } from '@/lib/hubspot';
import { freshFcMigrateState, kickFcMigrateWorker, runFcMigrateWorker, type FcMigrateState } from '@/lib/fcMigrateJob';

export const config = { maxDuration: 300 };

function originOf(req: NextApiRequest): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return host ? `${proto}://${host}` : '';
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const action = String(req.query.action || (req.method === 'GET' ? 'status' : '')).toLowerCase();
  const secret = (process.env.CRON_SECRET || '').trim();

  if (action === 'work') {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!secret || token !== secret) return res.status(401).json({ error: 'Unauthorized' });
    try { await runFcMigrateWorker(originOf(req), secret); return res.status(200).json({ ok: true }); }
    catch (e: any) { return res.status(500).json({ error: String(e?.message || e).slice(0, 200) }); }
  }

  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email || !(await isAppAdmin(session.realEmail || session.email).catch(() => false))) {
    return res.status(403).json({ error: 'Admin only' });
  }

  if (action === 'status') {
    const st = await readFcMigrateState<FcMigrateState>().catch(() => null);
    return res.status(200).json({ state: st || null });
  }

  if (action === 'stop') {
    const st = await readFcMigrateState<FcMigrateState>().catch(() => null);
    if (st) {
      const active = !!st.heartbeatAt && Date.now() - Date.parse(st.heartbeatAt) < 120_000;
      const alreadyAsked = st.stopRequested === true;
      await writeFcMigrateState(
        active && !alreadyAsked
          ? { ...st, stopRequested: true }
          : { ...st, stopRequested: false, running: false, finishedAt: new Date().toISOString() },
      );
    }
    return res.status(200).json({ ok: true });
  }

  if (action === 'start') {
    if (!secret) return res.status(400).json({ error: 'CRON_SECRET is not set — background jobs are disabled.' });
    const existing = await readFcMigrateState<FcMigrateState>().catch(() => null);
    if (existing?.running && existing.heartbeatAt && Date.now() - Date.parse(existing.heartbeatAt) < 120_000) {
      return res.status(200).json({ ok: true, already: true, state: existing });
    }
    const state = freshFcMigrateState();
    await writeFcMigrateState(state);
    await kickFcMigrateWorker(originOf(req), secret);
    return res.status(200).json({ ok: true, started: true, note: 'Running on the server — close this tab. Check ?action=status for progress.', state });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(400).json({ error: 'Unknown action' });
}
