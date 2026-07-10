/**
 * GET /api/admin/inspect-line-photos?id=<inspectionRecordId>
 *
 * Read-only diagnostic for the "After photos are required on every Internal
 * Resolution line" finalize block. For the given inspection it dumps, per
 * rate-card line: assigned vendor, whether it's Internal Resolution, its
 * before/after photo counts, and its Complete Now/Later timing — then replays
 * the exact finalize gate so you can see WHICH lines it would flag and why.
 *
 * Admin only. Changes nothing. Use it when finalize blocks on after-photos that
 * appear to exist: it shows whether the photos landed in after_photo_urls (what
 * the gate checks) vs photo_urls (regular), and whether the answer's assigned_to
 * actually reads as Internal Resolution.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import {
  fetchInspectionById, fetchAnswersForInspection, answerHasAfterPhotoProperty,
} from '@/lib/hubspot';
import { isInternalResolution } from '@/lib/vendors';

export const config = { maxDuration: 120 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.email))) return res.status(403).json({ error: 'Admin only.' });

  const id = String(req.query.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Pass ?id=<inspection record id>' });

  try {
    const [insp, answers, afterPropExists] = await Promise.all([
      fetchInspectionById(id).catch(() => null),
      fetchAnswersForInspection(id),
      answerHasAfterPhotoProperty(),
    ]);

    // The Complete-Later set the finalize gate honors (persisted at submit).
    const laterLineIds = new Set<string>();
    try {
      const raw = JSON.parse(insp?.resolutionTimingJson || '{}');
      if (raw && typeof raw === 'object') {
        for (const [extId, v] of Object.entries(raw)) if (v === 'later') laterLineIds.add(extId);
      }
    } catch { /* ignore malformed */ }

    const lines = answers
      .filter((a) => a.answerType === 'rate_card_line')
      .map((a) => {
        const assignedTo = a.assignedTo || '';
        const internal = isInternalResolution(assignedTo);
        const afterCount = (a.afterPhotoUrls || []).length;
        const isLater = laterLineIds.has(a.answerIdExternal);
        // Mirrors the server gate exactly (finalize.ts).
        const wouldBlock = afterPropExists && internal && !isLater && afterCount === 0;
        return {
          externalId: a.answerIdExternal,
          section: a.section || '',
          code: a.rateCardLine?.lineItemCode || '',
          assignedTo,
          isInternalResolution: internal,
          photoUrlsCount: (a.photoUrls || []).length,
          afterPhotoUrlsCount: afterCount,
          timing: isLater ? 'later' : 'now',
          wouldBlockFinalize: wouldBlock,
        };
      });

    const blocking = lines.filter((l) => l.wouldBlockFinalize);
    return res.status(200).json({
      ok: true,
      inspectionId: id,
      templateType: insp?.templateType || null,
      status: insp?.status || null,
      afterPhotoPropertyExists: afterPropExists,
      resolutionTimingJsonPresent: !!(insp?.resolutionTimingJson || '').trim(),
      totalRateCardLines: lines.length,
      internalResolutionLines: lines.filter((l) => l.isInternalResolution).length,
      wouldBlockCount: blocking.length,
      // The lines the finalize gate flags — inspect where their photos actually are.
      blocking,
      // Every Internal Resolution line, so you can see photo placement across all.
      internalLines: lines.filter((l) => l.isInternalResolution),
      // Distinct assigned_to values present (spot a mislabeled/near-miss vendor).
      assignedToValues: Array.from(new Set(lines.map((l) => l.assignedTo))).sort(),
    });
  } catch (e: any) {
    console.error('[inspect-line-photos] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
