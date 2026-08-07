/**
 * POST /api/services/bulk-price — internal-only: set the VENDOR COST on many
 * services at once. Body: { ids: string[], vendorCost: number }. Each service
 * KEEPS its own markup % (client cost recomputed = cost × (1 + markup/100)), so
 * a bulk price fix doesn't flatten differing markups. Mirrors the single
 * edit-pricing endpoint (no vendor re-notification — billing correction) and
 * records a 'price_edit' audit per changed order. Terminal orders
 * (completed/canceled) are skipped. Returns per-id results.
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
  const vendorCost = Number(b.vendorCost);
  if (!Number.isFinite(vendorCost) || vendorCost < 0) return res.status(400).json({ error: 'vendorCost must be a non-negative number.' });
  if (!ids.length) return res.status(400).json({ error: 'No services selected.' });

  const vc = Math.round(vendorCost * 100) / 100;
  let updated = 0, skipped = 0, failed = 0;
  const results: { id: string; outcome: string }[] = [];
  for (const id of ids) {
    try {
      const rec = await fetchServiceWorkOrder(id);
      if (!rec) { skipped++; results.push({ id, outcome: 'skipped' }); continue; }
      const p = rec.props;
      if (['completed', 'canceled'].includes(String(p.status || ''))) { skipped++; results.push({ id, outcome: 'skipped' }); continue; }
      const mk = Math.round((Number(p.markup_pct) || 0) * 100) / 100; // keep each service's own markup
      const clientCost = Math.round(vc * (1 + mk / 100) * 100) / 100;
      const prevVc = Number(p.vendor_cost) || 0;
      if (prevVc === vc) { skipped++; results.push({ id, outcome: 'unchanged' }); continue; }
      await patchServiceWorkOrder(id, { vendor_cost: vc, client_cost: clientCost });
      void recordServiceAudit({
        serviceId: id, action: 'price_edit', actorEmail: email, actorName: session?.name,
        detail: `Vendor cost edited (bulk, status ${String(p.status || '?')}): ${prevVc} → ${vc} (markup ${mk}% kept, client ${clientCost}). No vendor re-notification.`.slice(0, 500),
        meta: { vendorCost: vc, markupPct: mk, clientCost },
      });
      updated++; results.push({ id, outcome: 'updated' });
    } catch { failed++; results.push({ id, outcome: 'failed' }); }
  }
  return res.status(200).json({ ok: true, vendorCost: vc, updated, skipped, failed, results });
}
