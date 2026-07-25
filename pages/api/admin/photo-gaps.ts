/**
 * /api/admin/photo-gaps  (admin session, or CRON bearer)
 *
 * Finds inspection questions that REQUIRE a photo but have NONE on a completed
 * inspection — the "we lost the photo" evidence gap. The photo requirement is a
 * per-question Form-Builder flag (`requires_photo`); this mirrors the exact
 * QuestionForm submit gate — a requires-photo question that's ANSWERED (non-N/A)
 * with no photo, plus a required `photo_only` question with no photo. So a row
 * here is a photo the record is missing that it was supposed to have.
 *
 *   ?id=<inspectionId>
 *     → gaps for ONE inspection (answers "which photo did we lose on X?").
 *   ?limit=N & ?templates=a,b
 *     → scan the most-recent COMPLETED inspections and list every one with ≥1
 *       missing required photo (default 200, cap 500). Optional `templates`
 *       filters to specific template_type values.
 *
 * Read-only. This is DETECTION, not recovery — a photo that never persisted
 * can't be reconstructed; the point is to surface the gaps so QC can send those
 * inspections back / re-inspect instead of the loss going unnoticed.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { fetchInspectionById, searchInspectionsPage } from '@/lib/hubspot';
import type { Question } from '@/lib/types';
import { questionMapForTemplate, photoGapsForInspection, type PhotoGap } from '@/lib/photoGaps';

export const config = { maxDuration: 300 };

type Gap = PhotoGap;
const questionMapFor = questionMapForTemplate;
const gapsFor = photoGapsForInspection;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Auth: admin session, or the CRON bearer for scheduled/automated scans.
  const cronOk = !!process.env.CRON_SECRET
    && (req.headers.authorization || '') === `Bearer ${process.env.CRON_SECRET}`;
  if (!cronOk) {
    const session = await getSessionFromRequest(req);
    if (!session) return res.status(401).json({ error: 'Not authenticated' });
    if (!(await isAppAdmin(session.email))) return res.status(403).json({ error: 'Admin only.' });
  }

  const cache = new Map<string, Map<string, Question>>();

  try {
    // ---- Single inspection ----
    const id = typeof req.query.id === 'string' ? req.query.id.trim() : '';
    if (id) {
      const insp = await fetchInspectionById(id);
      if (!insp) return res.status(404).json({ error: 'Inspection not found' });
      const qMap = await questionMapFor(insp.templateType, cache);
      const gaps = await gapsFor(id, qMap);
      return res.status(200).json({
        inspectionId: id,
        address: insp.propertyAddressSnapshot || insp.inspectionName || '',
        templateType: insp.templateType,
        status: insp.status,
        completedAt: insp.completedAt,
        gapCount: gaps.length,
        gaps,
      });
    }

    // ---- Scan recent completed inspections ----
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
    const templates = typeof req.query.templates === 'string' && req.query.templates
      ? req.query.templates.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
    const pageSize = 100;
    const rows: Array<{ inspectionId: string; address: string; templateType: string; completedAt: string | null; gapCount: number; gaps: Gap[] }> = [];
    let scanned = 0;
    let page = 1;
    while (scanned < limit) {
      const { items } = await searchInspectionsPage({
        status: 'completed', templates, sortField: 'updated', sortDir: 'desc', page, pageSize,
      });
      if (items.length === 0) break;
      for (const it of items) {
        if (scanned >= limit) break;
        scanned++;
        const qMap = await questionMapFor(it.templateType, cache);
        const gaps = await gapsFor(it.recordId, qMap);
        if (gaps.length > 0) {
          rows.push({
            inspectionId: it.recordId,
            address: it.propertyAddressSnapshot || it.inspectionName || '',
            templateType: it.templateType,
            completedAt: it.completedAt,
            gapCount: gaps.length,
            gaps,
          });
        }
      }
      if (items.length < pageSize) break;
      page++;
    }
    return res.status(200).json({ scanned, withGaps: rows.length, rows });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
