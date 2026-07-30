/**
 * POST /api/services/[id]/eta — set the vendor's ESTIMATED COMPLETION DATE (the
 * date they expect to finish the work order). Optional field, auto-saved from the
 * record's date picker. Settable by the ASSIGNED VENDOR (their own order) or any
 * internal user, while the order is still open (estimated / pending / assigned).
 * Body: { date: 'YYYY-MM-DD' | '' }  ('' clears it). Records an 'edit' audit event.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesViewerAllowed, resolveServiceViewerAsync } from '@/lib/services/scopeServer';
import { serviceVisibleTo } from '@/lib/services/scope';
import type { ServiceRecord } from '@/lib/services/model';
import { fetchServiceWorkOrder, patchServiceWorkOrder, ensureServiceEtaProp } from '@/lib/hubspot';
import { recordServiceAudit } from '@/lib/services/serviceAudit';

const OPEN_STATES = ['estimated', 'pending', 'assigned', ''];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  if (!(await servicesViewerAllowed(email).catch(() => false))) return res.status(403).json({ error: 'Not authorized' });

  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'Missing service id' });

  const raw = String((req.body || {}).date || '').slice(0, 10);
  const date = raw === '' ? '' : raw;
  if (date !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD or empty.' });

  try {
    const rec = await fetchServiceWorkOrder(id);
    if (!rec) return res.status(200).json({ ok: true, preview: true });
    const p = rec.props;
    // Ownership: a vendor may only set it on an order assigned to THEM (internal
    // users see all). Same check the submit/covered routes use.
    const viewer = await resolveServiceViewerAsync(session, req);
    if (!viewer.canSeeAll && !serviceVisibleTo(
      { vendor: p.vendor_name || null, vendorEmail: String(p.vendor_email || '').trim() || null } as ServiceRecord,
      viewer,
    )) {
      return res.status(403).json({ error: 'Not authorized for this service.' });
    }
    const status = String(p.status || '');
    if (!OPEN_STATES.includes(status)) {
      return res.status(409).json({ error: `This service is ${status} — the estimated completion date is locked.` });
    }
    const from = String(p.estimated_completion_date || '').slice(0, 10);
    if (from === date) return res.status(200).json({ ok: true, id, date, unchanged: true });

    // The property is new — make sure it exists before writing to it.
    if (!(await ensureServiceEtaProp().catch(() => false))) {
      return res.status(503).json({ error: 'Estimated-completion-date field is not provisioned yet — try again in a moment.' });
    }
    await patchServiceWorkOrder(id, { estimated_completion_date: date });
    void recordServiceAudit({
      serviceId: id, action: 'edit', actorEmail: email, actorName: session?.name,
      detail: date ? `Estimated completion date set: ${from || '—'} → ${date}` : `Estimated completion date cleared (was ${from || '—'})`,
    });
    return res.status(200).json({ ok: true, id, date });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300), detail: e?.detail || null });
  }
}
