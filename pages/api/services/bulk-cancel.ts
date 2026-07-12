/**
 * POST /api/services/bulk-cancel — internal-only: cancel many services at once.
 * Body: { ids: string[] }. Terminal orders (completed/canceled) are skipped and
 * reported; each canceled order gets a 'cancel' audit event. Returns per-id
 * results. Mirrors the inspection bulk-cancel (long-press multi-select).
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
  if (!ids.length) return res.status(400).json({ error: 'No services selected.' });

  let canceled = 0, skipped = 0, failed = 0;
  const results: { id: string; outcome: string }[] = [];
  for (const id of ids) {
    try {
      const rec = await fetchServiceWorkOrder(id);
      if (rec && ['completed', 'canceled'].includes(String(rec.props.status || ''))) { skipped++; results.push({ id, outcome: 'skipped' }); continue; }
      await patchServiceWorkOrder(id, { status: 'canceled' });
      void recordServiceAudit({ serviceId: id, action: 'cancel', actorEmail: email, actorName: session?.name, detail: 'Service canceled (bulk)' });
      canceled++; results.push({ id, outcome: 'canceled' });
    } catch { failed++; results.push({ id, outcome: 'failed' }); }
  }
  return res.status(200).json({ ok: true, canceled, skipped, failed, results });
}
