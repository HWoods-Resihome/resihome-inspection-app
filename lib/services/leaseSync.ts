/**
 * Move-in-clean lease-anchored due-date re-sync.
 *
 * A move-in clean rule can anchor its due date to the property's lease start date
 * (from the leasing deal), which often isn't known at enrollment. Generation then
 * uses a fallback due (today + N) and stamps the order with due_anchor=lease_start.
 * This job re-checks every OPEN (assigned) such order and, once the lease start
 * date is known:
 *   • reschedules the due to max(leaseStart − daysBefore, today+1), OR
 *   • cancels the order when the lease is already today/tomorrow (no runway to hand
 *     a vendor at least a day before move-in).
 * Only touches status 'assigned' — a submitted/completed order is never changed.
 * Idempotent: it only writes when the due actually changes.
 */
import { searchServiceWorkOrdersByStatus, patchServiceWorkOrder, fetchPropertyMoveInDate } from '@/lib/hubspot';
import { computeLeaseAnchoredDue } from './generate';
import { recordServiceAudit } from './serviceAudit';

export interface LeaseSyncResult {
  configured: boolean;
  scanned: number; rescheduled: number; canceled: number; stillPending: number; unchanged: number; errors: number;
  items: { id: string; action: string; from?: string; to?: string; lease?: string; error?: string }[];
}

/** Re-sync all assigned lease-anchored move-in cleans. `apply` writes; false = dry-run. */
export async function syncMoveInCleanDueDates(apply: boolean, todayISO: string): Promise<LeaseSyncResult | null> {
  const assigned = await searchServiceWorkOrdersByStatus('assigned', 3000).catch(() => null);
  if (assigned === null) return null; // object not configured
  const result: LeaseSyncResult = { configured: true, scanned: 0, rescheduled: 0, canceled: 0, stillPending: 0, unchanged: 0, errors: 0, items: [] };

  const targets = assigned.filter((o) =>
    String(o.props.worktype || '') === 'cleaning' &&
    String(o.props.subtype || '') === 'move_in_clean' &&
    String(o.props.due_anchor || '') === 'lease_start');

  for (const o of targets) {
    result.scanned++;
    try {
      const propId = String(o.props.property_id_ref || '').trim();
      if (!propId) { result.stillPending++; continue; }   // can't resolve a lease without a property ref
      const lease = String((await fetchPropertyMoveInDate(propId)) || '');   // '' / 'TBD' → unknown
      const daysBefore = Math.max(0, Math.floor(Number(o.props.days_before_lease_start) || 0));
      const r = computeLeaseAnchoredDue({ leaseStart: lease, daysBefore, fallbackDays: 0, todayISO });

      if (r.cancel) {
        result.canceled++;
        result.items.push({ id: o.id, action: 'cancel', lease: lease.slice(0, 10) });
        if (apply) {
          await patchServiceWorkOrder(o.id, { status: 'canceled' });
          void recordServiceAudit({ serviceId: o.id, action: 'cancel', actorName: 'Lease Sync', detail: `Auto-canceled — lease start (${lease.slice(0, 10)}) is within a day; no runway to schedule the clean before move-in.` });
        }
        continue;
      }
      if (r.pending) { result.stillPending++; continue; }   // lease still unknown → keep the fallback due

      const cur = String(o.props.due_date || '').slice(0, 10);
      if (r.due !== cur) {
        result.rescheduled++;
        result.items.push({ id: o.id, action: 'reschedule', from: cur, to: r.due, lease: lease.slice(0, 10) });
        if (apply) {
          await patchServiceWorkOrder(o.id, { due_date: r.due });
          void recordServiceAudit({ serviceId: o.id, action: 'edit', actorName: 'Lease Sync', detail: `Due date synced to ${r.due} (${daysBefore}d before lease start ${lease.slice(0, 10)}).` });
        }
      } else {
        result.unchanged++;
      }
    } catch (e: any) {
      result.errors++;
      result.items.push({ id: o.id, action: 'error', error: String(e?.message || e).slice(0, 160) });
    }
  }
  return result;
}
