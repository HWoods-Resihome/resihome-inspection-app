/**
 * GET /api/cron/ticket-type-sweep — drains the durable ticket-type enforcement
 * queue INDEPENDENTLY of any browser session, so a user closing the tab or
 * navigating away right after finalize can never prevent the HoneyBadger ticket
 * type from being forced (Turnkey / Evictions). For each due job it runs the same
 * retry-until-confirmed UI enforcement finalize uses; on confirmation it removes
 * the job, otherwise it bumps the attempt (giving up after ENFORCE_MAX_ATTEMPTS).
 *
 * Requires CRON_SECRET. Idempotent — a ticket already at the target reads back as
 * such and is removed on the next pass.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import {
  listTicketEnforceJobs, removeTicketEnforcement, bumpTicketEnforcement, touchTicketEnforcement,
} from '@/lib/ticketEnforceQueue';
import { setTicketTypeViaUi } from '@/lib/ticketUpload';

// A browser run is slow; allow the full serverless ceiling.
export const config = { maxDuration: 300 };

// Skip a job attempted within this window so overlapping cron ticks don't stack
// two browser sessions on the same ticket.
const COOLDOWN_MS = Number(process.env.HBMM_ENFORCE_COOLDOWN_MS || 90_000) || 90_000;
// Bound browser runs per invocation to stay comfortably under maxDuration.
const BATCH = Math.max(1, Number(process.env.HBMM_ENFORCE_BATCH || 3) || 3);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return res.status(200).json({ ok: true, skipped: true, reason: 'CRON_SECRET not configured.' });
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });

  const all = await listTicketEnforceJobs();
  const now = Date.now();
  const due = all
    .filter((j) => !j.lastAttemptAt || (now - Date.parse(j.lastAttemptAt) >= COOLDOWN_MS))
    .sort((a, b) => (a.enqueuedAt < b.enqueuedAt ? -1 : a.enqueuedAt > b.enqueuedAt ? 1 : 0))
    .slice(0, BATCH);

  const results: any[] = [];
  for (const job of due) {
    // Claim it (stamp lastAttemptAt) BEFORE the slow browser run so a concurrent
    // tick within the cooldown skips it.
    await touchTicketEnforcement(job.ticketId);
    try {
      const ui = await setTicketTypeViaUi({ ticketId: job.ticketId, target: job.target });
      if (ui.ok) {
        await removeTicketEnforcement(job.ticketId);
        results.push({ ticketId: job.ticketId, outcome: 'confirmed' });
      } else {
        const b = await bumpTicketEnforcement(job.ticketId);
        results.push({ ticketId: job.ticketId, outcome: b.dropped ? 'gave-up' : 'retry', attempts: b.attempts, error: ui.error });
        console.warn(`[ticket-type-sweep] #${job.ticketId} not confirmed (attempt ${b.attempts}${b.dropped ? ', GIVING UP' : ''}): ${ui.error || ''}\n  ${ui.steps.slice(-6).join('\n  ')}`);
      }
    } catch (e: any) {
      const b = await bumpTicketEnforcement(job.ticketId);
      results.push({ ticketId: job.ticketId, outcome: b.dropped ? 'gave-up-error' : 'retry-error', attempts: b.attempts, error: String(e?.message || e).slice(0, 200) });
    }
  }
  return res.status(200).json({ ok: true, queued: all.length, attempted: due.length, results });
}
