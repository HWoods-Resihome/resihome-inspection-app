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

// Shared services inbox: every INBOUND note (a vendor — or anyone — replying to
// a note email, or posting from their end) is also copied here so the whole team
// has a record and can jump in. Overridable via env; defaults to the group box.
const SERVICE_NOTES_INBOX = (process.env.SERVICE_NOTES_INBOX || 'services@resihome.com').trim().toLowerCase();

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
    // INBOUND note (vendor reply / vendor-side post): notify the admins who
    // keep the alert on, AND always copy the shared services inbox so the team
    // has one thread of record. The inbox is included even if no admin wants
    // the per-user alert.
    const admins = await listAdmins().catch(() => []);
    const checks = await Promise.all(admins.map(async (a) => {
      const e = a.email.trim().toLowerCase();
      if (e === note.byEmail) return null;                              // don't echo to the poster
      return (await isNotificationEnabled(e, 'service_note').catch(() => true)) ? e : null;
    }));
    const set = new Set(checks.filter((e): e is string => !!e));
    if (SERVICE_NOTES_INBOX && SERVICE_NOTES_INBOX !== note.byEmail) set.add(SERVICE_NOTES_INBOX);
    recipients = Array.from(set);
  }
  if (!recipients.length) return [];

  const base = appBaseUrl(req);
  const [to, ...alsoTo] = recipients;
  const r = await sendNotificationEmail({
    to,
    alsoTo,
    subject: `New note on ${ctx.address || 'a service'} ${serviceNoteToken(ctx.serviceId)}`,
    heading: 'New Service Note',
    intro: `${note.byName || note.byEmail} added a note — reply to this email and your reply is added to the note thread automatically.`,
    // The note itself is the star — its own highlighted block under the intro.
    callout: note.text.slice(0, 1500) + (note.text.length > 1500 ? '…' : ''),
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
