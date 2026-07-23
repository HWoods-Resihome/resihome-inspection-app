/**
 * Reply-by-email ingestion for service note threads — the shared sweep used by
 * BOTH the notes-inbox cron (background, every minute) and the notes GET
 * endpoint (on-demand when someone opens a thread, throttled), so a reply shows
 * up the moment the thread is viewed instead of waiting for the next cron tick.
 *
 * Sender attribution: assigned vendor email → vendor; internal domain →
 * internal; ANYONE ELSE → 'other' — the note still lands in the thread,
 * attributed to the bare email address (a dropped reply looked like the
 * feature was broken). The [SVC#id] subject token is the routing key.
 */
import { listRecentInbox, getInboundMessage, markMessageRead, stripQuotedReply } from '@/lib/gmailRead';
import { parseServiceNoteToken, notifyServiceNote } from '@/lib/notifications/serviceNote';
import { addServiceNote, clipNoteText, serviceLabelFor, emailNoteExists } from '@/lib/services/serviceNotes';
import { fetchServiceWorkOrder, fetchActiveUsers } from '@/lib/hubspot';
import { isInternalEmail } from '@/lib/userAccess';

export interface SweepResult {
  ok: boolean; ingested: number; skipped: number; reason?: string;
  /** Per-message decisions (only when opts.debug) — for the admin diagnostic. */
  debug?: Array<{ id: string; subject: string; from: string; serviceId: string | null; decision: string }>;
}

// Per-scope throttle so a busy thread doesn't hammer Gmail on every GET.
const _lastSweep = new Map<string, number>();

export async function sweepNotesInbox(opts: { serviceId?: string; max?: number; minIntervalMs?: number; debug?: boolean } = {}): Promise<SweepResult> {
  const key = opts.serviceId || '*';
  const minMs = opts.minIntervalMs ?? 0;
  if (minMs && Date.now() - (_lastSweep.get(key) || 0) < minMs) return { ok: true, ingested: 0, skipped: 0, reason: 'throttled' };
  _lastSweep.set(key, Date.now());
  if (_lastSweep.size > 500) _lastSweep.clear();   // bound memory

  const systemFrom = (process.env.SYSTEM_GMAIL_FROM || '').trim().toLowerCase();
  const debug: NonNullable<SweepResult['debug']> = [];
  const dbg = (id: string, msg: { subject?: string; fromEmail?: string } | null, serviceId: string | null, decision: string) => {
    if (opts.debug) debug.push({ id, subject: msg?.subject || '', from: msg?.fromEmail || '', serviceId, decision });
  };
  let ingested = 0, skipped = 0;
  try {
    // Search a RECENT WINDOW regardless of read state or inbox label — a reply
    // that skipped the inbox (a filter) or got marked read (opened in the shared
    // mailbox) used to be missed forever under `in:inbox is:unread`. The token is
    // matched loosely here (Gmail drops the brackets/#) and RE-VALIDATED per
    // message via parseServiceNoteToken; message-id idempotency stops re-posting.
    const query = 'newer_than:30d subject:SVC';
    const inbox = await listRecentInbox(query, opts.max ?? 30);
    if (!inbox) return { ok: false, ingested, skipped, reason: 'System Gmail not configured (SYSTEM_GMAIL_*).' };

    for (const msgId of inbox.ids) {
      const msg = await getInboundMessage(inbox.token, msgId).catch(() => null);
      if (!msg) { dbg(msgId, null, null, 'fetch-failed'); continue; }
      const serviceId = parseServiceNoteToken(msg.subject);
      // Not a service-note subject, or our own outbound copy → skip.
      if (!serviceId || !msg.fromEmail || msg.fromEmail === systemFrom) {
        await markMessageRead(inbox.token, msgId); skipped++; dbg(msgId, msg, serviceId, !serviceId ? 'no-token' : 'own-outbound'); continue;
      }
      // When invoked for a specific thread, only that service's replies.
      if (opts.serviceId && serviceId !== opts.serviceId) { dbg(msgId, msg, serviceId, 'other-service'); continue; }
      // Idempotency: already ingested this exact reply → never re-post/re-notify.
      if (await emailNoteExists(serviceId, msgId)) { await markMessageRead(inbox.token, msgId); skipped++; dbg(msgId, msg, serviceId, 'already-ingested'); continue; }
      const text = clipNoteText(stripQuotedReply(msg.bodyText));
      if (!text) { await markMessageRead(inbox.token, msgId); skipped++; dbg(msgId, msg, serviceId, 'empty-after-strip'); continue; }

      const rec = await fetchServiceWorkOrder(serviceId).catch(() => null);
      if (!rec) { await markMessageRead(inbox.token, msgId); skipped++; dbg(msgId, msg, serviceId, 'service-not-found'); continue; }
      const p = rec.props;
      const vendorEmail = String(p.vendor_email || '').trim().toLowerCase();

      // Attribute the sender; unknown addresses still post, as themselves.
      const role: 'vendor' | 'internal' | 'other' =
        vendorEmail && msg.fromEmail === vendorEmail ? 'vendor'
          : isInternalEmail(msg.fromEmail) ? 'internal'
            : 'other';
      // Display name: vendor → company name; internal → their user record's
      // full name (cached lookup); anyone else → the bare email address.
      let byName = msg.fromEmail;
      if (role === 'vendor') byName = String(p.vendor_name || '').trim() || msg.fromEmail;
      else if (role === 'internal') {
        const u = (await fetchActiveUsers().catch(() => [])).find((x: any) => String(x.email || '').toLowerCase() === msg.fromEmail);
        if (u?.fullName) byName = u.fullName;
      }

      try {
        const note = await addServiceNote({
          serviceId,
          byEmail: msg.fromEmail,
          byName,
          role,
          source: 'email',
          text,
          srcMsgId: msgId,   // idempotency key — one blob per Gmail reply
        });
        const address = [String(p.address_snapshot || p.community_name || '').trim(), String(p.locality_snapshot || '').trim()]
          .filter(Boolean).join(', ');
        await notifyServiceNote(note, {
          serviceId,
          address,
          serviceLabel: serviceLabelFor(p),
          vendorEmail: vendorEmail || null,
          vendorName: String(p.vendor_name || '').trim() || null,
        });
        ingested++;
        dbg(msgId, msg, serviceId, `ingested (${role})`);
      } catch (e: any) {
        // Storage failure: leave it for the next sweep to retry this message.
        console.warn('[notes-inbox] ingest failed for', msgId, String(e?.message || e).slice(0, 160));
        dbg(msgId, msg, serviceId, `ingest-error: ${String(e?.message || e).slice(0, 80)}`);
        continue;
      }
      await markMessageRead(inbox.token, msgId);
    }
    return { ok: true, ingested, skipped, ...(opts.debug ? { debug } : {}) };
  } catch (e: any) {
    const s = String(e?.message || e);
    if (/gmail_403/.test(s)) {
      console.warn('[notes-inbox] Gmail read scope missing — grant gmail.modify to the system mailbox token to enable reply-by-email.');
      return { ok: false, ingested, skipped, reason: 'Gmail read scope missing — re-mint SYSTEM_GMAIL_REFRESH_TOKEN with gmail.modify.' };
    }
    console.error('[notes-inbox] sweep failed:', e);
    return { ok: false, ingested, skipped, reason: s.slice(0, 200) };
  }
}
