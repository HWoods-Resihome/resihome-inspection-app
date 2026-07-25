/**
 * Photo-gap detection — a completed inspection question that REQUIRES a photo but
 * has none. Shared by the admin diagnostic endpoint (/api/admin/photo-gaps) and
 * the safety-net sweep cron (/api/cron/photo-gap-sweep).
 *
 * Mirrors the QuestionForm submit gate exactly: a `requires_photo` question that's
 * ANSWERED (non-N/A) with no photo, or a required `photo_only` question with no
 * photo. So a gap here is a photo the completed record was supposed to have and
 * doesn't — evidence that never synced (a stranded-on-device photo the inspector
 * left before it uploaded) or was skipped via the stuck-upload override.
 */
import { fetchQuestionsForTemplate, fetchAnswersForInspection } from '@/lib/hubspot';
import type { Question } from '@/lib/types';

export interface PhotoGap {
  questionIdExternal: string;
  questionText: string;
  section: string;
  location: string;
  answerValue: string;
}

// N/A detection — mirrors QuestionItem.isNA (kept here so server code doesn't pull
// a client component into an API bundle).
export function isNaAnswer(opt: string): boolean {
  return /^(n\/?a|n\.a\.?|not applicable)\b/.test((opt || '').trim().toLowerCase());
}

/**
 * Question map for a template, keyed by question_id_external. Pass a shared
 * `cache` across a scan so one template's questions are fetched once, not per
 * inspection. includeDisabled so a retired-but-answered question still resolves.
 */
export async function questionMapForTemplate(
  templateType: string,
  cache?: Map<string, Map<string, Question>>,
): Promise<Map<string, Question>> {
  const hit = cache?.get(templateType);
  if (hit) return hit;
  const { questions } = await fetchQuestionsForTemplate(templateType, { includeDisabled: true })
    .catch(() => ({ questions: [] as Question[] }));
  const map = new Map<string, Question>();
  for (const q of questions) map.set(q.questionIdExternal, q);
  cache?.set(templateType, map);
  return map;
}

/** Required-photo gaps for one inspection, given its template's question map. */
export async function photoGapsForInspection(
  inspectionId: string,
  qMap: Map<string, Question>,
): Promise<PhotoGap[]> {
  const answers = await fetchAnswersForInspection(inspectionId).catch(() => []);
  const gaps: PhotoGap[] = [];
  for (const a of answers) {
    const q = qMap.get(a.questionIdExternal);
    if (!q) continue;
    if ((a.photoUrls?.length || 0) > 0) continue; // has a photo → not a gap
    const photoOnlyGap = q.isRequired && q.responseType === 'photo_only';
    const requiresPhotoGap = q.requiresPhoto && !!a.answerValue && !isNaAnswer(a.answerValue);
    if (photoOnlyGap || requiresPhotoGap) {
      gaps.push({
        questionIdExternal: a.questionIdExternal,
        questionText: q.questionText,
        section: a.section || q.section || '',
        location: a.location || '',
        answerValue: a.answerValue || '',
      });
    }
  }
  return gaps;
}
