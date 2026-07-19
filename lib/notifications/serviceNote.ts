/**
 * Service-note notification email — sent to the OTHER side of the thread when a
 * note is added (internal post → the assigned vendor; vendor post → the app
 * admins who keep the "Service Notes" notification on).
 *
 * The subject carries a [SVC#<id>] token: replying to this email in any mail
 * client is enough — the notes-inbox cron reads the system mailbox, matches the
 * token, and adds the reply body to the thread. No extra clicks needed.
 */
import { sendNotificationEmail, appBaseUrl } from '@/lib/notifications/send';
import { isNotificationEnabled } from '@/lib/notifications/prefs';
import { listAdmins } from '@/lib/adminAccess';
import type { ServiceNote } from '@/lib/services/serviceNotes';

/** The reply-ingestion token. Kept in the SUBJECT so every reply carries it. */
export function serviceNoteToken(serviceId: string): string {
  return `[SVC#${serviceId}]`;
}
export function parseServiceNoteToken(subject: string): string | null {
  const m = /\[SVC#(\d+)\]/.exec(String(subject || ''));
  return m ? m[1] : null;
}

export interface ServiceNoteEmailContext {
  serviceId: string;
  address: string;          // "105 Sonya Cir, Covington, GA 30016" style
  serviceLabel: string;     // "Landscaping · Grass Cut" style
  vendorEmail: string | null;
  vendorName: string | null;
}

/** Email one note to the other party. Never throws; returns recipients notified. */
export async function notifyServiceNote(note: ServiceNote, ctx: ServiceNoteEmailContext, req?: { headers: Record<string, any> } | null): Promise<string[]> {
  // Route to the other side of the conversation.
  let recipients: string[] = [];
  if (note.role === 'internal') {
    const v = (ctx.vendorEmail || '').trim().toLowerCase();
    if (v && (await isNotificationEnabled(v, 'service_note').catch(() => true))) recipients = [v];
  } else {
    const admins = await listAdmins().catch(() => []);
    const checks = await Promise.all(admins.map(async (a) => {
      const e = a.email.trim().toLowerCase();
      if (e === note.byEmail) return null;                              // don't echo to the poster
      return (await isNotificationEnabled(e, 'service_note').catch(() => true)) ? e : null;
    }));
    recipients = Array.from(new Set(checks.filter((e): e is string => !!e)));
  }
  if (!recipients.length) return [];

  const base = appBaseUrl(req);
  const [to, ...alsoTo] = recipients;
  const r = await sendNotificationEmail({
    to,
    alsoTo,
    subject: `New note on ${ctx.address || 'a service'} ${serviceNoteToken(ctx.serviceId)}`,
    heading: 'New Service Note',
    intro: `${note.byName || note.byEmail} wrote: “${note.text.slice(0, 500)}${note.text.length > 500 ? '…' : ''}” — reply to this email and your reply is added to the note thread automatically.`,
    rows: [
      ['Service', ctx.serviceLabel],
      ['Property', ctx.address],
      ['Vendor', ctx.vendorName || ''],
    ],
    linkUrl: `${base}/services/${ctx.serviceId}`,
    linkLabel: 'View & Reply In ResiWalk',
  });
  if (!r.sent) { console.warn('[svc-notes] notify failed:', r.error); return []; }
  return recipients;
}
