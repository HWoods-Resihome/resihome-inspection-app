/**
 * POST /api/services/[id]/due-date — internal-only: change a service's due date
 * (e.g. push it out on vendor feedback). Body: { dueDate: 'YYYY-MM-DD' }. Terminal
 * orders (completed/canceled) are refused. Records an 'edit' audit event.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isInternalEmail } from '@/lib/userAccess';
import { fetchServiceWorkOrder, patchServiceWorkOrder } from '@/lib/hubspot';
import { recordServiceAudit } from '@/lib/services/serviceAudit';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  const ok = (await servicesEnabled(email).catch(() => false)) && isInternalEmail(email);
  if (!ok) return res.status(403).json({ error: 'Internal users only' });

  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'Missing service id' });

  const dueDate = String((req.body || {}).dueDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return res.status(400).json({ error: 'dueDate must be YYYY-MM-DD.' });

  try {
    const rec = await fetchServiceWorkOrder(id);
    if (!rec) return res.status(200).json({ ok: true, preview: true });
    const status = String(rec.props.status || '');
    // Only editable before submission — once submitted/review/completed/canceled
    // the due window is settled.
    if (!['estimated', 'assigned'].includes(status)) return res.status(409).json({ error: `This service is ${status} — its due date can’t be changed.` });
    const from = String(rec.props.due_date || '').slice(0, 10);
    if (from === dueDate) return res.status(200).json({ ok: true, id, dueDate, unchanged: true });

    await patchServiceWorkOrder(id, { due_date: dueDate });
    void recordServiceAudit({ serviceId: id, action: 'edit', actorEmail: email, actorName: session?.name, detail: `Due date changed: ${from || '—'} → ${dueDate}` });
    return res.status(200).json({ ok: true, id, dueDate });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300), detail: e?.detail || null });
  }
}
