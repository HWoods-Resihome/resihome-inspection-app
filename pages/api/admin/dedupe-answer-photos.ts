/**
 * GET /api/admin/dedupe-answer-photos — one-time cleanup for the old photo
 * duplication. Rewrites inspection_answer records whose photo_urls /
 * after_photo_urls hold duplicate URLs down to their de-duplicated set.
 *
 * Admin-only. DRY-RUN by default (reports what it would change, writes nothing);
 * add &apply=1 to perform the rewrite. Scope to one inspection with
 * &inspection=<recordId> to test small first; omit to scan all answers with photos.
 *
 *   Dry run, one inspection:  /api/admin/dedupe-answer-photos?inspection=<id>
 *   Apply, one inspection:    /api/admin/dedupe-answer-photos?inspection=<id>&apply=1
 *   Apply, everything:        /api/admin/dedupe-answer-photos?apply=1
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { dedupeAnswerPhotos } from '@/lib/hubspot';

export const config = { maxDuration: 300 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email || !(await isAppAdmin(session.email).catch(() => false))) {
    return res.status(403).json({ error: 'Admin only' });
  }
  const apply = req.query.apply === '1' || req.query.apply === 'true';
  const inspection = typeof req.query.inspection === 'string' ? req.query.inspection.trim() : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  try {
    const report = await dedupeAnswerPhotos({ apply, inspectionId: inspection || undefined, limit });
    return res.status(200).json({
      ...report,
      note: apply ? 'Applied. Re-run without &apply=1 anytime to confirm 0 remaining.' : 'DRY RUN — nothing written. Add &apply=1 to rewrite.',
    });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
