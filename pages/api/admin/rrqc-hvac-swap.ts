/**
 * RRQC section swap — replace New Construction RRQC's "HVAC / Mechanicals" and
 * "Safety / Electrical / Utilities" sections with the 1099 Leasing Agent form's
 * "HVAC / Utilities" section.
 *
 * Questions are shared across templates via `applies_to_templates` (pipe list),
 * so this doesn't duplicate anything — it just toggles which templates each
 * question belongs to:
 *   • RRQC's HVAC/Mechanicals + Safety/Electrical/Utilities questions → drop RRQC
 *     from applies_to_templates (archive the record only if RRQC was its LAST
 *     template, so questions shared with Scope/other forms are preserved).
 *   • The 1099 form's HVAC/Utilities questions → add RRQC to applies_to_templates
 *     (they keep their own section label + order, so RRQC gains that section).
 *
 * GET  → DRY RUN: shows exactly what would change (verify the matched sections).
 * GET ?apply=1 → APPLY. Admin-gated. Re-runnable (idempotent).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { listAllQuestionRecords, updateQuestionRecord, archiveQuestionRecords } from '@/lib/hubspot';

export const config = { maxDuration: 120 };

const RRQC = 'qc_new_construction_rrqc';
const SOURCE_1099 = 'leasing_agent_1099_property_inspection';

// RRQC sections to REMOVE: HVAC/Mechanicals and Safety/Electrical/Utilities.
const REMOVE_SECTION_RE = /(hvac|mechanical|safety|electric|utilit)/i;
// The 1099 section to ADD: "HVAC / Utilities" — a section carrying BOTH tokens
// (so a plain "HVAC" or a plain "Utilities" section elsewhere isn't swept in).
const isTargetSource = (section: string) => /hvac/i.test(section) && /util/i.test(section);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session || !(await isAppAdmin(session.email).catch(() => false))) return res.status(403).json({ error: 'Admin only' });

  const apply = req.query.apply === '1' || req.query.apply === 'true';
  try {
    const all = await listAllQuestionRecords();

    // 1) RRQC questions in the sections we're removing.
    const toRemove = all.filter((q) => q.applies.includes(RRQC) && REMOVE_SECTION_RE.test(q.section));
    // 2) 1099 questions in the HVAC / Utilities section not already on RRQC.
    const sourceHvacUtil = all.filter((q) => q.applies.includes(SOURCE_1099) && isTargetSource(q.section));
    const toAdd = sourceHvacUtil.filter((q) => !q.applies.includes(RRQC));

    const plan = {
      mode: apply ? 'apply' : 'dry-run',
      remove: toRemove.map((q) => ({ recordId: q.recordId, section: q.section, question: q.questionText, willArchive: q.applies.length === 1 })),
      add: toAdd.map((q) => ({ recordId: q.recordId, section: q.section, question: q.questionText })),
      sourceHvacUtilSections: [...new Set(sourceHvacUtil.map((q) => q.section))],
      rrqcRemovedSections: [...new Set(toRemove.map((q) => q.section))],
      counts: { remove: toRemove.length, archive: toRemove.filter((q) => q.applies.length === 1).length, add: toAdd.length },
    };

    // Safety: never strip RRQC's sections if we found NOTHING to add (a bad match
    // would leave RRQC with no HVAC/utilities coverage at all).
    if (apply && toRemove.length && toAdd.length === 0) {
      return res.status(409).json({ error: 'Refusing to apply: found sections to remove but no "HVAC / Utilities" source questions on the 1099 form. Check sourceHvacUtilSections in the dry-run.', ...plan });
    }

    if (!apply) return res.status(200).json(plan);

    // Apply — remove RRQC from the old sections (archive if it was the last template).
    const archiveIds: string[] = [];
    for (const q of toRemove) {
      if (q.applies.length === 1) { archiveIds.push(q.recordId); continue; }
      const next = q.applies.filter((t) => t !== RRQC);
      await updateQuestionRecord(q.recordId, { applies_to_templates: next.join('|') });
    }
    if (archiveIds.length) await archiveQuestionRecords(archiveIds);
    // Add RRQC to the 1099 HVAC/Utilities questions.
    for (const q of toAdd) {
      await updateQuestionRecord(q.recordId, { applies_to_templates: [...q.applies, RRQC].join('|') });
    }

    return res.status(200).json({ ...plan, applied: true });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 400) });
  }
}
