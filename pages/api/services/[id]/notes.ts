/**
 * /api/services/[id]/notes — the per-work-order note thread (vendor ↔ internal).
 *
 *  GET  → { notes } oldest-first.
 *  POST { text } → appends a note and emails it to the other party (internal
 *        post → the assigned vendor; vendor post → app admins with the
 *        "Service Notes" notification on). The email's subject carries the
 *        [SVC#id] token, so a plain reply lands back in this thread via the
 *        notes-inbox cron.
 *
 * Access: internal users, or the ASSIGNED vendor (session email must match the
 * work order's vendor_email). The View-As-Vendor preview is an internal session,
 * so it reads/writes as internal.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isInternalEmail } from '@/lib/userAccess';
import { fetchServiceWorkOrder } from '@/lib/hubspot';
import { addServiceNote, readServiceNotes, clipNoteText, serviceLabelFor } from '@/lib/services/serviceNotes';
import { notifyServiceNote } from '@/lib/notifications/serviceNote';
import { sweepNotesInbox } from '@/lib/services/notesInbox';

export const config = { maxDuration: 30 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
  const id = String(req.query.id || '');
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Missing service id' });

  const rec = await fetchServiceWorkOrder(id).catch(() => null);
  if (!rec) return res.status(404).json({ error: 'Service not found' });
  const p = rec.props;
  const vendorEmail = String(p.vendor_email || '').trim().toLowerCase();
  const sessionEmail = String(session.email).trim().toLowerCase();

  const isVendorSession = !!session.vendor;
  const internal = !isVendorSession && isInternalEmail(session.email);
  // Assigned = email match, or (legacy name-only stamps) company-name match.
  const vendorNameStamp = String(p.vendor_name || '').trim().toLowerCase();
  const isAssignedVendor = isVendorSession && (
    (!!vendorEmail && sessionEmail === vendorEmail)
    || (!vendorEmail && !!vendorNameStamp && vendorNameStamp === String(session.name || '').trim().toLowerCase())
  );
  if (!internal && !isAssignedVendor) return res.status(403).json({ error: 'Not your work order.' });

  if (req.method === 'GET') {
    // On-demand ingestion: pull any unread email replies for THIS service in
    // before reading the thread, so opening (or pull-refreshing) a service
    // shows replies near-real-time instead of waiting for the cron tick.
    // Throttled per service; failures degrade to the plain read.
    const sweep = await sweepNotesInbox({ serviceId: id, max: 10, minIntervalMs: 15_000 }).catch(() => null);
    const notes = await readServiceNotes(id);
    // Surface a hard ingestion blocker (missing Gmail read scope / not
    // configured) so the UI can tell an internal user why replies won't sync.
    const inboxError = sweep && !sweep.ok ? sweep.reason || 'unknown' : null;
    return res.status(200).json({ notes, ...(inboxError ? { inboxError } : {}) });
  }

  if (req.method === 'POST') {
    const text = clipNoteText((req.body || {}).text);
    if (!text) return res.status(400).json({ error: 'Note text is required.' });
    try {
      const note = await addServiceNote({
        serviceId: id,
        byEmail: sessionEmail,
        byName: session.name || session.email,
        role: internal ? 'internal' : 'vendor',
        source: 'app',
        text,
      });
      const address = [String(p.address_snapshot || p.community_name || '').trim(), String(p.locality_snapshot || '').trim()]
        .filter(Boolean).join(', ');
      const serviceLabel = serviceLabelFor(p);
      const notified = await notifyServiceNote(note, {
        serviceId: id,
        address,
        serviceLabel,
        vendorEmail: vendorEmail || null,
        vendorName: String(p.vendor_name || '').trim() || null,
      }, req);
      return res.status(200).json({ ok: true, note, notified: notified.length });
    } catch (e: any) {
      return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
