/**
 * POST /api/services/[id]/edit-pricing — internal admins correct the vendor cost
 * and/or markup on a service order in ANY status. Client cost is recomputed from
 * the two. Records an audit entry.
 *
 * Deliberately does NOT re-notify the vendor: this is a back-office billing
 * correction, not a status change. The service PDFs are rendered live from the
 * record on every open (GET /api/services/[id]/pdf), so they reflect the new
 * pricing immediately — no stored PDF to regenerate, and no new email.
 *
 * Body: { vendorCost: number, markupPct: number }
 * INTERNAL only.
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
  if (!ok) return res.status(403).json({ error: 'Internal admins only' });

  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'Missing service id' });
  const b = req.body || {};
  const vendorCost = Number(b.vendorCost);
  const markupPct = Number(b.markupPct);
  if (!Number.isFinite(vendorCost) || vendorCost < 0) return res.status(400).json({ error: 'vendorCost must be a non-negative number.' });
  if (!Number.isFinite(markupPct) || markupPct < 0) return res.status(400).json({ error: 'markupPct must be a non-negative number.' });

  try {
    const rec = await fetchServiceWorkOrder(id);
    if (!rec) return res.status(200).json({ ok: true, preview: true }); // object not configured
    const p = rec.props;

    const vc = Math.round(vendorCost * 100) / 100;
    const mk = Math.round(markupPct * 100) / 100;
    const clientCost = Math.round(vc * (1 + mk / 100) * 100) / 100;
    const prevVc = Number(p.vendor_cost) || 0;
    const prevMk = Number(p.markup_pct) || 0;

    await patchServiceWorkOrder(id, { vendor_cost: vc, markup_pct: mk, client_cost: clientCost });
    void recordServiceAudit({
      serviceId: id, action: 'price_edit', actorEmail: email, actorName: session?.name,
      detail: `Pricing edited (status ${String(p.status || '?')}): vendor ${prevVc} → ${vc}, markup ${prevMk}% → ${mk}% (client ${clientCost}). No vendor re-notification.`.slice(0, 500),
      meta: { vendorCost: vc, markupPct: mk, clientCost },
    });
    return res.status(200).json({ ok: true, id, vendorCost: vc, markupPct: mk, clientCost });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300), detail: e?.detail || null });
  }
}
