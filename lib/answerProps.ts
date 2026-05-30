/**
 * Single source of truth for building HubSpot `inspection_answer` property sets.
 *
 * WHY THIS EXISTS
 * ---------------
 * Answer props used to be hand-built in 6+ places (useAutosave, QuestionForm,
 * QcReinspectForm, RateCardForm, useRateCardAutosave, /api/submit). Each copy
 * drifted slightly:
 *   - `quantity` / `assigned_to` were written unconditionally on some paths,
 *     which 400'd the whole batch/create on non-Scope templates (the 1099 bug).
 *   - `photo_urls` was joined with ';' in some places and ',' in others.
 *   - `photo_count` / `submitted_at` / `inspection_id_external` were present on
 *     some section-photo writes and missing on others.
 *
 * Centralizing the shape means a rule like "quantity is Scope-only" or "photos
 * are semicolon-delimited" lives in exactly one place and can't drift again.
 *
 * The `rate_card_line` answer shape is server-authoritative (built in
 * lib/hubspot.ts + rate-card-lines.ts from the canonical math) and is
 * intentionally NOT handled here.
 */

// Standard delimiter for the multi-value `photo_urls` string. The read path
// (lib/hubspot.ts) tolerates both ',' and ';', but we WRITE only this one so
// the data is consistent going forward.
export const PHOTO_URL_DELIMITER = ';';

export function joinPhotoUrls(urls: string[]): string {
  return urls.filter(Boolean).join(PHOTO_URL_DELIMITER);
}

/** The minimal answer fields a Q&A answer carries. */
export interface QaAnswerFields {
  answerIdExternal: string;
  inspectionIdExternal: string;
  questionIdExternal: string;
  questionText: string;
  section: string;
  /** Used only to build the human-readable summary (e.g. instanceKey or "Bedroom 1"). */
  summaryInstanceLabel: string;
  answerValue: string;
  location?: string | null;
  note?: string | null;
  quantity?: number | null;
  assignedTo?: string | null;
  photoUrls?: string[] | null;
}

/**
 * Build the property set for a `qa` answer record.
 *
 * `isScope` gates the Scope-only fields (`quantity`, `assigned_to`). Non-Scope
 * templates (1099, Community, Vacancy, RRQC) MUST pass `isScope: false` so
 * those properties are never written — see the file header.
 */
export function buildQaAnswerProps(
  f: QaAnswerFields,
  opts: { isScope: boolean }
): Record<string, any> {
  const props: Record<string, any> = {
    answer_id_external: f.answerIdExternal,
    answer_summary: `${f.section} ${f.summaryInstanceLabel} / ${f.questionText.slice(0, 80)}`,
    answer_type: 'qa',
    section: f.section,
    answer_value: f.answerValue || '',
    submitted_at: new Date().toISOString(),
    inspection_id_external: f.inspectionIdExternal,
    question_id_external: f.questionIdExternal,
  };
  if (f.location) props.location = f.location;
  if (f.note) props.note = f.note;
  // Scope-only properties — never written on non-Scope templates.
  if (opts.isScope) {
    if (f.quantity != null) props.quantity = f.quantity;
    if (f.assignedTo) props.assigned_to = f.assignedTo;
  }
  if (f.photoUrls && f.photoUrls.length) {
    props.photo_urls = joinPhotoUrls(f.photoUrls);
    props.photo_count = f.photoUrls.length;
  }
  return props;
}

/** The fields a section-photo answer carries. */
export interface SectionPhotoAnswerFields {
  answerIdExternal: string;
  /**
   * Optional: not all call sites have the inspection's external id on hand
   * (e.g. the QC after-photo flow keys off the HubSpot record id). When
   * present it's written for consistency; when absent it's simply omitted.
   */
  inspectionIdExternal?: string | null;
  /** Base section name written to the record (e.g. "Bathroom"). */
  section: string;
  /** Display label used in the summary (e.g. "Bedroom 1", or the section label). */
  summaryLabel: string;
  photoUrls: string[];
  location?: string | null;
  /** QC before/after re-inspect flow only. */
  photoPhase?: 'before' | 'after' | null;
}

/**
 * Build the property set for a `section_photo` answer record. One consistent
 * shape for every form (QuestionForm, RateCardForm, QcReinspectForm) and the
 * legacy submit path.
 */
export function buildSectionPhotoAnswerProps(
  f: SectionPhotoAnswerFields
): Record<string, any> {
  const phaseLabel = f.photoPhase === 'after'
    ? 'After Photos'
    : f.photoPhase === 'before'
      ? 'Before Photos'
      : 'Section Photo';
  const props: Record<string, any> = {
    answer_id_external: f.answerIdExternal,
    answer_summary: `${f.summaryLabel} / ${phaseLabel} (${f.photoUrls.length})`,
    answer_type: 'section_photo',
    section: f.section,
    photo_urls: joinPhotoUrls(f.photoUrls),
    photo_count: f.photoUrls.length,
    submitted_at: new Date().toISOString(),
  };
  if (f.inspectionIdExternal) props.inspection_id_external = f.inspectionIdExternal;
  if (f.location) props.location = f.location;
  if (f.photoPhase) props.photo_phase = f.photoPhase;
  return props;
}
