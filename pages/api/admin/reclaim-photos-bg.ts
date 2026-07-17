/**
 * /api/admin/reclaim-photos-bg — server-side (unattended) HubSpot storage reclaim.
 * Deletes the now-orphaned HubSpot photo originals left after the Files → Blob
 * migration; still-referenced photos are always protected (safe-by-design).
 *
 *   GET (or ?action=status)          → current job state (admin)
 *   POST ?action=start               → begin the background delete job (admin)
 *   POST ?action=stop                → request stop after the current batch (admin)
 *   POST ?action=work&token=<secret> → a worker invocation (secret-gated); chains itself.
 *
 * Runs on the server with no browser open; an every-minute cron watchdog resumes
 * a dead chain. Mirrors migrate-photos-bg.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { readPhotoReclaimState, writePhotoReclaimState } from '@/lib/hubspot';
import { freshReclaimState, kickReclaimWorker, runReclaimWorker, type PhotoReclaimState } from '@/lib/photoReclaimJob';

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
    try { await runReclaimWorker(originOf(req), secret); return res.status(200).json({ ok: true }); }
    catch (e: any) { return res.status(500).json({ error: String(e?.message || e).slice(0, 200) }); }
  }

  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email || !(await isAppAdmin(session.realEmail || session.email).catch(() => false))) {
    return res.status(403).json({ error: 'Admin only' });
  }

  if (action === 'status') {
    const st = await readPhotoReclaimState<PhotoReclaimState>().catch(() => null);
    return res.status(200).json({ state: st || null });
  }

  if (action === 'stop') {
    const st = await readPhotoReclaimState<PhotoReclaimState>().catch(() => null);
    if (st) {
      const active = !!st.heartbeatAt && Date.now() - Date.parse(st.heartbeatAt) < 120_000;
      const alreadyAsked = st.stopRequested === true;
      await writePhotoReclaimState(
        active && !alreadyAsked
          ? { ...st, stopRequested: true }
          : { ...st, stopRequested: false, running: false, finishedAt: new Date().toISOString() },
      );
    }
    return res.status(200).json({ ok: true });
  }

  if (action === 'run') {
    // Reliable admin-gated INLINE runner — runs a short bounded pass (returns
    // well under the 300s cap, no 504), checkpointed per batch. Loop it (or let
    // the detached chain + cron continue between hits) until done.
    if (!secret) return res.status(400).json({ error: 'CRON_SECRET is not set — background jobs are disabled.' });
    let st = await readPhotoReclaimState<PhotoReclaimState>().catch(() => null);
    if (!st || (!st.running && !st.finishedAt)) { st = freshReclaimState(); await writePhotoReclaimState(st); }
    else if (!st.running) { st = freshReclaimState(); await writePhotoReclaimState(st); }   // resume a finished/idle job
    await runReclaimWorker(originOf(req), secret, 45_000);
    const latest = await readPhotoReclaimState<PhotoReclaimState>().catch(() => st);
    return res.status(200).json({ ok: true, state: latest });
  }

  if (action === 'start') {
    if (!secret) return res.status(400).json({ error: 'CRON_SECRET is not set — background jobs are disabled.' });
    const existing = await readPhotoReclaimState<PhotoReclaimState>().catch(() => null);
    if (existing?.running && existing.heartbeatAt && Date.now() - Date.parse(existing.heartbeatAt) < 120_000) {
      return res.status(200).json({ ok: true, already: true, state: existing });
    }
    const state = freshReclaimState();
    await writePhotoReclaimState(state);
    // Kick a DETACHED worker invocation (separate serverless request) that runs
    // the delete batches for its full time budget and chains itself; the
    // every-minute cron watchdog resumes the chain if a link dies. This is the
    // proven migrate-photos-bg pattern — Start returns immediately and the status
    // poll surfaces live progress. It runs unattended (close the tab / overnight).
    await kickReclaimWorker(originOf(req), secret);
    return res.status(200).json({ ok: true, state });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(400).json({ error: 'Unknown action' });
}
