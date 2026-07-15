/**
 * lib/photoMigrationJob.ts — server-driven, unattended photo migration.
 *
 * One admin button starts it; it then runs on the SERVER with no open browser:
 * a worker invocation processes batches for ~4 minutes, persists progress to a
 * shared state record, then re-triggers itself (detached fetch) to continue. An
 * hourly cron watchdog resumes the chain if a link ever dies. Safe to re-run;
 * migratePhotosBatch skips already-migrated photos.
 */
import { migratePhotosBatch, readPhotoMigrationState, writePhotoMigrationState } from '@/lib/hubspot';

export interface PhotoMigrationState {
  running: boolean;
  stopRequested?: boolean;
  object: 'answer' | 'service';
  cursor: string | null;
  totals: { found: number; copied: number; verified: number; records: number; scanned: number; errors: number };
  errorSamples: string[];
  startedAt: string;
  heartbeatAt: string;
  finishedAt?: string;
  lastError?: string;
}

const nowIso = () => new Date().toISOString();
const staleIso = () => new Date(Date.now() - 100_000).toISOString(); // ~100s old → "unclaimed"
const zeroTotals = () => ({ found: 0, copied: 0, verified: 0, records: 0, scanned: 0, errors: 0 });
const ageMs = (iso?: string) => (iso ? Date.now() - Date.parse(iso) : Infinity);

export function freshState(): PhotoMigrationState {
  // heartbeat starts STALE so the very first worker claims it (a fresh heartbeat
  // is the signal that another worker is actively running).
  return { running: true, stopRequested: false, object: 'answer', cursor: null, totals: zeroTotals(), errorSamples: [], startedAt: nowIso(), heartbeatAt: staleIso() };
}

/** Spawn the next worker invocation. AWAITED with a short abort so the request is
 *  actually dispatched (and the worker function spawned by Vercel) before the
 *  caller returns/freezes — a bare fire-and-forget often never leaves the box on
 *  serverless. The abort only drops OUR connection; the spawned function runs on. */
export async function kickWorker(origin: string, secret: string): Promise<void> {
  if (!origin || !secret) return;
  try {
    await fetch(`${origin}/api/admin/migrate-photos-bg?action=work&token=${encodeURIComponent(secret)}`, {
      method: 'POST',
      signal: (AbortSignal as any).timeout ? (AbortSignal as any).timeout(3000) : undefined,
    });
  } catch { /* AbortError after ~3s is expected — the worker is already running */ }
}

/**
 * Run migration batches until a time budget is spent, then chain the next
 * invocation. Single-runner: bails only if another worker's heartbeat is FRESH.
 */
export async function runMigrationWorker(origin: string, secret: string): Promise<void> {
  const start = Date.now();
  const BUDGET_MS = 230_000; // stay under the 300s function ceiling (+ chain kick)
  let st = await readPhotoMigrationState<PhotoMigrationState>().catch(() => null);
  if (!st || !st.running) return;                 // nothing to do
  if (st.stopRequested) { await writePhotoMigrationState({ ...st, running: false, stopRequested: false, finishedAt: nowIso() }); return; }
  // Single-runner lock: a FRESH heartbeat (<90s) means another worker is beating.
  // A stale/absent one means we're clear to claim (start seeds it stale; a
  // chaining worker sets it stale before handing off).
  if (ageMs(st.heartbeatAt) < 90_000) return;
  // Claim it.
  st = { ...st, heartbeatAt: nowIso() };
  await writePhotoMigrationState(st);

  while (Date.now() - start < BUDGET_MS) {
    const live = await readPhotoMigrationState<PhotoMigrationState>().catch(() => st);
    if (!live || !live.running) return;
    if (live.stopRequested) { await writePhotoMigrationState({ ...live, running: false, stopRequested: false, finishedAt: nowIso() }); return; }
    st = live;

    let rep;
    try {
      rep = await migratePhotosBatch({ object: st.object, after: st.cursor || undefined, apply: true, budgetMs: 40_000, photoCap: 80 });
    } catch (e: any) {
      await writePhotoMigrationState({ ...st, heartbeatAt: nowIso(), lastError: String(e?.message || e).slice(0, 200) });
      break; // chain will retry
    }

    const totals = { ...st.totals };
    totals.found += rep.hubspotSeen || 0; totals.copied += rep.copied || 0; totals.verified += rep.verified || 0;
    totals.records += rep.recordsUpdated || 0; totals.scanned += rep.scanned || 0; totals.errors += rep.errors || 0;
    const errorSamples = [...(st.errorSamples || [])];
    for (const s of (rep.errorSamples || [])) if (errorSamples.length < 20 && !errorSamples.includes(s)) errorSamples.push(s);

    let object = st.object; let cursor = rep.after; let running = true; let finishedAt: string | undefined;
    if (rep.done) {
      if (object === 'answer') { object = 'service'; cursor = null; }   // move to services
      else { running = false; finishedAt = nowIso(); }                  // all done
    }
    st = { ...st, object, cursor, totals, errorSamples, heartbeatAt: nowIso(), running, ...(finishedAt ? { finishedAt } : {}), lastError: undefined };
    await writePhotoMigrationState(st);
    if (!running) return;   // finished
  }

  // Budget spent but not done → RELEASE the lock (stale heartbeat) so the next
  // worker can claim immediately, then hand off. Await the kick so it dispatches.
  await writePhotoMigrationState({ ...st, heartbeatAt: staleIso() });
  await kickWorker(origin, secret);
}
