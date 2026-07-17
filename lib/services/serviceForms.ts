/**
 * ResiWalk - Services — service completion FORM model (Form Builder).
 *
 * Preview/sample only: these are the per-worktype+subtype question sets an admin
 * edits in the Form Builder. In Step 2 this maps onto the reused HubSpot
 * Question / Answer objects (same store the inspection rate-card/question forms
 * use), keyed by worktype+subtype instead of a rate-card template.
 */

// Mirrors the inspection Form Builder's answer types.
export type AnswerType = 'single' | 'multi' | 'yesno' | 'text' | 'number' | 'date' | 'photo';

export const ANSWER_TYPES: { value: AnswerType; label: string }[] = [
  { value: 'single', label: 'Single choice (dropdown/radio)' },
  { value: 'multi', label: 'Multiple choice (checkboxes)' },
  { value: 'yesno', label: 'Yes / No' },
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'photo', label: 'Photo only' },
];

// Choice-style answers (carry options that can drive price).
export const hasOptions = (t: AnswerType): boolean => t === 'single' || t === 'multi';

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

/** Per-answer requirement: when a given answer is chosen, force a note / photo. */
export interface AnswerReq { note?: boolean; photo?: boolean; }

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
  // Per-answer requirements — keyed by the answer value ('yes'/'no' for yes/no,
  // or the option label for single/multi). Choosing that answer then requires a
  // note and/or a photo before the completion can be submitted.
  answerReqs?: Record<string, AnswerReq>;
  // Conditional visibility: only show when another answer equals `value`
  // (drives the universal completion flow — date on Yes, reason/trip-fee on No).
  showWhen?: { qid: string; value: string };
  defaultToday?: boolean;    // date questions: prefill with today's date (editable)
}

export const formKey = (worktype: string, subtype: string) => `${worktype}:${subtype}`;

// ── Baseline question sets ────────────────────────────────────────────────
// Every completion form starts with the UNIVERSAL block, then the worktype+
// subtype's own questions. The universal block is the standard "Service
// Completed?" gate: on No it collects a reason + whether to bill a trip fee (the
// submit logic then routes it straight to human Review and adjusts the cost).
const opts = (id: string, labels: string[]): QuestionOption[] =>
  labels.map((l, i) => ({ id: `${id}_o${i}`, label: l, priceMode: 'none' as const, priceValue: '' }));

const Q = (id: string, label: string, type: AnswerType, extra: Partial<ServiceQuestion> & { opts?: string[] } = {}): ServiceQuestion => {
  const { opts: o, ...rest } = extra;
  return {
    id, label, type,
    required: rest.required ?? true,
    requirePhoto: rest.requirePhoto ?? false,
    requireNote: rest.requireNote ?? false,
    enabled: true,
    ...(o ? { options: opts(id, o) } : {}),
    ...(rest.showWhen ? { showWhen: rest.showWhen } : {}),
    ...(rest.defaultToday ? { defaultToday: true } : {}),
  };
};

// The universal completion gate — prepended to every service's form. IDs are
// stable so the submit/pricing/routing logic can key off them.
export const UNIVERSAL_QUESTIONS: ServiceQuestion[] = [
  Q('svc_completed', 'Service Completed?', 'yesno'),
  Q('svc_completed_date', 'Service Completed Date', 'date', { showWhen: { qid: 'svc_completed', value: 'yes' }, defaultToday: true }),
  Q('reason_not_completed', "Reason Can't Complete?", 'text', { showWhen: { qid: 'svc_completed', value: 'no' } }),
  Q('bill_trip_fee', 'Bill Trip Fee?', 'yesno', { showWhen: { qid: 'svc_completed', value: 'no' } }),
];

// The grass-cut Areas question drives the −25% back-yard rule + (soon) per-area
// photos, so its id is referenced by the submit logic.
export const GRASSCUT_AREAS_QID = 'gc_areas';
export const GRASSCUT_AREA_LABELS = ['Front Yard', 'Back Yard', 'Common Areas'];

// Per-worktype+subtype additional required questions (baseline; admin-editable).
const ADDITIONAL: Record<string, ServiceQuestion[]> = {
  'landscaping:cut': [
    Q('grass_height', 'Grass height at arrival', 'single', { opts: ['Standard (under 6 in)', 'Overgrown (6-12 in)', 'Heavy (over 12 in)'] }),
    Q(GRASSCUT_AREAS_QID, 'Which areas were cut?', 'multi', { opts: GRASSCUT_AREA_LABELS }),
    Q('gc_blown', 'Edged, blown off, and debris removed?', 'yesno'),
  ],
  // Common Areas mirrors the Grass Cut questions as a starting point (admin-editable
  // in the Form Builder). Unlike community Grass Cut, this stays a single line.
  'landscaping:common_areas': [
    Q('grass_height', 'Grass height at arrival', 'single', { opts: ['Standard (under 6 in)', 'Overgrown (6-12 in)', 'Heavy (over 12 in)'] }),
    Q(GRASSCUT_AREAS_QID, 'Which areas were cut?', 'multi', { opts: GRASSCUT_AREA_LABELS }),
    Q('gc_blown', 'Edged, blown off, and debris removed?', 'yesno'),
  ],
  'landscaping:flowers': [
    Q('flower_variety', 'Flower type / variety installed', 'text'),
    Q('beds_count', 'Number of beds serviced', 'number'),
    Q('spent_removed', 'Old / spent material removed and hauled off?', 'yesno'),
  ],
  'landscaping:tree_trimming': [
    Q('trim_scope', 'What was trimmed', 'multi', { opts: ['Trees', 'Shrubs', 'Deadwood', 'Clearance from structure'] }),
    Q('cuttings_hauled', 'All cuttings and debris hauled off?', 'yesno'),
    Q('hazards_noted', 'Any hazards noted (power lines, large limbs, damage)?', 'text'),
  ],
  'landscaping:mulch_pine_straw': [
    Q('material', 'Material applied', 'single', { opts: ['Mulch', 'Pine straw'] }),
    Q('units_installed', 'Approx. bags / units installed', 'number'),
    Q('beds_edged', 'Beds edged and left clean?', 'yesno'),
  ],
  'cleaning:common_area': [
    Q('areas_cleaned', 'Areas cleaned', 'multi', { opts: ['Lobby', 'Halls', 'Restrooms', 'Fitness', 'Mail room', 'Amenity'] }),
    Q('trash_emptied', 'Trash emptied and liners replaced?', 'yesno'),
    Q('floors_done', 'Floors vacuumed / mopped?', 'yesno'),
  ],
  'cleaning:model_home': [
    Q('rooms_detailed', 'Rooms detailed', 'multi', { opts: ['Kitchen', 'Baths', 'Bedrooms', 'Living', 'Windows/Glass'] }),
    Q('show_ready', 'Left show-ready (staging intact)?', 'yesno'),
    Q('issues_noted', 'Any damage or maintenance noted?', 'text'),
  ],
  'cleaning:move_in_clean': [
    Q('areas_cleaned', 'Areas cleaned', 'multi', { opts: ['Kitchen', 'Baths', 'Bedrooms', 'Living', 'Floors', 'Windows'] }),
    Q('appliances_cleaned', 'Appliances cleaned inside and out?', 'yesno'),
    Q('move_in_ready', 'Home move-in ready?', 'yesno'),
  ],
  'cleaning:vacant_clean': [
    Q('areas_cleaned', 'Areas cleaned', 'multi', { opts: ['Kitchen', 'Baths', 'Bedrooms', 'Living', 'Floors'] }),
    Q('debris_removed', 'All debris / trash removed from home?', 'yesno'),
    Q('issues_noted', 'Any damage or issues noted?', 'text'),
  ],
  'cleaning:one_time_clean': [
    Q('areas_cleaned', 'Areas cleaned', 'multi', { opts: ['Kitchen', 'Baths', 'Bedrooms', 'Living', 'Floors', 'Windows'] }),
    Q('special_requests', 'Any special requests completed?', 'yesno'),
    Q('condition_notes', 'Notes on condition', 'text'),
  ],
  'cleaning:on_market_clean': [
    Q('areas_cleaned', 'Areas cleaned', 'multi', { opts: ['Kitchen', 'Baths', 'Bedrooms', 'Living', 'Floors', 'Windows/Glass'] }),
    Q('listing_ready', 'Show-ready for listing photos / showings?', 'yesno'),
    Q('attention_items', 'Anything needing attention before showings?', 'text'),
  ],
  'pools:pool_cleaning': [
    Q('tasks_done', 'Tasks completed', 'multi', { opts: ['Skim', 'Brush', 'Vacuum', 'Empty baskets', 'Test chemicals'] }),
    Q('chem_balanced', 'Chemicals tested and balanced (chlorine / pH)?', 'yesno'),
    Q('equipment_ok', 'Equipment running properly?', 'yesno'),
  ],
  'trash_removal:trash_pickup': [
    Q('removed_items', 'What was removed', 'multi', { opts: ['Household trash', 'Bulk items', 'Yard debris', 'Bins to curb'] }),
    Q('load_size', 'Approx. load size', 'single', { opts: ['Small', 'Medium', 'Large', 'Full truck'] }),
    Q('area_clean', 'Area left clean?', 'yesno'),
  ],
  'trip_fee:base_trip_fee': [
    Q('trip_reason', 'Reason for the trip', 'text'),
    Q('access_obtained', 'Was access to the property obtained?', 'yesno'),
  ],
};

// Baseline default forms = the universal completion gate + each combo's additional
// questions. This is the shipped default a worktype uses until an admin overrides it
// in the Form Builder (saved forms are merged over these by combo key). NOT sample
// data — the universal question IDs (svc_completed, bill_trip_fee, …) are what the
// submit/pricing/routing logic keys off, so every combo must resolve to at least this.
export const DEFAULT_SERVICE_FORMS: Record<string, ServiceQuestion[]> = Object.fromEntries(
  Object.entries(ADDITIONAL).map(([key, extra]) => [key, [...UNIVERSAL_QUESTIONS, ...extra]]),
);

let _qid = 1000;
export const newQuestion = (): ServiceQuestion =>
  ({ id: `q${++_qid}`, label: '', type: 'yesno', required: false, requirePhoto: false, requireNote: false, enabled: true });
export const newOption = (): QuestionOption =>
  ({ id: `o${++_qid}`, label: '', priceMode: 'none', priceValue: '' });

export const answerTypeLabel = (t: AnswerType): string => ANSWER_TYPES.find((a) => a.value === t)?.label || t;
