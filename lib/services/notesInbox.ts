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
import { listUnreadInbox, getInboundMessage, markMessageRead, stripQuotedReply } from '@/lib/gmailRead';
import { parseServiceNoteToken, notifyServiceNote } from '@/lib/notifications/serviceNote';
import { addServiceNote, clipNoteText, serviceLabelFor } from '@/lib/services/serviceNotes';
import { fetchServiceWorkOrder } from '@/lib/hubspot';
import { isInternalEmail } from '@/lib/userAccess';

export interface SweepResult { ok: boolean; ingested: number; skipped: number; reason?: string }

// Per-scope throttle so a busy thread doesn't hammer Gmail on every GET.
const _lastSweep = new Map<string, number>();

export async function sweepNotesInbox(opts: { serviceId?: string; max?: number; minIntervalMs?: number } = {}): Promise<SweepResult> {
  const key = opts.serviceId || '*';
  const minMs = opts.minIntervalMs ?? 0;
  if (minMs && Date.now() - (_lastSweep.get(key) || 0) < minMs) return { ok: true, ingested: 0, skipped: 0, reason: 'throttled' };
  _lastSweep.set(key, Date.now());
  if (_lastSweep.size > 500) _lastSweep.clear();   // bound memory

  const systemFrom = (process.env.SYSTEM_GMAIL_FROM || '').trim().toLowerCase();
  let ingested = 0, skipped = 0;
  try {
    const query = opts.serviceId ? `subject:"[SVC#${opts.serviceId}]"` : 'subject:"[SVC#"';
    const inbox = await listUnreadInbox(query, opts.max ?? 20);
    if (!inbox) return { ok: false, ingested, skipped, reason: 'System Gmail not configured (SYSTEM_GMAIL_*).' };

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

      // Attribute the sender; unknown addresses still post, as themselves.
      const role: 'vendor' | 'internal' | 'other' =
        vendorEmail && msg.fromEmail === vendorEmail ? 'vendor'
          : isInternalEmail(msg.fromEmail) ? 'internal'
            : 'other';

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
          serviceLabel: serviceLabelFor(p),
          vendorEmail: vendorEmail || null,
          vendorName: String(p.vendor_name || '').trim() || null,
        });
        ingested++;
      } catch (e: any) {
        // Storage failure: leave UNREAD so the next sweep retries this message.
        console.warn('[notes-inbox] ingest failed for', msgId, String(e?.message || e).slice(0, 160));
        continue;
      }
      await markMessageRead(inbox.token, msgId);
    }
    return { ok: true, ingested, skipped };
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
