/**
 * GET /api/services/admin/purge                 → dry-run (default): lists what would delete
 * GET /api/services/admin/purge?apply=1          → apply: DELETES the targeted Service Work Orders
 *
 * Teardown for staging/test Service Work Orders. Admin-gated; PROD HubSpot via the
 * preview. Default scope is TEST data only (generated `gen:*` + seeded `seed:*`
 * enrollment keys). Use &scope= to target others:
 *   scope=generated  → only rule-generated orders (gen:*)
 *   scope=seeded     → only seeded sample orders (seed:*)
 *   scope=test       → both (default)
 *   scope=all        → EVERY Service Work Order (includes manually-created ones)
 * Always dry-run first and review `wouldDelete` before adding ?apply=1.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isAppAdmin } from '@/lib/adminAccess';
import { purgeServiceWorkOrders } from '@/lib/hubspot';

export const config = { maxDuration: 120 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  const ok = (await servicesEnabled(email).catch(() => false)) && (await isAppAdmin(email).catch(() => false));
  if (!ok) return res.status(403).json({ error: 'Admin only' });

  const apply = req.query.apply === '1' || req.query.apply === 'true';
  const raw = String(req.query.scope || 'test');
  const scope = (['generated', 'seeded', 'test', 'all'] as const).includes(raw as any) ? (raw as 'generated' | 'seeded' | 'test' | 'all') : 'test';
  try {
    const report = await purgeServiceWorkOrders(apply, scope);
    return res.status(200).json(report);
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 400), detail: e?.detail || null, mode: apply ? 'apply' : 'dry-run' });
  }
}
