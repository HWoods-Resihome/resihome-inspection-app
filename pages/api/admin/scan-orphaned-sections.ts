/**
 * GET /api/admin/scan-orphaned-sections
 *
 * Finds rate-card inspections that have saved line items (or section photos)
 * whose section doesn't match any section in the inspection's layout — the
 * "orphaned section" state that hid the Office line from review while it still
 * billed on the PDF (and split the client/server after-photo gate). These lines
 * are invisible in the review UI until the recovery fix loads them.
 *
 * Read-only. Admin only. Scans non-completed Scope rate cards by default (the
 * ones still reviewable); add ?includeCompleted=1 to also list finalized ones.
 * Paginates within a ~250s budget: re-open with ?after=<n> if nextAfter is set.
 * ?limit=N (default 150).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { fetchInspections, fetchAnswersForInspection } from '@/lib/hubspot';
import { resolveSections } from '@/lib/sections';

export const config = { maxDuration: 300 };

const TEMPLATE = 'pm_scope_rate_card';
const ACTIVE_STATUSES = new Set(['scheduled', 'in progress', 'in_progress', 'pending_approval', 'pending approval']);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.email))) return res.status(403).json({ error: 'Admin only.' });

  const includeCompleted = String(req.query.includeCompleted || '') === '1';
  const startIdx = Math.max(0, Number(req.query.after) || 0);
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 150));
  const deadline = Date.now() + 250_000;

  try {
    const all = await fetchInspections();
    const targets = all.filter((i) =>
      i.templateType === TEMPLATE
      && (includeCompleted || ACTIVE_STATUSES.has((i.status || '').trim().toLowerCase())));

    let processed = 0, scanned = 0, withOrphans = 0, errors = 0;
    const affected: Array<{
      id: string; address: string; status: string;
      orphanedSections: string[]; orphanedLineCount: number; orphanedPhotoCount: number;
    }> = [];
    const errorSamples: string[] = [];

    let idx = startIdx;
    for (; idx < targets.length && idx < startIdx + limit; idx++) {
      const insp = targets[idx];
      processed++;
      try {
        const sections = resolveSections(insp.sectionListJson, insp.bedroomsAtInspection || 0, insp.bathroomsAtInspection || 0);
        // Same matching the review form uses: exact label||location, else a
        // location that's unique to one section, else unmatched (orphan).
        const byLabelLoc = new Set<string>();
        const byLocation = new Map<string, string>();
        for (const s of sections) {
          byLabelLoc.add(`${s.label}||${s.location}`);
          if (s.location) byLocation.set(s.location, byLocation.has(s.location) ? '' : s.id);
        }
        const isMatched = (section: string, location: string): boolean => {
          if (byLabelLoc.has(`${section}||${location}`)) return true;
          if (location && byLocation.get(location)) return true;
          return false;
        };

        const answers = await fetchAnswersForInspection(insp.recordId);
        scanned++;
        const orphanSections = new Set<string>();
        let orphanLines = 0, orphanPhotos = 0;
        for (const a of answers) {
          if (a.answerType !== 'rate_card_line' && a.answerType !== 'section_photo') continue;
          if (isMatched(a.section || '', a.location || '')) continue;
          orphanSections.add(a.section || a.location || '(blank)');
          if (a.answerType === 'rate_card_line') orphanLines++; else orphanPhotos++;
        }
        if (orphanSections.size > 0) {
          withOrphans++;
          affected.push({
            id: insp.recordId,
            address: insp.propertyAddressSnapshot || '',
            status: insp.status || '',
            orphanedSections: Array.from(orphanSections),
            orphanedLineCount: orphanLines,
            orphanedPhotoCount: orphanPhotos,
          });
        }
      } catch (e: any) {
        errors++;
        if (errorSamples.length < 10) errorSamples.push(`${insp.recordId}: ${String(e?.message || e).slice(0, 160)}`);
      }
      if (Date.now() > deadline) { idx++; break; }
    }

    const done = idx >= targets.length;
    const nextAfter = done ? null : idx;
    return res.status(200).json({
      ok: true,
      scope: includeCompleted ? 'all Scope rate cards' : 'active (non-completed) Scope rate cards',
      totalCandidates: targets.length,
      processed,
      scanned,
      withOrphans,
      errors,
      done,
      nextAfter,
      resume: nextAfter != null
        ? `/api/admin/scan-orphaned-sections?after=${nextAfter}&limit=${limit}${includeCompleted ? '&includeCompleted=1' : ''}`
        : null,
      // Each affected inspection — open /inspection/<id> (the recovery fix now
      // surfaces the orphaned section so it can be photographed/removed) or use
      // the inspect-line-photos diagnostic for line-level detail.
      affected,
      errorSamples,
    });
  } catch (e: any) {
    console.error('[scan-orphaned-sections] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
