/**
 * POST /api/services/bulk-note — internal-only: append the SAME note to many
 * services' threads at once and email each assigned vendor (same as the
 * single-service note). Body: { ids: string[], text: string }. Returns per-id
 * results + how many vendor emails went out.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isInternalEmail } from '@/lib/userAccess';
import { fetchServiceWorkOrder } from '@/lib/hubspot';
import { addServiceNote, clipNoteText, serviceLabelFor } from '@/lib/services/serviceNotes';
import { notifyServiceNote } from '@/lib/notifications/serviceNote';

export const config = { maxDuration: 120 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  const ok = (await servicesEnabled(email).catch(() => false)) && isInternalEmail(email);
  if (!ok) return res.status(403).json({ error: 'Internal users only' });

  const b = req.body || {};
  const ids = Array.isArray(b.ids) ? b.ids.map((x: any) => String(x)).filter((x: string) => /^\d+$/.test(x)) : [];
  const text = clipNoteText(b.text);
  if (!text) return res.status(400).json({ error: 'Note text is required.' });
  if (!ids.length) return res.status(400).json({ error: 'No services selected.' });

  const sessionEmail = String(email).trim().toLowerCase();
  let added = 0, notified = 0, skipped = 0, failed = 0;
  const results: { id: string; outcome: string }[] = [];
  for (const id of ids) {
    try {
      const rec = await fetchServiceWorkOrder(id);
      if (!rec) { skipped++; results.push({ id, outcome: 'skipped' }); continue; }
      const p = rec.props;
      const note = await addServiceNote({
        serviceId: id, byEmail: sessionEmail, byName: session?.name || email || 'Internal',
        role: 'internal', source: 'app', text,
      });
      added++;
      const address = [String(p.address_snapshot || p.community_name || '').trim(), String(p.locality_snapshot || '').trim()].filter(Boolean).join(', ');
      const who = await notifyServiceNote(note, {
        serviceId: id, address, serviceLabel: serviceLabelFor(p),
        vendorEmail: String(p.vendor_email || '').trim() || null,
        vendorName: String(p.vendor_name || '').trim() || null,
      }, req).catch(() => [] as unknown[]);
      if (Array.isArray(who) && who.length) notified += who.length;
      results.push({ id, outcome: 'noted' });
    } catch { failed++; results.push({ id, outcome: 'failed' }); }
  }
  return res.status(200).json({ ok: true, added, notified, skipped, failed, results });
}
