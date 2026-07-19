/**
 * GET /api/cron/notes-inbox — ingest email REPLIES into service note threads.
 *
 * Every service-note email carries a [SVC#<id>] subject token. When someone
 * replies from their mail client, the reply lands in the SYSTEM mailbox; this
 * sweep (every 2 min via Vercel Cron) finds unread inbox messages carrying the
 * token, strips the quoted history, appends the fresh text to that service's
 * note thread as the sender, notifies the other party, and marks the message
 * read. Sender attribution: the work order's assigned vendor email → vendor
 * note; an internal email → internal note; anyone else is ignored (marked read
 * so it isn't re-scanned).
 *
 * Requires the system Gmail token to carry a READ scope (gmail.modify). Without
 * it the sweep logs the 403 and no-ops — in-app notes keep working.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { listUnreadInbox, getInboundMessage, markMessageRead, stripQuotedReply } from '@/lib/gmailRead';
import { parseServiceNoteToken, notifyServiceNote } from '@/lib/notifications/serviceNote';
import { addServiceNote, clipNoteText } from '@/lib/services/serviceNotes';
import { fetchServiceWorkOrder } from '@/lib/hubspot';
import { isInternalEmail } from '@/lib/userAccess';

export const config = { maxDuration: 60 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return res.status(200).json({ ok: true, skipped: true, reason: 'CRON_SECRET not configured.' });
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : (typeof req.query.key === 'string' ? req.query.key : '');
  if (provided !== secret) return res.status(401).json({ error: 'Unauthorized' });

  const systemFrom = (process.env.SYSTEM_GMAIL_FROM || '').trim().toLowerCase();
  let ingested = 0, skipped = 0;
  try {
    const inbox = await listUnreadInbox('subject:"[SVC#"', 20);
    if (!inbox) return res.status(200).json({ ok: true, skipped: true, reason: 'System Gmail not configured.' });

    for (const msgId of inbox.ids) {
      const msg = await getInboundMessage(inbox.token, msgId).catch(() => null);
      if (!msg) continue;
      const serviceId = parseServiceNoteToken(msg.subject);
      // Not ours / our own outbound copy → mark read so it never re-scans.
      if (!serviceId || !msg.fromEmail || msg.fromEmail === systemFrom) {
        await markMessageRead(inbox.token, msgId); skipped++; continue;
      }
      const text = clipNoteText(stripQuotedReply(msg.bodyText));
      if (!text) { await markMessageRead(inbox.token, msgId); skipped++; continue; }

      const rec = await fetchServiceWorkOrder(serviceId).catch(() => null);
      if (!rec) { await markMessageRead(inbox.token, msgId); skipped++; continue; }
      const p = rec.props;
      const vendorEmail = String(p.vendor_email || '').trim().toLowerCase();

      // Attribute the sender — assigned vendor, or an internal address. Anyone
      // else (forwards, strangers) is dropped: the thread is a two-party channel.
      let role: 'vendor' | 'internal' | null = null;
      if (vendorEmail && msg.fromEmail === vendorEmail) role = 'vendor';
      else if (isInternalEmail(msg.fromEmail)) role = 'internal';
      if (!role) { await markMessageRead(inbox.token, msgId); skipped++; continue; }

      try {
        const note = await addServiceNote({
          serviceId,
          byEmail: msg.fromEmail,
          byName: role === 'vendor' ? (String(p.vendor_name || '').trim() || msg.fromEmail) : msg.fromEmail,
          role,
          source: 'email',
          text,
        });
        const address = [String(p.address_snapshot || p.community_name || '').trim(), String(p.locality_snapshot || '').trim()]
          .filter(Boolean).join(', ');
        await notifyServiceNote(note, {
          serviceId,
          address,
          serviceLabel: [String(p.worktype || '').trim(), String(p.subtype || '').trim()].filter(Boolean).join(' · '),
          vendorEmail: vendorEmail || null,
          vendorName: String(p.vendor_name || '').trim() || null,
        }, req);
        ingested++;
      } catch (e: any) {
        // Storage failure: leave UNREAD so the next sweep retries this message.
        console.warn('[notes-inbox] ingest failed for', msgId, String(e?.message || e).slice(0, 160));
        continue;
      }
      await markMessageRead(inbox.token, msgId);
    }
    return res.status(200).json({ ok: true, ingested, skipped });
  } catch (e: any) {
    const s = String(e?.message || e);
    // Missing read scope reads as gmail_403 — surface a clear one-line reason.
    if (/gmail_403/.test(s)) {
      console.warn('[notes-inbox] Gmail read scope missing — grant gmail.modify to the system mailbox token to enable reply-by-email.');
      return res.status(200).json({ ok: true, skipped: true, reason: 'Gmail read scope missing (grant gmail.modify to SYSTEM_GMAIL_REFRESH_TOKEN).' });
    }
    console.error('[cron/notes-inbox] failed:', e);
    return res.status(500).json({ error: s.slice(0, 300) });
  }
}
