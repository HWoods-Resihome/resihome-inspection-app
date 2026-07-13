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
  address: string; locality?: string; worktypeLabel: string; subtypeLabel: string; dueDate?: string; baseUrl: string; force?: boolean;
}): Promise<void> {
  try {
    const to = String(o.vendorEmail || '').trim();
    if (!validEmail(to) || (!o.force && !(await isNotificationEnabled(to, 'service_assigned')))) return;
    const addr = fullAddr(o.address, o.locality);
    await sendNotificationEmail({
      to, subject: `New Service Assigned — ${addr}`,
      heading: 'New Service Assigned',
      intro: `A new ${o.worktypeLabel} · ${o.subtypeLabel} service has been assigned to you.`,
      rows: [['Property', addr], ['Service', `${o.worktypeLabel} · ${o.subtypeLabel}`], ['Due', fmtMDY(o.dueDate)], ['Vendor', o.vendorName || '']],
      linkUrl: `${o.baseUrl}/services/${encodeURIComponent(o.serviceId)}`, linkLabel: 'Open Service',
    });
  } catch (e: any) { console.warn('[notify] service_assigned failed:', String(e?.message || e).slice(0, 160)); }
}

/** Service completed → the vendor, with the completion PDF attached + a link. */
export async function notifyServiceCompleted(o: {
  serviceId: string; vendorEmail?: string | null; vendorName?: string | null;
  address: string; locality?: string; worktypeLabel: string; subtypeLabel: string; baseUrl: string; force?: boolean;
}): Promise<void> {
  try {
    const to = String(o.vendorEmail || '').trim();
    if (!validEmail(to) || (!o.force && !(await isNotificationEnabled(to, 'service_completed')))) return;
    const addr = fullAddr(o.address, o.locality);
    let attachment: { filename: string; content: Buffer; mimeType: string } | null = null;
    try {
      const buf = await renderServicePdfBuffer(o.serviceId, { variant: 'vendor', baseUrl: o.baseUrl, internal: false });
      if (buf) attachment = { filename: pdfName('service', o.serviceId), content: buf, mimeType: 'application/pdf' };
    } catch (e: any) { console.warn('[notify] service PDF render failed:', String(e?.message || e).slice(0, 120)); }
    await sendNotificationEmail({
      to, subject: `Service Completed — ${addr}`,
      heading: 'Service Completed',
      intro: `Your ${o.worktypeLabel} · ${o.subtypeLabel} at ${addr} has been completed.${attachment ? ' The completion report is attached.' : ''}`,
      rows: [['Property', addr], ['Service', `${o.worktypeLabel} · ${o.subtypeLabel}`]],
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
      intro: `Your ${o.worktypeLabel} · ${o.subtypeLabel} at ${addr} is past due. Please submit the completion as soon as possible.`,
      rows: [['Property', addr], ['Service', `${o.worktypeLabel} · ${o.subtypeLabel}`], ['Was due', fmtMDY(o.dueDate)]],
      linkUrl: `${o.baseUrl}/services/${encodeURIComponent(o.serviceId)}`, linkLabel: 'Complete Service',
    });
  } catch (e: any) { console.warn('[notify] service_past_due failed:', String(e?.message || e).slice(0, 160)); }
}
