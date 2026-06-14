/**
 * Auto-cancel stale Scheduled inspections.
 *
 * Business rule: an inspection that is still "Scheduled" (never started — NOT
 * in_progress, completed, or cancelled) and whose scheduled date is a week or
 * more past due is abandoned, and should be moved to Cancelled automatically so
 * it stops cluttering the pipeline. Run by the daily Vercel Cron
 * (/api/cron/auto-cancel-stale); the threshold is 7 days by default and can be
 * overridden with AUTO_CANCEL_DAYS_PAST_DUE.
 *
 * Each cancel is re-checked against live status right before writing (so an
 * inspection an inspector started moments after the scan is never cancelled out
 * from under them) and recorded in the audit trail with a clear reason.
 */
import { listStaleScheduledInspections, fetchInspectionById, updateInspection } from '@/lib/hubspot';
import { recordAuditEvent } from '@/lib/auditLog';

const DEFAULT_DAYS_PAST_DUE = 7;

export interface AutoCancelSummary {
  daysPastDue: number;
  scanned: number;
  cancelled: number;
  skipped: number;  // no longer Scheduled by the time we went to cancel
  errors: number;
}

export async function runAutoCancelStaleScheduled(
  opts: { daysPastDue?: number; max?: number } = {},
): Promise<AutoCancelSummary> {
  const daysPastDue = opts.daysPastDue
    ?? (Number(process.env.AUTO_CANCEL_DAYS_PAST_DUE) || DEFAULT_DAYS_PAST_DUE);
  const max = opts.max ?? 500;

  const stale = await listStaleScheduledInspections(daysPastDue, max);
  let cancelled = 0, skipped = 0, errors = 0;

  // Bounded concurrency — polite to HubSpot's rate limit while not taking N
  // sequential round-trips on a backlog.
  const CONCURRENCY = 5;
  let idx = 0;
  async function worker() {
    while (idx < stale.length) {
      const item = stale[idx++];
      try {
        // Re-check live status: only cancel if STILL Scheduled (it may have been
        // started, completed, or already cancelled since the scan).
        const insp = await fetchInspectionById(item.recordId);
        const status = (insp?.status || '').trim().toLowerCase();
        if (status !== 'scheduled') { skipped++; continue; }
        await updateInspection(item.recordId, { status: 'cancelled' });
        cancelled++;
        await recordAuditEvent({
          inspectionId: item.recordId,
          action: 'cancel',
          actorName: 'System (auto-cancel)',
          detail: `Auto-cancelled: still Scheduled and ${daysPastDue}+ days past the scheduled date (never started).`,
          meta: { reason: 'stale_scheduled', daysPastDue, scheduledDate: item.scheduledDate || undefined },
        });
      } catch (e: any) {
        errors++;
        console.warn(`[auto-cancel] ${item.recordId} failed:`, String(e?.message || e).slice(0, 160));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, stale.length) }, () => worker()));

  return { daysPastDue, scanned: stale.length, cancelled, skipped, errors };
}
