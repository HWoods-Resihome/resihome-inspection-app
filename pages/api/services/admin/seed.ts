/**
 * Seed / teardown the sample services as real Service Work Order records:
 *   GET ?              → dry-run: what would be created
 *   GET ?apply=1       → create the sample records (idempotent, enrollment_key seed:<id>)
 *   GET ?unseed=1      → dry-run: which seed:-tagged records would be deleted
 *   GET ?unseed=1&apply=1 → delete only the seed:-tagged records (teardown)
 * Admin-gated. Dev/demo helper.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isAppAdmin } from '@/lib/adminAccess';
import { seedSampleServiceWorkOrders, unseedSampleServiceWorkOrders } from '@/lib/hubspot';
import { SAMPLE_SERVICES } from '@/lib/services/sampleData';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  const ok = (await servicesEnabled(email).catch(() => false)) && (await isAppAdmin(email).catch(() => false));
  if (!ok) return res.status(403).json({ error: 'Admin only' });

  const apply = req.query.apply === '1' || req.query.apply === 'true';
  const unseed = req.query.unseed === '1' || req.query.unseed === 'true';
  try {
    const result = unseed
      ? await unseedSampleServiceWorkOrders(apply)
      : await seedSampleServiceWorkOrders(apply, SAMPLE_SERVICES);
    return res.status(200).json(result);
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 400), detail: e?.detail || null });
  }
}
