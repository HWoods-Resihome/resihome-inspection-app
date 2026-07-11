/**
 * ResiWalk - Services — service completion FORM model (Form Builder).
 *
 * Preview/sample only: these are the per-worktype+subtype question sets an admin
 * edits in the Form Builder. In Step 2 this maps onto the reused HubSpot
 * Question / Answer objects (same store the inspection rate-card/question forms
 * use), keyed by worktype+subtype instead of a rate-card template.
 */

export type AnswerType = 'yesno' | 'short' | 'long' | 'date' | 'photo' | 'select';

export const ANSWER_TYPES: { value: AnswerType; label: string }[] = [
  { value: 'yesno', label: 'Yes / No' },
  { value: 'select', label: 'Dropdown (options)' },
  { value: 'short', label: 'Short text' },
  { value: 'long', label: 'Long text / notes' },
  { value: 'date', label: 'Date' },
  { value: 'photo', label: 'Photo(s)' },
];

/** A dropdown option. Selecting it can adjust the VENDOR COST (set to, or +/- delta).
 *  priceMode 'none' = no price effect. Amounts are strings so they type freely. */
export interface QuestionOption {
  id: string;
  label: string;
  priceMode: 'none' | 'set' | 'delta';
  priceValue: string;   // dollars (vendor cost); ignored when priceMode = 'none'
}

/** A follow-up service the answer spawns (created in ESTIMATED with its own photos). */
export interface ServiceTrigger {
  whenAnswer: string;      // the answer that fires it (e.g. 'no' for a yes/no)
  worktype: string;        // worktype of the follow-up service
  subtype: string;         // subtype of the follow-up service
  requirePhotos: boolean;  // require separate before/after photos on the follow-up
}

export interface ServiceQuestion {
  id: string;
  label: string;
  type: AnswerType;
  required: boolean;
  requirePhoto: boolean;     // must attach a photo for this question
  requireNote: boolean;      // must add a note for this question
  enabled: boolean;          // On/Off without deleting
  options?: QuestionOption[];// for type 'select' — the dropdown choices (may drive price)
  trigger?: ServiceTrigger;  // optional: this answer creates a new Estimated service
}

export const formKey = (worktype: string, subtype: string) => `${worktype}:${subtype}`;

// Seeded sample forms so the builder + completion preview have content.
export const SAMPLE_FORMS: Record<string, ServiceQuestion[]> = {
  'landscaping:cut': [
    { id: 'gc0', label: 'Grass height at arrival', type: 'select', required: true, requirePhoto: false, requireNote: false, enabled: true, options: [
      { id: 'h1', label: 'Standard (≤ 6")', priceMode: 'none', priceValue: '' },
      { id: 'h2', label: 'Tall (6–12")', priceMode: 'delta', priceValue: '15' },
      { id: 'h3', label: 'Overgrown (12"+)', priceMode: 'delta', priceValue: '30' },
    ] },
    { id: 'gc1', label: 'Front AND back yard fully mowed?', type: 'yesno', required: true, requirePhoto: true, requireNote: false, enabled: true,
      trigger: { whenAnswer: 'no', worktype: 'landscaping', subtype: 'cut', requirePhotos: true } },
    { id: 'gc2', label: 'Edged, blown off, and debris removed?', type: 'yesno', required: true, requirePhoto: true, requireNote: false, enabled: true },
    { id: 'gc3', label: 'Gate / lock code used', type: 'short', required: false, requirePhoto: false, requireNote: false, enabled: true },
    { id: 'gc4', label: 'Notes for the coordinator', type: 'long', required: false, requirePhoto: false, requireNote: false, enabled: true },
  ],
  'pools:pool_cleaning': [
    { id: 'pc1', label: 'Skimmed, brushed, and vacuumed?', type: 'yesno', required: true, requirePhoto: true, requireNote: false, enabled: true },
    { id: 'pc2', label: 'Chemicals tested & balanced?', type: 'yesno', required: true, requirePhoto: false, requireNote: true, enabled: true },
    { id: 'pc3', label: 'Equipment issue found?', type: 'yesno', required: false, requirePhoto: true, requireNote: true, enabled: true,
      trigger: { whenAnswer: 'yes', worktype: 'pools', subtype: 'pool_cleaning', requirePhotos: true } },
  ],
  'cleaning:vacant_clean': [
    { id: 'vc1', label: 'All rooms cleaned to standard?', type: 'yesno', required: true, requirePhoto: true, requireNote: false, enabled: true },
    { id: 'vc2', label: 'Date completed', type: 'date', required: false, requirePhoto: false, requireNote: false, enabled: true },
  ],
};

let _qid = 1000;
export const newQuestion = (): ServiceQuestion =>
  ({ id: `q${++_qid}`, label: '', type: 'yesno', required: false, requirePhoto: false, requireNote: false, enabled: true });
export const newOption = (): QuestionOption =>
  ({ id: `o${++_qid}`, label: '', priceMode: 'none', priceValue: '' });

export const answerTypeLabel = (t: AnswerType): string => ANSWER_TYPES.find((a) => a.value === t)?.label || t;
