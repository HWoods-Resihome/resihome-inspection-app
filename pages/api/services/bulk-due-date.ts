/**
 * POST /api/services/bulk-due-date — internal-only: change the due date on many
 * services at once. Body: { ids: string[], dueDate: 'YYYY-MM-DD' }. Only editable
 * before submission (estimated / pending / assigned) — submitted / review /
 * completed / canceled are skipped and reported. Records an 'edit' audit per
 * changed order. Returns per-id results.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isInternalEmail } from '@/lib/userAccess';
import { fetchServiceWorkOrder, patchServiceWorkOrder } from '@/lib/hubspot';
import { recordServiceAudit } from '@/lib/services/serviceAudit';

export const config = { maxDuration: 120 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  const ok = (await servicesEnabled(email).catch(() => false)) && isInternalEmail(email);
  if (!ok) return res.status(403).json({ error: 'Internal users only' });

  const b = req.body || {};
  const ids = Array.isArray(b.ids) ? b.ids.map((x: any) => String(x)).filter((x: string) => /^\d+$/.test(x)) : [];
  const dueDate = String(b.dueDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return res.status(400).json({ error: 'dueDate must be YYYY-MM-DD.' });
  if (!ids.length) return res.status(400).json({ error: 'No services selected.' });

  let updated = 0, skipped = 0, failed = 0;
  const results: { id: string; outcome: string }[] = [];
  for (const id of ids) {
    try {
      const rec = await fetchServiceWorkOrder(id);
      if (!rec) { skipped++; results.push({ id, outcome: 'skipped' }); continue; }
      const status = String(rec.props.status || '');
      if (!['estimated', 'pending', 'assigned'].includes(status)) { skipped++; results.push({ id, outcome: 'skipped' }); continue; }
      const from = String(rec.props.due_date || '').slice(0, 10);
      if (from === dueDate) { skipped++; results.push({ id, outcome: 'unchanged' }); continue; }
      await patchServiceWorkOrder(id, { due_date: dueDate });
      void recordServiceAudit({ serviceId: id, action: 'edit', actorEmail: email, actorName: session?.name, detail: `Due date changed (bulk): ${from || '—'} → ${dueDate}` });
      updated++; results.push({ id, outcome: 'updated' });
    } catch { failed++; results.push({ id, outcome: 'failed' }); }
  }
  return res.status(200).json({ ok: true, dueDate, updated, skipped, failed, results });
}
