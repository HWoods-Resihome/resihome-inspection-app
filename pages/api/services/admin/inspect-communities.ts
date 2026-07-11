/**
 * GET /api/services/admin/inspect-communities → read-only discovery for the
 * Community object that drives community-scope Services coverage. Returns the
 * Community field catalog, the resolved name property, and the full list of
 * community names (id + name). Admin-gated. Writes nothing.
 *
 * Optional ?catalog=0 drops the field catalog and returns just the community list.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isAppAdmin } from '@/lib/adminAccess';
import { inspectCommunityObject } from '@/lib/hubspot';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  const ok = (await servicesEnabled(email).catch(() => false)) && (await isAppAdmin(email).catch(() => false));
  if (!ok) return res.status(403).json({ error: 'Admin only' });

  const withCatalog = req.query.catalog !== '0' && req.query.catalog !== 'false';
  try {
    const report = await inspectCommunityObject();
    if (report === null) return res.status(200).json({ resolved: false, note: 'Community object not resolvable — set HUBSPOT_COMMUNITY_TYPE_ID or ensure a schema whose name/labels contain "community".' });
    if (!withCatalog) return res.status(200).json({ typeId: report.typeId, nameProp: report.nameProp, count: report.count, communities: report.communities });
    return res.status(200).json(report);
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 400), detail: e?.detail || null });
  }
}
