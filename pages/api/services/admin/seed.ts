/**
 * GET /api/services/admin/seed          → dry-run (lists what it would create)
 * GET /api/services/admin/seed?apply=1   → writes the sample services as real
 *                                          Service Work Order records
 *
 * Dev/demo helper so you can watch the Services surface flip to Live without
 * hand-entering records. Idempotent (enrollment_key = seed:<id>). Admin-gated.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isAppAdmin } from '@/lib/adminAccess';
import { seedSampleServiceWorkOrders } from '@/lib/hubspot';
import { SAMPLE_SERVICES } from '@/lib/services/sampleData';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  const ok = (await servicesEnabled(email).catch(() => false)) && (await isAppAdmin(email).catch(() => false));
  if (!ok) return res.status(403).json({ error: 'Admin only' });

  const apply = req.query.apply === '1' || req.query.apply === 'true';
  try {
    return res.status(200).json(await seedSampleServiceWorkOrders(apply, SAMPLE_SERVICES));
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 400), detail: e?.detail || null });
  }
}
