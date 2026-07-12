/**
 * GET /api/services/admin/inspect
 *
 * Read-only. Reports every existing HubSpot custom object whose name/label
 * mentions "service" — objectTypeId, labels, created date, property + RECORD
 * count — so we can see what the pre-existing "Service" object is before
 * deciding whether it's safe to delete. Writes nothing. Admin-gated.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isAppAdmin } from '@/lib/adminAccess';
import { inspectServiceLikeObjects } from '@/lib/hubspot';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  const ok = (await servicesEnabled(email).catch(() => false)) && (await isAppAdmin(email).catch(() => false));
  if (!ok) return res.status(403).json({ error: 'Admin only' });
  try {
    return res.status(200).json(await inspectServiceLikeObjects());
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 400), detail: e?.detail || null });
  }
}
