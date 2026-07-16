/**
 * lib/photoReclaimJob.ts — server-driven, unattended HubSpot storage reclaim.
 *
 * Mirrors photoMigrationJob: one admin button starts it, then it runs on the
 * SERVER with no browser open — a worker processes delete batches for a time
 * budget, persists progress, and re-triggers itself; an hourly cron watchdog
 * resumes a dead chain. Deletes ONLY /inspection_photos files that no record
 * references (safe-by-design — see deleteMigratedHubspotPhotosBatch). Idempotent:
 * deleted files never reappear, and still-referenced photos are always protected.
 */
import { deleteMigratedHubspotPhotosBatch, readPhotoReclaimState, writePhotoReclaimState } from '@/lib/hubspot';

export interface PhotoReclaimState {
  running: boolean;
  stopRequested?: boolean;
  cursor: string | null;
  totals: { appPhotos: number; orphaned: number; deleted: number; referencedKept: number; errors: number };
  errorSamples: string[];
  passes: number;        // full list-scroll passes completed (the ~10k cap forces re-scans)
  startedAt: string;
  heartbeatAt: string;
  finishedAt?: string;
  lastError?: string;
}

const nowIso = () => new Date().toISOString();
const staleIso = () => new Date(Date.now() - 100_000).toISOString();
const zero = () => ({ appPhotos: 0, orphaned: 0, deleted: 0, referencedKept: 0, errors: 0 });
const ageMs = (iso?: string) => (iso ? Date.now() - Date.parse(iso) : Infinity);

export function freshReclaimState(): PhotoReclaimState {
  return { running: true, stopRequested: false, cursor: null, totals: zero(), errorSamples: [], passes: 0, startedAt: nowIso(), heartbeatAt: staleIso() };
}

export async function kickReclaimWorker(origin: string, secret: string): Promise<void> {
  if (!origin || !secret) return;
  try {
    await fetch(`${origin}/api/admin/reclaim-photos-bg?action=work&token=${encodeURIComponent(secret)}`, {
      method: 'POST',
      signal: (AbortSignal as any).timeout ? (AbortSignal as any).timeout(3000) : undefined,
    });
  } catch { /* AbortError after ~3s is expected — the worker is already running */ }
}

/**
 * Run delete batches until a time budget is spent, then chain. Single-runner via
 * heartbeat. The file listing caps at ~10k per scroll; when a scroll ends
 * (rep.done) we start a FRESH scroll (cursor=null, passes++) to sweep the rest —
 * deleted files no longer appear, so passes converge. A stall guard (a pass that
 * deletes nothing new) finalizes so it can't loop forever on stuck/errored files.
 */
export async function runReclaimWorker(origin: string, secret: string): Promise<void> {
  const start = Date.now();
  const BUDGET_MS = 230_000;
  const MAX_PASSES = 40;   // 40 × ~10k = 400k files ceiling; a hard backstop
  let st = await readPhotoReclaimState<PhotoReclaimState>().catch(() => null);
  if (!st || !st.running) return;
  if (st.stopRequested) { await writePhotoReclaimState({ ...st, running: false, stopRequested: false, finishedAt: nowIso() }); return; }
  if (ageMs(st.heartbeatAt) < 90_000) return;   // another worker is beating
  st = { ...st, heartbeatAt: nowIso() };
  await writePhotoReclaimState(st);

  let deletedThisScroll = 0;   // deletions since the current scroll started

  while (Date.now() - start < BUDGET_MS) {
    const live = await readPhotoReclaimState<PhotoReclaimState>().catch(() => st);
    if (!live || !live.running) return;
    if (live.stopRequested) { await writePhotoReclaimState({ ...live, running: false, stopRequested: false, finishedAt: nowIso() }); return; }
    st = live;

    let rep;
    try {
      rep = await deleteMigratedHubspotPhotosBatch({ apply: true, after: st.cursor || undefined });
    } catch (e: any) {
      await writePhotoReclaimState({ ...st, heartbeatAt: nowIso(), lastError: String(e?.message || e).slice(0, 200) });
      break;
    }

    const totals = { ...st.totals };
    totals.appPhotos += rep.appPhotos || 0; totals.orphaned += rep.orphaned || 0;
    totals.deleted += rep.deleted || 0; totals.referencedKept += rep.referencedKept || 0; totals.errors += rep.errors || 0;
    deletedThisScroll += rep.deleted || 0;
    const errorSamples = [...(st.errorSamples || [])];
    for (const s of (rep.errorSamples || [])) if (errorSamples.length < 20 && !errorSamples.includes(s)) errorSamples.push(s);

    const latest = await readPhotoReclaimState<PhotoReclaimState>().catch(() => null);
    const stopNow = !!latest && (latest.stopRequested === true || latest.running === false);

    let cursor = rep.after; let running = true; let finishedAt: string | undefined; let passes = st.passes;
    if (rep.done) {
      // This scroll ended (naturally or at the ~10k cap). If it deleted anything,
      // sweep again from the start; deleted files won't reappear so it converges.
      passes += 1;
      if (deletedThisScroll > 0 && passes < MAX_PASSES) { cursor = null; deletedThisScroll = 0; }
      else { running = false; finishedAt = nowIso(); }   // nothing left to delete → done
    }
    if (stopNow) { running = false; finishedAt = finishedAt || nowIso(); }
    st = { ...st, cursor, totals, errorSamples, passes, heartbeatAt: nowIso(), running, stopRequested: false, ...(finishedAt ? { finishedAt } : {}), lastError: undefined };
    await writePhotoReclaimState(st);
    if (!running) return;
  }

  await writePhotoReclaimState({ ...st, heartbeatAt: staleIso() });
  await kickReclaimWorker(origin, secret);
}
