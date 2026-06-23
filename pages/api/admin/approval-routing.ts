/**
 * /api/admin/approval-routing  (admin only)
 *
 *   GET  -> { config, availableRegions }
 *           config = the saved PODs/Regions/RM/Directors structure;
 *           availableRegions = the region matrix's region values (to seed/add
 *           Region cards). Property `region` values are drawn from this matrix,
 *           and it's already cached — far cheaper than paging the 15k+ Property
 *           object, which is past HubSpot Search's 10k cap.
 *   POST -> { ok, config }   body: { config }   (normalized server-side)
 *
 * Drives the future Slack approval-routing on rate-card pending-approval.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { readApprovalRouting, writeApprovalRouting } from '@/lib/hubspot';
import { normalizeApprovalRouting } from '@/lib/approvalRouting';
import { getCachedRegions } from '@/pages/api/rate-card/regions';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.email))) return res.status(403).json({ error: 'Admin only.' });

  try {
    if (req.method === 'GET') {
      const [config, regions] = await Promise.all([
        readApprovalRouting(),
        getCachedRegions().catch(() => []),
      ]);
      const availableRegions = Array.from(new Set(
        regions.map((r) => (r.region || '').trim()).filter(Boolean),
      )).sort((a, b) => a.localeCompare(b));
      return res.status(200).json({ config, availableRegions });
    }
    if (req.method === 'POST') {
      const body = (req.body || {}) as { config?: unknown };
      const clean = normalizeApprovalRouting(body.config);
      await writeApprovalRouting(clean);
      return res.status(200).json({ ok: true, config: clean });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e: any) {
    console.error('[approval-routing] failed:', e);
    return res.status(400).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
