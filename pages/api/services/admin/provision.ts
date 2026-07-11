/**
 * GET /api/services/admin/provision            → dry-run (default, read-only)
 * GET /api/services/admin/provision?apply=1     → apply (creates the schema)
 *
 * Phase 0 provisioner for ResiWalk - Services. Additive-only: creates the two
 * custom objects (Service, Service Rules Engine), their properties, the additive
 * Question properties, and labeled associations. Admin-gated; runs against the
 * PROD HubSpot the preview is pointed at. Dry-run writes nothing.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isAppAdmin } from '@/lib/adminAccess';
import { provisionServicesSchema } from '@/lib/hubspot';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  const ok = (await servicesEnabled(email).catch(() => false)) && (await isAppAdmin(email).catch(() => false));
  if (!ok) return res.status(403).json({ error: 'Admin only' });

  const apply = req.query.apply === '1' || req.query.apply === 'true';
  try {
    const report = await provisionServicesSchema(apply);
    return res.status(200).json(report);
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 400), mode: apply ? 'apply' : 'dry-run' });
  }
}
