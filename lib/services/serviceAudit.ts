/**
 * ResiWalk - Services — per-service audit trail.
 *
 * Records the audit-significant lifecycle events for a Service Work Order — who
 * submitted it, the AI review verdict, the reviewer's decision (approve / modify
 * / reject) and notes, vendor reassignments, and cancellation — so every service
 * has an answerable "what happened, and who did it" surfaced under the record's
 * ⚙️ settings menu.
 *
 * Storage reuses the inspection audit infra (append-only Vercel blob, one event
 * per file) under a `svc-<id>` namespace so service events never collide with
 * inspection events. Best-effort: an audit write must never block a transition.
 */
import { recordAuditEvent, readAuditLog, type AuditEvent } from '@/lib/auditLog';

export type ServiceAuditAction =
  | 'submit'      // vendor submitted the completed service
  | 'ai_review'   // AI QC verdict written (clean → completed / needs_review → review)
  | 'review'      // internal reviewer decision (approve / modify / reject)
  | 'bid'         // bid-item decision (approve → assigned / reject → canceled)
  | 'reassign'    // vendor reassigned
  | 'cancel';     // service canceled

const key = (serviceId: string) => `svc-${serviceId}`;

/** Record one service lifecycle event. Best-effort; never throws. */
export function recordServiceAudit(e: {
  serviceId: string;
  action: ServiceAuditAction | string;
  actorEmail?: string;
  actorName?: string;
  detail?: string;
  meta?: AuditEvent['meta'];
}): Promise<void> {
  return recordAuditEvent({
    inspectionId: key(e.serviceId),
    action: e.action,
    actorEmail: e.actorEmail,
    actorName: e.actorName,
    detail: e.detail,
    meta: e.meta,
  });
}

/** Read a service's recorded events, newest first. */
export function readServiceAudit(serviceId: string): Promise<AuditEvent[]> {
  return readAuditLog(key(serviceId));
}
