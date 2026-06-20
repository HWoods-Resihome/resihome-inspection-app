import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { readFinalizeJobs } from '@/lib/finalizeJobs';

/**
 * GET /api/admin/finalize-jobs?days=7
 *
 * Operational visibility into the finalize pipeline. Lists recent finalize
 * attempts and highlights the ones that need attention: `failed` (threw
 * mid-pipeline) and `stuck` (started but never reached a terminal state — the
 * function timed out or the instance died, likely leaving work half-done).
 *
 * Re-POSTing /api/inspections/[id]/finalize is the retry: it's idempotent and
 * resumable (per-step stamps skip already-done outbound side effects), so an
 * operator can clear a failed/stuck attempt by simply finalizing again.
 *
 * Gated to @resihome.com staff. Read-only.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.email))) return res.status(403).json({ error: 'Admin only.' });
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const days = Math.max(1, Math.min(90, Number(req.query.days) || 7));
    const jobs = await readFinalizeJobs(days);
    const needsAttention = jobs.filter((j) => j.status === 'failed' || j.stuck);
    return res.status(200).json({
      days,
      counts: {
        total: jobs.length,
        succeeded: jobs.filter((j) => j.status === 'succeeded').length,
        failed: jobs.filter((j) => j.status === 'failed').length,
        stuck: jobs.filter((j) => j.stuck).length,
      },
      needsAttention,
      jobs,
    });
  } catch (e: any) {
    console.error('[finalize-jobs] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
