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

/** Inspection completed → the inspector, with the report PDF attached + a link. */
export async function notifyInspectionCompleted(o: {
  inspectionId: string; inspectorEmail?: string | null; templateLabel: string; address: string;
  pdfUrl?: string | null; baseUrl: string; force?: boolean;
}): Promise<void> {
  try {
    const to = String(o.inspectorEmail || '').trim();
    if (!validEmail(to) || (!o.force && !(await isNotificationEnabled(to, 'inspection_completed')))) return;
    let attachment: { filename: string; content: Buffer; mimeType: string } | null = null;
    if (o.pdfUrl) { const buf = await fetchToBuffer(o.pdfUrl); if (buf) attachment = { filename: pdfName('inspection', o.inspectionId), content: buf, mimeType: 'application/pdf' }; }
    await sendNotificationEmail({
      to, subject: `Inspection Completed — ${o.address}`,
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
  address: string; worktypeLabel: string; subtypeLabel: string; dueDate?: string; baseUrl: string; force?: boolean;
}): Promise<void> {
  try {
    const to = String(o.vendorEmail || '').trim();
    if (!validEmail(to) || (!o.force && !(await isNotificationEnabled(to, 'service_assigned')))) return;
    await sendNotificationEmail({
      to, subject: `New Service Assigned — ${o.address}`,
      heading: 'New Service Assigned',
      intro: `A new ${o.worktypeLabel} · ${o.subtypeLabel} service has been assigned to you.`,
      rows: [['Property', o.address], ['Service', `${o.worktypeLabel} · ${o.subtypeLabel}`], ['Due', o.dueDate || '—'], ['Vendor', o.vendorName || '']],
      linkUrl: `${o.baseUrl}/services/${encodeURIComponent(o.serviceId)}`, linkLabel: 'Open Service',
    });
  } catch (e: any) { console.warn('[notify] service_assigned failed:', String(e?.message || e).slice(0, 160)); }
}

/** Service completed → the vendor, with the completion PDF attached + a link. */
export async function notifyServiceCompleted(o: {
  serviceId: string; vendorEmail?: string | null; vendorName?: string | null;
  address: string; worktypeLabel: string; subtypeLabel: string; baseUrl: string; force?: boolean;
}): Promise<void> {
  try {
    const to = String(o.vendorEmail || '').trim();
    if (!validEmail(to) || (!o.force && !(await isNotificationEnabled(to, 'service_completed')))) return;
    let attachment: { filename: string; content: Buffer; mimeType: string } | null = null;
    try {
      const buf = await renderServicePdfBuffer(o.serviceId, { variant: 'vendor', baseUrl: o.baseUrl, internal: false });
      if (buf) attachment = { filename: pdfName('service', o.serviceId), content: buf, mimeType: 'application/pdf' };
    } catch (e: any) { console.warn('[notify] service PDF render failed:', String(e?.message || e).slice(0, 120)); }
    await sendNotificationEmail({
      to, subject: `Service Completed — ${o.address}`,
      heading: 'Service Completed',
      intro: `Your ${o.worktypeLabel} · ${o.subtypeLabel} at ${o.address} has been completed.${attachment ? ' The completion report is attached.' : ''}`,
      rows: [['Property', o.address], ['Service', `${o.worktypeLabel} · ${o.subtypeLabel}`]],
      linkUrl: `${o.baseUrl}/services/${encodeURIComponent(o.serviceId)}`, linkLabel: 'Open Service',
      attachment,
    });
  } catch (e: any) { console.warn('[notify] service_completed failed:', String(e?.message || e).slice(0, 160)); }
}

/** Service past due → the vendor, nudging completion, with a link. */
export async function notifyServicePastDue(o: {
  serviceId: string; vendorEmail?: string | null; vendorName?: string | null;
  address: string; worktypeLabel: string; subtypeLabel: string; dueDate?: string; baseUrl: string; force?: boolean;
}): Promise<void> {
  try {
    const to = String(o.vendorEmail || '').trim();
    if (!validEmail(to) || (!o.force && !(await isNotificationEnabled(to, 'service_past_due')))) return;
    await sendNotificationEmail({
      to, subject: `Past Due — Please Complete: ${o.address}`,
      heading: 'Service Past Due',
      intro: `Your ${o.worktypeLabel} · ${o.subtypeLabel} at ${o.address} is past due. Please submit the completion as soon as possible.`,
      rows: [['Property', o.address], ['Service', `${o.worktypeLabel} · ${o.subtypeLabel}`], ['Was due', o.dueDate || '—']],
      linkUrl: `${o.baseUrl}/services/${encodeURIComponent(o.serviceId)}`, linkLabel: 'Complete Service',
    });
  } catch (e: any) { console.warn('[notify] service_past_due failed:', String(e?.message || e).slice(0, 160)); }
}
