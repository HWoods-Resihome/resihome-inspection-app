/**
 * lib/fcMigrateJob.ts — server-driven, unattended Final Checklist photo
 * migration (HubSpot → Vercel Blob + reconnect). Mirrors photoReclaimJob: one
 * admin URL starts it, then it runs on the SERVER with no browser open — a worker
 * processes migrate batches for a time budget, persists progress, re-triggers
 * itself, and an every-minute cron watchdog resumes a dead chain. Idempotent:
 * already-on-Blob FC photos are skipped; still-404 (not-yet-restored) ones are
 * counted skippedDead and picked up on a later pass.
 */
import { migrateFinalChecklistPhotosBatch, readFcMigrateState, writeFcMigrateState } from '@/lib/hubspot';

export interface FcMigrateState {
  running: boolean;
  stopRequested?: boolean;
  cursor: string | null;
  totals: { fcRecords: number; hubspotSeen: number; copied: number; verified: number; recordsUpdated: number; skippedDead: number; errors: number };
  errorSamples: string[];
  passes: number;
  startedAt: string;
  heartbeatAt: string;
  finishedAt?: string;
  lastError?: string;
}

const nowIso = () => new Date().toISOString();
const staleIso = () => new Date(Date.now() - 100_000).toISOString();
const zero = () => ({ fcRecords: 0, hubspotSeen: 0, copied: 0, verified: 0, recordsUpdated: 0, skippedDead: 0, errors: 0 });
const ageMs = (iso?: string) => (iso ? Date.now() - Date.parse(iso) : Infinity);

export function freshFcMigrateState(): FcMigrateState {
  return { running: true, stopRequested: false, cursor: null, totals: zero(), errorSamples: [], passes: 0, startedAt: nowIso(), heartbeatAt: staleIso() };
}

export async function kickFcMigrateWorker(origin: string, secret: string): Promise<void> {
  if (!origin || !secret) return;
  try {
    await fetch(`${origin}/api/admin/fc-migrate-bg?action=work&token=${encodeURIComponent(secret)}`, {
      method: 'POST',
      signal: (AbortSignal as any).timeout ? (AbortSignal as any).timeout(3000) : undefined,
    });
  } catch { /* AbortError after ~3s is expected — the worker is already running */ }
}

/**
 * Run migrate batches until a time budget is spent, then chain. Single-runner via
 * heartbeat. When a scroll of fc__all records ends (done), if any photos were
 * copied this pass we start a fresh scroll (skippedDead ones may since have been
 * restored); a pass that copies nothing new finalizes.
 */
export async function runFcMigrateWorker(origin: string, secret: string, budgetMs = 230_000): Promise<void> {
  const start = Date.now();
  const MAX_PASSES = 30;
  let st = await readFcMigrateState<FcMigrateState>().catch(() => null);
  if (!st || !st.running) return;
  if (st.stopRequested) { await writeFcMigrateState({ ...st, running: false, stopRequested: false, finishedAt: nowIso() }); return; }
  if (ageMs(st.heartbeatAt) < 90_000) return;   // another worker is beating
  st = { ...st, heartbeatAt: nowIso() };
  await writeFcMigrateState(st);

  let copiedThisScroll = 0;

  while (Date.now() - start < budgetMs) {
    const live = await readFcMigrateState<FcMigrateState>().catch(() => st);
    if (!live || !live.running) return;
    if (live.stopRequested) { await writeFcMigrateState({ ...live, running: false, stopRequested: false, finishedAt: nowIso() }); return; }
    st = live;

    let rep;
    try {
      rep = await migrateFinalChecklistPhotosBatch({ apply: true, after: st.cursor || undefined, budgetMs: 40_000 });
    } catch (e: any) {
      await writeFcMigrateState({ ...st, heartbeatAt: nowIso(), lastError: String(e?.message || e).slice(0, 200) });
      break;
    }

    const totals = { ...st.totals };
    totals.fcRecords += rep.fcRecords || 0; totals.hubspotSeen += rep.hubspotSeen || 0;
    totals.copied += rep.copied || 0; totals.verified += rep.verified || 0;
    totals.recordsUpdated += rep.recordsUpdated || 0; totals.skippedDead += rep.skippedDead || 0; totals.errors += rep.errors || 0;
    copiedThisScroll += rep.copied || 0;
    const errorSamples = [...(st.errorSamples || [])];
    for (const s of (rep.errorSamples || [])) if (errorSamples.length < 20 && !errorSamples.includes(s)) errorSamples.push(s);

    let cursor = rep.after; let running = true; let finishedAt: string | undefined; let passes = st.passes;
    if (rep.done) {
      passes += 1;
      // If this pass still copied photos, sweep again (some skippedDead may have
      // been restored between passes). Converges when a full pass copies nothing.
      if (copiedThisScroll > 0 && passes < MAX_PASSES) { cursor = null; copiedThisScroll = 0; }
      else { running = false; finishedAt = nowIso(); }
    }
    st = { ...st, cursor, totals, errorSamples, passes, heartbeatAt: nowIso(), running, stopRequested: false, ...(finishedAt ? { finishedAt } : {}), lastError: undefined };
    await writeFcMigrateState(st);
    if (!running) return;
  }

  await writeFcMigrateState({ ...st, heartbeatAt: staleIso() });
  await kickFcMigrateWorker(origin, secret);
}
