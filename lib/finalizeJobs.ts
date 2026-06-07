/**
 * Finalize job tracking.
 *
 * Finalize is a multi-step pipeline (load → render PDFs → upload → write status
 * → maintenance ticket → email → SFTP watch). If it dies partway, the work is
 * left half-done and, today, invisible: the inspection just sits in
 * pending_approval with no signal that an attempt failed. This records each
 * attempt's status (started → succeeded/failed) plus the phase it reached and
 * the error, so an operator can SEE stuck/failed finalizes (admin view) and
 * retry them (re-POSTing finalize is idempotent/resumable by design).
 *
 * Storage mirrors the other Blob logs: one record per attempt at
 * finalize-jobs/<inspectionId>/<jobId>.json, overwritten as the attempt reaches
 * a terminal state. The structured [finalize-job] log is authoritative. The
 * startedAt is encoded in the jobId so the terminal write needs no prior read.
 */
import { put, list } from '@vercel/blob';

export type FinalizeJobStatus = 'started' | 'succeeded' | 'failed';
export type FinalizeMode = 'finalize' | 'refinalize' | 'regenerate';

export interface FinalizeJob {
  jobId: string;
  inspectionId: string;
  mode: FinalizeMode;
  status: FinalizeJobStatus;
  phase?: string;
  actorEmail?: string;
  error?: string;
  elapsedMs?: number;
  startedAt: string;
  updatedAt: string;
  /** Derived in readFinalizeJobs: started with no terminal update for a while. */
  stuck?: boolean;
}

// A 'started' job older than this with no terminal update is considered stuck
// (the function timed out / the instance died mid-pipeline).
const STUCK_MS = 5 * 60 * 1000;

function startedAtFromJobId(jobId: string): string {
  const ms = Number(String(jobId).split('-')[0]);
  return isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

async function writeJob(job: FinalizeJob): Promise<void> {
  try { console.log(`[finalize-job] ${JSON.stringify(job)}`); } catch { /* noop */ }
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;
  try {
    await put(`finalize-jobs/${job.inspectionId}/${job.jobId}.json`, JSON.stringify(job),
      { access: 'public', contentType: 'application/json', allowOverwrite: true, addRandomSuffix: false });
  } catch (e: any) {
    console.warn('[finalize-job] write failed:', String(e?.message || e).slice(0, 120));
  }
}

/** Record the START of a finalize attempt. Returns the jobId (or null). */
export async function beginFinalizeJob(args: {
  inspectionId: string; mode: FinalizeMode; actorEmail?: string;
}): Promise<string | null> {
  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const now = new Date().toISOString();
  await writeJob({
    jobId, inspectionId: args.inspectionId, mode: args.mode, status: 'started',
    actorEmail: args.actorEmail, phase: 'starting', startedAt: now, updatedAt: now,
  });
  return jobId;
}

/** Record a finalize attempt reaching a terminal state. Best-effort. */
export async function completeFinalizeJob(jobId: string | null, args: {
  inspectionId: string; mode: FinalizeMode; status: FinalizeJobStatus;
  phase?: string; error?: string; elapsedMs?: number; actorEmail?: string;
}): Promise<void> {
  const id = jobId || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await writeJob({
    jobId: id, inspectionId: args.inspectionId, mode: args.mode, status: args.status,
    phase: args.phase, error: args.error ? String(args.error).slice(0, 500) : undefined,
    elapsedMs: args.elapsedMs, actorEmail: args.actorEmail,
    startedAt: startedAtFromJobId(id), updatedAt: new Date().toISOString(),
  });
}

/**
 * Read finalize jobs from the last `days` days, newest first. Marks a job
 * `stuck` when it's still 'started' and hasn't updated within STUCK_MS — those
 * are the attempts that died mid-pipeline and likely left work half-done.
 */
export async function readFinalizeJobs(days = 7): Promise<FinalizeJob[]> {
  const out: FinalizeJob[] = [];
  if (!process.env.BLOB_READ_WRITE_TOKEN) return out;
  const cutoffMs = Date.now() - Math.max(1, days) * 864e5;
  try {
    let cursor: string | undefined;
    do {
      const page = await list({ prefix: 'finalize-jobs/', cursor, limit: 1000 });
      const jobs = await Promise.all(page.blobs.map((b) => fetch(b.url).then((r) => r.json()).catch(() => null)));
      for (const j of jobs) {
        if (!j) continue;
        if (new Date(j.startedAt).getTime() < cutoffMs) continue;
        const stuck = j.status === 'started' && (Date.now() - new Date(j.updatedAt).getTime() > STUCK_MS);
        out.push({ ...j, stuck });
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  } catch (e: any) {
    console.warn('[finalize-job] read failed:', String(e?.message || e).slice(0, 120));
  }
  out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  return out;
}
