/**
 * /api/insights/approver-nte
 *
 *   GET  -> { thresholds, approvers }   (canView: admin OR Insights-Only)
 *           thresholds = { approverName: $ }; approvers = distinct names seen in
 *           the snapshot's Approved-By data (so the UI can list current names).
 *   POST -> { ok, thresholds }          (app-admin only)   body: { thresholds }
 *
 * Per-approver not-to-exceed ceilings for the scope-approvals card. Stored as
 * JSON on the admin Agent record (readApproverNte/writeApproverNte).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { canViewInsights } from '@/lib/insightsAccess';
import { readApproverNte, writeApproverNte, type ApproverNteMap } from '@/lib/hubspot';
import { readInsightsSnapshot } from '@/lib/insightsSnapshot';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await canViewInsights(session.email))) return res.status(403).json({ error: 'Insights access required.' });

  try {
    if (req.method === 'GET') {
      const [thresholds, snap] = await Promise.all([readApproverNte(), readInsightsSnapshot()]);
      // Distinct approver names from the snapshot (Scope rows with an approver).
      const approvers = Array.from(new Set(
        (snap?.rows || [])
          .map((r) => (r.approverName || '').trim())
          .filter(Boolean),
      )).sort((a, b) => a.localeCompare(b));
      return res.status(200).json({ thresholds, approvers });
    }
    if (req.method === 'POST') {
      if (!(await isAppAdmin(session.email))) return res.status(403).json({ error: 'Admin only.' });
      const body = (req.body || {}) as { thresholds?: Record<string, unknown> };
      const clean: ApproverNteMap = {};
      for (const [k, v] of Object.entries(body.thresholds || {})) {
        const n = Number(v);
        if (k && Number.isFinite(n) && n > 0) clean[k.trim()] = n;
      }
      await writeApproverNte(clean);
      return res.status(200).json({ ok: true, thresholds: clean });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e: any) {
    console.error('[approver-nte] failed:', e);
    return res.status(400).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
