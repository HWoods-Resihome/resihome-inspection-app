/**
 * GET /api/admin/cleanup-questions
 *
 * Cleans up the inspection_question records for the Q&A templates (1099,
 * Vacancy/Occupancy, Community) so the data mirrors the app:
 *   - HVAC, Smart Home/Lock, Safety/Electric, and Utilities sections are now
 *     rendered by the reused Scope widgets, so those question records are
 *     redundant → the three Q&A templates are removed from their
 *     applies_to_templates (the record is archived only if no template remains).
 *   - Review/Sign-off + Summary are merged into one bottom section
 *     "Review & Sign-Off" (section + a high section_order), and an
 *     "Additional Notes" text question is added to it if missing.
 *
 * SAFE: dry-run by default — open the URL signed in as @resihome.com to see
 * EXACTLY what it would change. Add ?apply=1 to actually write. Never touches
 * records that don't apply to one of the three Q&A templates, and never touches
 * Scope / QC / other templates' associations.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import {
  listAllQuestionRecords, updateQuestionRecord, archiveQuestionRecords, createQuestionRecord,
  type RawQuestionRecord,
} from '@/lib/hubspot';

export const config = { maxDuration: 120 };

const QA_TEMPLATES = [
  'leasing_agent_1099_property_inspection',
  'pm_vacancy_occupancy_check',
  'pm_community_inspection',
];
const MERGED_SECTION = 'Review & Sign-Off';
const MERGED_ORDER = 9000;

const isReplaced = (s: string) => /hvac|air.?filter|smart.?home|smart.?lock|safety|electric|utilit/i.test(s);
const isReviewOrSummary = (s: string) => /summary|review|sign.?off/i.test(s);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!/@resihome\.com$/i.test(session.email)) return res.status(403).json({ error: 'Admin only.' });

  const apply = req.query.apply === '1';

  try {
    const all = await listAllQuestionRecords();
    // Only records that apply to at least one of the three Q&A templates.
    const inScope = all.filter((q) => q.applies.some((t) => QA_TEMPLATES.includes(t)));

    const toArchive: RawQuestionRecord[] = [];
    const toDetach: Array<{ q: RawQuestionRecord; newApplies: string[] }> = [];
    const toMerge: RawQuestionRecord[] = [];

    for (const q of inScope) {
      if (isReplaced(q.section)) {
        const newApplies = q.applies.filter((t) => !QA_TEMPLATES.includes(t));
        if (newApplies.length === 0) toArchive.push(q);
        else toDetach.push({ q, newApplies });
      } else if (isReviewOrSummary(q.section)) {
        // Only merge if it isn't already the merged section/order.
        if (q.section !== MERGED_SECTION || q.sectionOrder !== MERGED_ORDER) toMerge.push(q);
      }
    }

    // Does a free-text "additional notes / comments" question already exist for
    // these templates? (You already have "Additional Comments" + "Comments", so
    // we don't add a duplicate.)
    const hasAdditionalNotes = all.some(
      (q) => /additional\s*(notes|comments)|^\s*comments\s*$/i.test(q.questionText) && q.applies.some((t) => QA_TEMPLATES.includes(t))
    );

    const plan = {
      templates: QA_TEMPLATES,
      archive: toArchive.map((q) => ({ recordId: q.recordId, section: q.section, question: q.questionText, applies: q.applies })),
      detach: toDetach.map(({ q, newApplies }) => ({ recordId: q.recordId, section: q.section, question: q.questionText, from: q.applies, to: newApplies })),
      mergeIntoReviewSignOff: toMerge.map((q) => ({ recordId: q.recordId, fromSection: q.section, question: q.questionText })),
      createAdditionalNotes: !hasAdditionalNotes,
      counts: { archive: toArchive.length, detach: toDetach.length, merge: toMerge.length },
    };

    if (!apply) {
      return res.status(200).json({
        dryRun: true,
        note: 'Nothing was changed. Review the plan below, then re-open with ?apply=1 to commit.',
        applyUrl: '/api/admin/cleanup-questions?apply=1',
        plan,
      });
    }

    // ---- APPLY ----
    const results = { archived: 0, detached: 0, merged: 0, createdAdditionalNotes: false, errors: [] as string[] };

    if (toArchive.length) {
      try { await archiveQuestionRecords(toArchive.map((q) => q.recordId)); results.archived = toArchive.length; }
      catch (e: any) { results.errors.push(`archive: ${String(e?.message || e).slice(0, 120)}`); }
    }
    for (const { q, newApplies } of toDetach) {
      try { await updateQuestionRecord(q.recordId, { applies_to_templates: newApplies.join('|') }); results.detached++; }
      catch (e: any) { results.errors.push(`detach ${q.recordId}: ${String(e?.message || e).slice(0, 120)}`); }
    }
    for (const q of toMerge) {
      try { await updateQuestionRecord(q.recordId, { section: MERGED_SECTION, section_order: MERGED_ORDER }); results.merged++; }
      catch (e: any) { results.errors.push(`merge ${q.recordId}: ${String(e?.message || e).slice(0, 120)}`); }
    }
    if (!hasAdditionalNotes) {
      try {
        await createQuestionRecord({
          question_id_external: 'additional_notes',
          question_text: 'Additional Notes',
          section: MERGED_SECTION,
          section_order: MERGED_ORDER,
          display_order: 999,
          response_type: 'text',
          is_required: 'false',
          applies_to_templates: QA_TEMPLATES.join('|'),
          help_text: 'Anything else worth noting about this inspection (optional).',
        });
        results.createdAdditionalNotes = true;
      } catch (e: any) { results.errors.push(`create additional_notes: ${String(e?.message || e).slice(0, 160)}`); }
    }

    return res.status(200).json({ applied: true, results, plan });
  } catch (e: any) {
    console.error('[cleanup-questions] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
