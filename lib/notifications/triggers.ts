/**
 * The four notification triggers. Each is best-effort: it checks the recipient's
 * toggle, composes, and sends — swallowing every error so a notification can never
 * break the lifecycle action that fired it. Recipient email doubles as the prefs
 * key (the vendor/inspector manages their own toggles under the same address).
 */
import { isNotificationEnabled } from './prefs';
import { sendNotificationEmail, fetchToBuffer } from './send';
import { renderServicePdfBuffer } from '@/lib/servicePdfRender';

const validEmail = (e?: string | null) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || '').trim());
const pdfName = (kind: string, id: string) => `${kind}-${id}.pdf`;
// Dates in emails read as M-D-YY (e.g. 2026-07-13 → 7-13-26).
const fmtMDY = (iso?: string | null): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${Number(m[2])}-${Number(m[3])}-${m[1].slice(2)}` : (String(iso || '').trim() || '—');
};
// "Street, City, ST ZIP" — the street plus locality when we have one (services
// carry them separately; the locality is skipped if it just repeats the street).
const fullAddr = (street: string, locality?: string | null): string => {
  const s = String(street || '').trim();
  const loc = String(locality || '').trim();
  return loc && loc !== s ? `${s}, ${loc}` : s;
};

/** Inspection completed → the inspector, with the report PDF attached + a link. */
export async function notifyInspectionCompleted(o: {
  inspectionId: string; inspectorEmail?: string | null; templateLabel: string; address: string;
  pdfUrl?: string | null; baseUrl: string; force?: boolean;
  /** Extra To recipients beyond the inspector (e.g. a community's RRQC walk
   *  distribution address). Invalid/blank entries are dropped downstream. */
  extraTo?: Array<string | null | undefined>;
}): Promise<void> {
  try {
    const to = String(o.inspectorEmail || '').trim();
    if (!validEmail(to) || (!o.force && !(await isNotificationEnabled(to, 'inspection_completed')))) return;
    const alsoTo = (o.extraTo || []).map((x) => String(x || '').trim()).filter((x) => validEmail(x));
    let attachment: { filename: string; content: Buffer; mimeType: string } | null = null;
    if (o.pdfUrl) { const buf = await fetchToBuffer(o.pdfUrl); if (buf) attachment = { filename: pdfName('inspection', o.inspectionId), content: buf, mimeType: 'application/pdf' }; }
    await sendNotificationEmail({
      to, alsoTo, subject: `Inspection Completed — ${o.address}`,
      heading: 'Inspection Completed',
      intro: `Your ${o.templateLabel} at ${o.address} is complete.${attachment ? ' A copy of the report is attached.' : ''}`,
      rows: [['Property', o.address], ['Inspection', o.templateLabel]],
      linkUrl: `${o.baseUrl}/inspection/${encodeURIComponent(o.inspectionId)}`, linkLabel: 'Open Inspection',
      attachment,
    });
  } catch (e: any) { console.warn('[notify] inspection_completed failed:', String(e?.message || e).slice(0, 160)); }
}

/** New service assigned → the vendor, with a link. */
export async function notifyServiceAssigned(o: {
  serviceId: string; vendorEmail?: string | null; vendorName?: string | null;
  address: string; locality?: string; worktypeLabel: string; subtypeLabel: string; dueDate?: string; baseUrl: string; force?: boolean;
}): Promise<void> {
  try {
    const to = String(o.vendorEmail || '').trim();
    if (!validEmail(to) || (!o.force && !(await isNotificationEnabled(to, 'service_assigned')))) return;
    const addr = fullAddr(o.address, o.locality);
    await sendNotificationEmail({
      to, subject: `New Service Assigned — ${addr}`,
      heading: 'New Service Assigned',
      intro: `A new ${o.worktypeLabel} (${o.subtypeLabel}) service has been assigned to you.`,
      rows: [['Property', addr], ['Service', `${o.worktypeLabel} (${o.subtypeLabel})`], ['Due', fmtMDY(o.dueDate)], ['Vendor', o.vendorName || '']],
      linkUrl: `${o.baseUrl}/services/${encodeURIComponent(o.serviceId)}`, linkLabel: 'Open Service',
    });
  } catch (e: any) { console.warn('[notify] service_assigned failed:', String(e?.message || e).slice(0, 160)); }
}

/** Service completed → the vendor, with the completion PDF attached + a link. */
export async function notifyServiceCompleted(o: {
  serviceId: string; vendorEmail?: string | null; vendorName?: string | null;
  address: string; locality?: string; worktypeLabel: string; subtypeLabel: string; baseUrl: string; force?: boolean;
  // Review outcome — the vendor is alerted on ANY decision. reject reads as "not
  // approved / no payment"; modify notes pricing was adjusted; approve (or absent,
  // e.g. AI auto-approve) reads as a plain completion. The vendor PDF is attached
  // in every case.
  decision?: 'approve' | 'modify' | 'reject'; reviewerNote?: string;
}): Promise<void> {
  try {
    const to = String(o.vendorEmail || '').trim();
    if (!validEmail(to) || (!o.force && !(await isNotificationEnabled(to, 'service_completed')))) return;
    const addr = fullAddr(o.address, o.locality);
    const svc = `${o.worktypeLabel} (${o.subtypeLabel})`;
    const isReject = o.decision === 'reject';
    const isModify = o.decision === 'modify';
    let attachment: { filename: string; content: Buffer; mimeType: string } | null = null;
    try {
      const buf = await renderServicePdfBuffer(o.serviceId, { variant: 'vendor', baseUrl: o.baseUrl, internal: false });
      if (buf) attachment = { filename: pdfName('service', o.serviceId), content: buf, mimeType: 'application/pdf' };
    } catch (e: any) { console.warn('[notify] service PDF render failed:', String(e?.message || e).slice(0, 120)); }
    const note = String(o.reviewerNote || '').trim();
    const rows: Array<[string, string]> = [['Property', addr], ['Service', svc]];
    if (note) rows.push(['Reviewer note', note]);
    await sendNotificationEmail({
      to,
      subject: isReject ? `Service Reviewed — Not Approved: ${addr}` : `Service Completed — ${addr}`,
      heading: isReject ? 'Service Not Approved' : 'Service Completed',
      intro: isReject
        ? `Your ${svc} at ${addr} was reviewed and not approved, so no payment was issued for this visit.${attachment ? ' The report is attached.' : ''}`
        : `Your ${svc} at ${addr} has been completed${isModify ? ' (pricing was adjusted in review)' : ''}.${attachment ? ' The completion report is attached.' : ''}`,
      rows,
      linkUrl: `${o.baseUrl}/services/${encodeURIComponent(o.serviceId)}`, linkLabel: 'Open Service',
      attachment,
    });
  } catch (e: any) { console.warn('[notify] service_completed failed:', String(e?.message || e).slice(0, 160)); }
}

/** Service past due → the vendor, nudging completion, with a link. */
export async function notifyServicePastDue(o: {
  serviceId: string; vendorEmail?: string | null; vendorName?: string | null;
  address: string; locality?: string; worktypeLabel: string; subtypeLabel: string; dueDate?: string; baseUrl: string; force?: boolean;
}): Promise<void> {
  try {
    const to = String(o.vendorEmail || '').trim();
    if (!validEmail(to) || (!o.force && !(await isNotificationEnabled(to, 'service_past_due')))) return;
    const addr = fullAddr(o.address, o.locality);
    await sendNotificationEmail({
      to, subject: `Past Due — Please Complete: ${addr}`,
      heading: 'Service Past Due',
      intro: `Your ${o.worktypeLabel} (${o.subtypeLabel}) at ${addr} is past due. Please submit the completion as soon as possible.`,
      rows: [['Property', addr], ['Service', `${o.worktypeLabel} (${o.subtypeLabel})`], ['Was due', fmtMDY(o.dueDate)]],
      linkUrl: `${o.baseUrl}/services/${encodeURIComponent(o.serviceId)}`, linkLabel: 'Complete Service',
    });
  } catch (e: any) { console.warn('[notify] service_past_due failed:', String(e?.message || e).slice(0, 160)); }
}

/** Daily DIGEST: one email per vendor listing ALL of their past-due open services
 *  (a running summary, so a service keeps appearing until it's completed — this is
 *  the standing past-due nudge + escalation). Respects the vendor's past-due
 *  notification toggle. */
export async function notifyVendorPastDueDigest(o: {
  vendorEmail?: string | null; vendorName?: string | null; baseUrl: string; force?: boolean;
  services: { serviceId: string; address: string; locality?: string; worktypeLabel: string; subtypeLabel: string; dueDate?: string; daysOverdue: number }[];
}): Promise<void> {
  try {
    const to = String(o.vendorEmail || '').trim();
    if (!o.services.length) return;
    if (!validEmail(to) || (!o.force && !(await isNotificationEnabled(to, 'service_past_due')))) return;
    // Most overdue first; cap the emailed list so a big backlog can't bloat the email.
    const sorted = [...o.services].sort((a, b) => b.daysOverdue - a.daysOverdue);
    const CAP = 40;
    const shown = sorted.slice(0, CAP);
    const n = o.services.length;
    const rows: Array<[string, string]> = shown.map((s) => [
      `${s.worktypeLabel} (${s.subtypeLabel})`,
      `${fullAddr(s.address, s.locality)} — was due ${fmtMDY(s.dueDate)} · ${s.daysOverdue}d overdue`,
    ]);
    if (n > CAP) rows.push(['…and more', `${n - CAP} additional past-due service(s) — open My Services to see them all`]);
    await sendNotificationEmail({
      to, subject: `Past Due Summary — ${n} service${n === 1 ? '' : 's'} awaiting completion`,
      heading: 'Past Due Services',
      intro: `You have ${n} past-due service${n === 1 ? '' : 's'}. Please submit ${n === 1 ? 'its' : 'their'} completion as soon as possible.`,
      rows,
      linkUrl: `${o.baseUrl}/services`, linkLabel: 'Open My Services',
    });
  } catch (e: any) { console.warn('[notify] service_past_due_digest failed:', String(e?.message || e).slice(0, 160)); }
}
