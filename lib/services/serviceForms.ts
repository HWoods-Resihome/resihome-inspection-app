/**
 * ResiWalk - Services — service completion FORM model (Form Builder).
 *
 * Preview/sample only: these are the per-worktype+subtype question sets an admin
 * edits in the Form Builder. In Step 2 this maps onto the reused HubSpot
 * Question / Answer objects (same store the inspection rate-card/question forms
 * use), keyed by worktype+subtype instead of a rate-card template.
 */

export type AnswerType = 'yesno' | 'short' | 'long' | 'date' | 'photo';

export const ANSWER_TYPES: { value: AnswerType; label: string }[] = [
  { value: 'yesno', label: 'Yes / No' },
  { value: 'short', label: 'Short text' },
  { value: 'long', label: 'Long text / notes' },
  { value: 'date', label: 'Date' },
  { value: 'photo', label: 'Photo(s)' },
];

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
  allowNotes: boolean;       // show an optional notes field alongside the answer
  trigger?: ServiceTrigger;  // optional: this answer creates a new Estimated service
}

export const formKey = (worktype: string, subtype: string) => `${worktype}:${subtype}`;

// Seeded sample forms so the builder + completion preview have content.
export const SAMPLE_FORMS: Record<string, ServiceQuestion[]> = {
  'landscaping:cut': [
    { id: 'gc1', label: 'Front AND back yard fully mowed?', type: 'yesno', required: true, allowNotes: true,
      trigger: { whenAnswer: 'no', worktype: 'landscaping', subtype: 'cut', requirePhotos: true } },
    { id: 'gc2', label: 'Edged, blown off, and debris removed?', type: 'yesno', required: true, allowNotes: false },
    { id: 'gc3', label: 'Gate / lock code used', type: 'short', required: false, allowNotes: false },
    { id: 'gc4', label: 'Notes for the coordinator', type: 'long', required: false, allowNotes: false },
  ],
  'pools:pool_cleaning': [
    { id: 'pc1', label: 'Skimmed, brushed, and vacuumed?', type: 'yesno', required: true, allowNotes: false },
    { id: 'pc2', label: 'Chemicals tested & balanced?', type: 'yesno', required: true, allowNotes: true },
    { id: 'pc3', label: 'Equipment issue found?', type: 'yesno', required: false, allowNotes: true,
      trigger: { whenAnswer: 'yes', worktype: 'pools', subtype: 'pool_cleaning', requirePhotos: true } },
  ],
  'cleaning:vacant_clean': [
    { id: 'vc1', label: 'All rooms cleaned to standard?', type: 'yesno', required: true, allowNotes: true },
    { id: 'vc2', label: 'Date completed', type: 'date', required: false, allowNotes: false },
  ],
};

let _qid = 1000;
export const newQuestion = (): ServiceQuestion =>
  ({ id: `q${++_qid}`, label: '', type: 'yesno', required: false, allowNotes: false });

export const answerTypeLabel = (t: AnswerType): string => ANSWER_TYPES.find((a) => a.value === t)?.label || t;
