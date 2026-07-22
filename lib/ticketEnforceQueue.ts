/**
 * Durable ticket-type enforcement queue.
 *
 * The HoneyBadger ("MM") ticket type must be forced (Turnkey / Evictions) via the
 * web UI — but that browser step runs after finalize, and a user closing the tab
 * or navigating away must NOT prevent it. So finalize ENQUEUES the ticket here
 * (server-side, synchronously, before responding), and a cron
 * (pages/api/cron/ticket-type-sweep) drains the queue independently of any browser
 * session — retrying until the reloaded ticket confirms the type, then removing it.
 *
 * Stored in the shared Agent JSON store (no schema change). Idempotent: enqueuing
 * the same ticketId replaces its entry; the sweeper removes on confirmation.
 */
import { readTicketEnforceQueue, mutateTicketEnforceQueue } from '@/lib/hubspot';

export interface TicketEnforceJob {
  ticketId: number;
  target: string;            // "Turnkey" | "Evictions"
  inspectionId?: string;     // for tracing
  attempts: number;          // sweep attempts so far
  enqueuedAt: string;        // ISO
  lastAttemptAt?: string;    // ISO — used for the cron cooldown so overlapping runs don't stack
}

// Give up after this many failed sweeps (the live UI run + this many cron passes
// should be far more than enough; a persistent failure means selectors/creds need
// attention, surfaced in the cron log).
export const ENFORCE_MAX_ATTEMPTS = Math.max(1, Number(process.env.HBMM_ENFORCE_MAX_ATTEMPTS || 10) || 10);

export async function listTicketEnforceJobs(): Promise<TicketEnforceJob[]> {
  const raw = await readTicketEnforceQueue<TicketEnforceJob[]>().catch(() => null);
  return Array.isArray(raw) ? raw.filter((j) => j && Number.isFinite(Number(j.ticketId))) : [];
}

/** Add (or refresh) a ticket to the enforcement queue. Best-effort, never throws. */
export async function enqueueTicketEnforcement(ticketId: number, target: string, inspectionId?: string): Promise<void> {
  if (!Number.isFinite(ticketId) || ticketId <= 0) return;
  const t = (target || '').trim();
  if (!t) return;
  const nowIso = new Date().toISOString();
  try {
    await mutateTicketEnforceQueue<TicketEnforceJob[]>((cur) => {
      const list = (Array.isArray(cur) ? cur : []).filter((j) => Number(j.ticketId) !== ticketId);
      list.push({ ticketId, target: t, inspectionId, attempts: 0, enqueuedAt: nowIso });
      // Bound the queue so a runaway can't bloat the property value.
      return list.slice(-200);
    });
  } catch { /* best-effort — the live UI run still enforces it */ }
}

/** Remove a ticket from the queue (called once its type is confirmed). */
export async function removeTicketEnforcement(ticketId: number): Promise<void> {
  try {
    await mutateTicketEnforceQueue<TicketEnforceJob[]>((cur) =>
      (Array.isArray(cur) ? cur : []).filter((j) => Number(j.ticketId) !== ticketId));
  } catch { /* best-effort */ }
}

/** Record a failed sweep attempt (increments the counter + stamps lastAttemptAt),
 *  or drop the job if it has exhausted ENFORCE_MAX_ATTEMPTS. Returns whether it was
 *  dropped for exhaustion (so the caller can log a give-up). */
export async function bumpTicketEnforcement(ticketId: number): Promise<{ dropped: boolean; attempts: number }> {
  const nowIso = new Date().toISOString();
  let dropped = false;
  let attempts = 0;
  try {
    await mutateTicketEnforceQueue<TicketEnforceJob[]>((cur) => {
      const list = Array.isArray(cur) ? cur : [];
      const out: TicketEnforceJob[] = [];
      for (const j of list) {
        if (Number(j.ticketId) !== ticketId) { out.push(j); continue; }
        const next = { ...j, attempts: (j.attempts || 0) + 1, lastAttemptAt: nowIso };
        attempts = next.attempts;
        if (next.attempts >= ENFORCE_MAX_ATTEMPTS) { dropped = true; continue; } // give up → drop
        out.push(next);
      }
      return out;
    });
  } catch { /* best-effort */ }
  return { dropped, attempts };
}

/** Stamp lastAttemptAt WITHOUT incrementing (claim a job before a sweep so a
 *  concurrent cron run within the cooldown skips it). */
export async function touchTicketEnforcement(ticketId: number): Promise<void> {
  const nowIso = new Date().toISOString();
  try {
    await mutateTicketEnforceQueue<TicketEnforceJob[]>((cur) =>
      (Array.isArray(cur) ? cur : []).map((j) => (Number(j.ticketId) === ticketId ? { ...j, lastAttemptAt: nowIso } : j)));
  } catch { /* best-effort */ }
}
