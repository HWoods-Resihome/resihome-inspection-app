/**
 * POST /api/services/rules/save — Phase 3: persist a Service Rule to HubSpot.
 * Body: { recordId?: string, props: Record<string, any> }. Admin-gated. Returns
 * { id } (create or update), or { preview: true } when the object isn't configured.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isAppAdmin } from '@/lib/adminAccess';
import { upsertServiceRuleRecord, deleteServiceRuleRecord } from '@/lib/hubspot';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  const ok = (await servicesEnabled(email).catch(() => false)) && (await isAppAdmin(email).catch(() => false));
  if (!ok) return res.status(403).json({ error: 'Admin only' });

  const { recordId, props, delete: del } = req.body || {};
  try {
    if (del && recordId) { await deleteServiceRuleRecord(recordId); return res.status(200).json({ ok: true, deleted: true }); }
    if (!props || typeof props !== 'object') return res.status(400).json({ error: 'props required' });
    const id = await upsertServiceRuleRecord(recordId || null, props);
    return res.status(200).json({ ok: true, id, preview: !id });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300), detail: e?.detail || null });
  }
}
