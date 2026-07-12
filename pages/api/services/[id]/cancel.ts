/**
 * POST /api/services/[id]/cancel — move a service to Canceled. Internal only
 * (press-and-hold on a card, mirroring the inspection cancel). Terminal states
 * (completed/canceled) are left untouched.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isInternalEmail } from '@/lib/userAccess';
import { fetchServiceWorkOrder, patchServiceWorkOrder } from '@/lib/hubspot';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  const ok = (await servicesEnabled(email).catch(() => false)) && isInternalEmail(email);
  if (!ok) return res.status(403).json({ error: 'Internal users only' });

  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'Missing service id' });
  try {
    const rec = await fetchServiceWorkOrder(id).catch(() => null);
    if (rec && ['completed', 'canceled'].includes(String(rec.props.status || ''))) {
      return res.status(200).json({ ok: true, status: rec.props.status }); // already terminal
    }
    const okp = await patchServiceWorkOrder(id, { status: 'canceled' });
    return res.status(200).json({ ok: true, status: 'canceled', preview: !okp });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300), detail: e?.detail || null });
  }
}
