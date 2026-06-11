/**
 * GET /api/admin/cleanup-community
 *
 * Trims the **Community Inspection** template (pm_community_inspection) down to
 * what the field actually needs, per owner request:
 *
 *   SECTIONS removed entirely (every question in them, for Community):
 *     - HVAC / Air Filter
 *     - Utility / Utilities
 *     - Smart Home Tech
 *
 *   YARD / EXTERIOR questions removed (the section stays, these lines go):
 *     - Roads / Sidewalks
 *     - Overall Appearance
 *     - Irrigation
 *     - Parking Lot
 *     - Fences
 *     - Pond and Fountains
 *     - Community Signage
 *
 * Each matched question is DETACHED from pm_community_inspection
 * (applies_to_templates). If that leaves the record applying to no template at
 * all, it is ARCHIVED ("deleted from HubSpot" — templates can be regenerated).
 * Records shared with other templates keep working for those templates.
 *
 * SAFE: dry-run by default — open signed in as @resihome.com to see EXACTLY
 * what it would change. Add ?apply=1 to actually write. Only ever touches the
 * Community template's associations; never Scope / QC / other templates.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import {
  listAllQuestionRecords, updateQuestionRecord, archiveQuestionRecords,
  type RawQuestionRecord,
} from '@/lib/hubspot';

export const config = { maxDuration: 120 };

const TARGET = 'pm_community_inspection';

// Whole sections that no longer belong on the Community template.
const isRemovedSection = (s: string) =>
  /hvac|air.?filter|utilit|smart.?home|smart.?tech/i.test(s);

// Yard / Exterior section detection.
const isYardExterior = (s: string) => /yard|exterior|grounds/i.test(s);

// Specific Yard/Exterior questions to drop (match on the question text).
const isRemovedYardQuestion = (q: string) =>
  /road|sidewalk|overall\s*appearance|irrigation|parking|fence|pond|fountain|signage/i.test(q);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!/@resihome\.com$/i.test(session.email)) return res.status(403).json({ error: 'Admin only.' });

  const apply = req.query.apply === '1';

  try {
    const all = await listAllQuestionRecords();
    // Only records that apply to the Community template.
    const inScope = all.filter((q) => q.applies.includes(TARGET));

    const toArchive: RawQuestionRecord[] = [];
    const toDetach: Array<{ q: RawQuestionRecord; newApplies: string[]; reason: string }> = [];

    for (const q of inScope) {
      let reason = '';
      if (isRemovedSection(q.section)) {
        reason = `section "${q.section}" removed from Community`;
      } else if (isYardExterior(q.section) && isRemovedYardQuestion(q.questionText)) {
        reason = `yard/exterior line "${q.questionText}" removed from Community`;
      }
      if (!reason) continue;

      const newApplies = q.applies.filter((t) => t !== TARGET);
      if (newApplies.length === 0) toArchive.push(q);
      else toDetach.push({ q, newApplies, reason });
    }

    const plan = {
      target: TARGET,
      archive: toArchive.map((q) => ({ recordId: q.recordId, section: q.section, question: q.questionText, applies: q.applies })),
      detach: toDetach.map(({ q, newApplies, reason }) => ({ recordId: q.recordId, section: q.section, question: q.questionText, from: q.applies, to: newApplies, reason })),
      counts: { archive: toArchive.length, detach: toDetach.length },
    };

    if (!apply) {
      // Self-diagnosing dump so a single fetch reveals the real data shape:
      // every distinct applies_to_templates value (with counts) and, for any
      // record whose template key looks community-ish, its section + question.
      const templateCounts: Record<string, number> = {};
      for (const q of all) for (const t of q.applies) templateCounts[t] = (templateCounts[t] || 0) + 1;
      const distinctTemplates = Object.entries(templateCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([template, count]) => ({ template, count }));
      const communityLike = all
        .filter((q) => q.applies.some((t) => /commun/i.test(t)))
        .map((q) => ({ recordId: q.recordId, applies: q.applies, section: q.section, question: q.questionText }));

      return res.status(200).json({
        dryRun: true,
        note: 'Nothing was changed. Review the plan below, then re-open with ?apply=1 to commit.',
        applyUrl: '/api/admin/cleanup-community?apply=1',
        plan,
        diagnostics: {
          totalRecords: all.length,
          recordsAppliedToTarget: inScope.length,
          distinctTemplates,
          communityLikeRecords: communityLike,
        },
      });
    }

    // ---- APPLY ----
    const results = { archived: 0, detached: 0, errors: [] as string[] };

    if (toArchive.length) {
      try { await archiveQuestionRecords(toArchive.map((q) => q.recordId)); results.archived = toArchive.length; }
      catch (e: any) { results.errors.push(`archive: ${String(e?.message || e).slice(0, 160)}`); }
    }
    for (const { q, newApplies } of toDetach) {
      try { await updateQuestionRecord(q.recordId, { applies_to_templates: newApplies.join('|') }); results.detached++; }
      catch (e: any) { results.errors.push(`detach ${q.recordId}: ${String(e?.message || e).slice(0, 160)}`); }
    }

    return res.status(200).json({ applied: true, results, plan });
  } catch (e: any) {
    console.error('[cleanup-community] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
