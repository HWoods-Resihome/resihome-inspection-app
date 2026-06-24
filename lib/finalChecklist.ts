/**
 * Final Checklist — the spec/config for the "✦ Final Checklist" section that
 * renders at the very bottom of the scope rate-card form.
 *
 * This module is the SINGLE SOURCE OF TRUTH for the section: question text,
 * options, required flags, the answer→add-line rules, property bindings, and
 * conditional visibility. The renderer (components/FinalChecklist.tsx — added in
 * a later build phase) consumes this; the Master PDF Q&A block is built from the
 * same definitions so screen and PDF never drift.
 *
 * Behaviors the generic question engine can't express (and why this lives in
 * code): device sub-forms, dependent filter dropdowns prefilled from property
 * fields, "on value → offer/auto-add a Whole-House line item", conditional
 * visibility on a property field, the trash-bin reminder, and the optional
 * septic add.
 *
 * Answers persist as inspection_answer records with answerType 'qa' (reusing the
 * existing /api/inspections/[id]/answers endpoint). Line items spawned here are
 * normal rate_card_line records routed to the Whole House section, so they flow
 * onto the vendor/chargeback/master PDFs like any other line.
 */

/** Vendor default for every auto-added Final-Checklist line. */
export const FC_DEFAULT_VENDOR = 'Vendor 1';

/** Sentinel filter-size option that reveals a free-text "different size" field. */
export const FC_FILTER_OTHER = 'Different Size';

/** A rule that adds a catalog line to Whole House when a question hits a value.
 *  `shortDescription` is matched to the live catalog by exact laborShortDescription
 *  (trimmed, case-insensitive) and resolved to its stable lineItemCode at runtime. */
export interface FcAddLineRule {
  /** Stable catalog line item code — matched directly (robust to description edits). */
  lineItemCode: string;
  /** Friendly display name for the prompt and the added-line chip. */
  label: string;
  vendor: string;                  // FC_DEFAULT_VENDOR
  quantity: number;                // default qty (1)
  tenantBillBackPercent: number;   // 100 (remotes/keys) | 0 (hvac/septic)
  /** When true, the prompt is framed as an OPTIONAL add (septic). Otherwise it's
   *  the recommended action for that answer (still declinable via "Not Needed"). */
  optional?: boolean;
}

export type FcQuestionType =
  | 'single_select'   // pill choices (always one line)
  | 'device_subform'  // smart-home: pick one device → its sub-fields
  | 'number'          // quantity stepper (prefilled from property)
  | 'filter_sizes'    // N dependent scroll-wheels, N = the quantity answer
  | 'photo_set';      // a fixed set of required photos (label stickers)

/** Sub-field shown inside a smart-home device card. */
export interface FcDeviceField {
  id: string;
  label: string;
  type: 'single_select' | 'text';
  options?: string[];
  required?: boolean;
  /** Conditional visibility: only show (and only require) this field when another
   *  field in the SAME device equals a value — e.g. the Hub's Serial Number shows
   *  only when "Did you install a new hub?" = Yes. */
  showWhen?: { field: string; equals: string };
}

export interface FcDevice {
  /** The option label the inspector picks (also the device card title). */
  value: string;
  /** null = a terminal "none" choice (e.g. "No Smart Devices") with no sub-fields. */
  fields: FcDeviceField[] | null;
}

/** The device sub-fields currently visible given the entered values — applies
 *  each field's `showWhen` against the device's other answers. Used by the
 *  renderer, the completeness gate, the rendered value, and the field stamps so
 *  a hidden conditional field is never shown, required, or recorded. */
export function fcVisibleDeviceFields(dev: FcDevice | undefined, ans: FcAnswerState): FcDeviceField[] {
  if (!dev?.fields) return [];
  return dev.fields.filter((f) => {
    if (!f.showWhen) return true;
    return (ans.device?.[f.showWhen.field] || '').trim() === f.showWhen.equals;
  });
}

export interface FcQuestion {
  id: string;                      // stable answer key (questionIdExternal)
  label: string;
  type: FcQuestionType;
  required: boolean;
  help?: string;
  options?: string[];              // for single_select

  // --- smart-home device sub-forms ---
  devices?: FcDevice[];

  // --- photo / note requirements (single_select) ---
  photoRequiredOnValues?: string[];
  photoHint?: string;              // guidance shown under the "Photo (Required)" prompt (what to capture)
  noteRequiredOnValues?: string[];
  notePrompt?: string;             // label for the required note ("Where Are They Left?")

  // --- answer → add a Whole-House line item ---
  addLineOnValues?: { value: string; rule: FcAddLineRule }[];

  // --- a small reminder banner shown when answered with these values ---
  reminderOnValues?: { value: string; text: string }[];

  // --- a follow-up count field shown when answered with these values ---
  countOnValues?: { value: string; label: string; min?: number; max?: number }[];

  // --- property bindings ---
  prefillProperty?: string;        // property field to prefill from
  optionsFromProperty?: string;    // pull dependent-dropdown options from this property field
  min?: number;
  max?: number;

  // --- conditional visibility on a property field ---
  showWhenProperty?: { field: string; gt?: number };
  // Only show when the property is associated to a Community object in HubSpot
  // (e.g. mailbox keys — non-community homes have none, so the question is hidden).
  requiresCommunity?: boolean;

  // --- photo_set ---
  photos?: { id: string; label: string; required: boolean }[];
}

export interface FcSection {
  id: string;
  name: string;
  questions: FcQuestion[];
}

const t = (pct: number): Pick<FcAddLineRule, 'vendor' | 'quantity' | 'tenantBillBackPercent'> => ({
  vendor: FC_DEFAULT_VENDOR, quantity: 1, tenantBillBackPercent: pct,
});

/** Per-question answer held by the renderer + persisted (as a JSON blob in one
 *  `qa` answer record). Only the fields relevant to a question's type are used. */
export interface FcAnswerState {
  value?: string;
  note?: string;
  photoUrls?: string[];
  quantity?: number | null;
  count?: number | null;
  device?: Record<string, string>;
  filterSizes?: string[];
  /** Free-text size when the matching filterSizes[i] is FC_FILTER_OTHER. */
  filterSizesOther?: string[];
  stickerPhotos?: Record<string, string[]>;
  added?: { externalId: string; costLabel: string } | null;
  declined?: boolean;
}
export type FcAnswers = Record<string, FcAnswerState>;

export interface FcCompletionCtx {
  /** property septic_fee — gates the conditional septic question's visibility. */
  septicFee: number | null;
  /** property pool_fee — gates the conditional Pool Condition question's
   *  visibility (shown only when known and > 0). */
  poolFee?: number | null;
  /** property air_filters___total_quantity — the effective qty when unanswered. */
  airQtyPrefill: number | null;
  /** Whether the HubSpot field exposes any filter-size options. When false we
   *  don't hard-require filter sizes (otherwise Submit could never unlock). */
  filterOptionsAvailable: boolean;
  /** property air_filters___type__1/2/3 — count as answered when prefilled. */
  filterPrefills: (string | null)[];
  /** True if a line with this catalog code already exists anywhere in the scope.
   *  When it does, the add-line prompt is auto-satisfied (no approve/decline). */
  lineExists?: (lineItemCode: string) => boolean;
  /** True when the inspection's property is associated to a Community object in
   *  HubSpot — gates community-only questions (e.g. mailbox keys). */
  hasCommunity?: boolean;
}

/** How many filter-size pickers are in play given the answered/prefilled qty. */
export function fcFilterCount(a: FcAnswers, airQtyPrefill: number | null): number {
  const q = a['fc_air_filters_qty']?.quantity ?? airQtyPrefill ?? 1;
  return Math.max(1, Math.min(3, Number(q) || 1));
}

/** Every catalog line-item code the Final Checklist can auto-add (from its
 *  add-line rules). These are hardcoded here, so a catalog edit/rename can
 *  silently orphan an FC "add line" button. Validate them against the live
 *  catalog (see /api/admin/config-check and the finalize warning). */
export function fcReferencedLineCodes(): string[] {
  const codes = new Set<string>();
  for (const section of FINAL_CHECKLIST) {
    for (const q of section.questions) {
      for (const r of (q.addLineOnValues || [])) {
        if (r.rule?.lineItemCode) codes.add(r.rule.lineItemCode);
      }
    }
  }
  return [...codes];
}

/** Subset of fcReferencedLineCodes() that are NOT present in the given catalog
 *  (a set/array of live line-item codes). Empty array = all FC codes resolve. */
export function fcMissingLineCodes(catalogCodes: Set<string> | string[]): string[] {
  const present = catalogCodes instanceof Set ? catalogCodes : new Set(catalogCodes);
  return fcReferencedLineCodes().filter((c) => !present.has(c));
}

/** Whether a question is currently shown (respects conditional visibility). */
export function fcQuestionVisible(q: FcQuestion, ctx: FcCompletionCtx): boolean {
  // Community-only questions (mailbox keys) hide on non-community properties.
  if (q.requiresCommunity && !ctx.hasCommunity) return false;
  if (q.showWhenProperty) {
    const f = q.showWhenProperty.field;
    const v = (f === 'pool_fee' ? ctx.poolFee : f === 'septic_fee' ? ctx.septicFee : null) ?? 0;
    return v > (q.showWhenProperty.gt ?? 0);
  }
  return true;
}

/** Render ONE question's answer as a human-readable string. The screen summary,
 *  the Master PDF, and the per-question HubSpot records all go through this, so
 *  the displayed value can never drift between them. `a` is the full answers map
 *  (needed for the dependent filter-size count). */
export function fcRenderValue(
  q: FcQuestion,
  ans: FcAnswerState,
  a: FcAnswers,
  ctx: FcCompletionCtx,
): string {
  if (q.type === 'device_subform') {
    if (!ans.value) return '—';
    const dev = (q.devices || []).find((d) => d.value === ans.value);
    const parts: string[] = [];
    for (const f of fcVisibleDeviceFields(dev, ans)) {
      const fv = (ans.device?.[f.id] || '').trim();
      if (fv) parts.push(`${f.label}: ${fv}`);
    }
    return parts.length ? `${ans.value} (${parts.join(', ')})` : ans.value;
  } else if (q.type === 'number') {
    const eff = ans.quantity ?? ctx.airQtyPrefill ?? q.min ?? null;
    return eff == null ? '—' : String(eff);
  } else if (q.type === 'filter_sizes') {
    const count = fcFilterCount(a, ctx.airQtyPrefill);
    const sizes: string[] = [];
    for (let i = 0; i < count; i++) {
      let s = (ans.filterSizes?.[i] || ctx.filterPrefills[i] || '').trim();
      if (s === FC_FILTER_OTHER) s = (ans.filterSizesOther?.[i] || '').trim();
      if (s) sizes.push(s);
    }
    return sizes.length ? sizes.join(', ') : '—';
  } else if (q.type === 'photo_set') {
    return (q.photos || [])
      .map((p) => `${p.label}: ${((ans.stickerPhotos?.[p.id] || []).length) ? '✓' : '—'}`)
      .join('  ·  ');
  } else { // single_select
    let value = ans.value || '—';
    const extras: string[] = [];
    const cnt = (q.countOnValues || []).find((c) => c.value === ans.value);
    if (cnt && ans.count != null) extras.push(`${cnt.label} ${ans.count}`);
    if ((ans.photoUrls || []).length) extras.push(`Photo ✓`);
    if (ans.note) extras.push(`Note: ${ans.note}`);
    if (ans.added) extras.push(`Added line`);
    if (extras.length) value += ` — ${extras.join(' · ')}`;
    return value;
  }
}

/** One structured, reportable record per VISIBLE checklist question. This is the
 *  basis for persisting each item as its own HubSpot answer object (at finalize)
 *  instead of one opaque JSON blob — so each Final Checklist item is queryable in
 *  HubSpot reporting. `state` is the raw per-question answer (for fidelity). */
export interface FcAnswerRecord {
  questionId: string;
  questionText: string;
  sectionId: string;
  sectionName: string;
  value: string;        // human-readable (same as the PDF/screen)
  state: FcAnswerState; // raw per-question answer
}

export function finalChecklistAnswerRecords(a: FcAnswers, ctx: FcCompletionCtx): FcAnswerRecord[] {
  const out: FcAnswerRecord[] = [];
  for (const section of FINAL_CHECKLIST) {
    for (const q of section.questions) {
      if (!fcQuestionVisible(q, ctx)) continue;
      const ans = a[q.id] || {};
      out.push({
        questionId: q.id,
        questionText: q.label,
        sectionId: section.id,
        sectionName: section.name,
        value: fcRenderValue(q, ans, a, ctx),
        state: ans,
      });
    }
  }
  return out;
}

/** One label/value row of the Final Checklist summary. `photos` are the photos
 *  captured FOR THIS question (per-question photos + label-sticker photos) so the
 *  PDF can anchor them directly under their line item instead of dumping every
 *  checklist photo at the bottom. */
export interface FcSummaryRow { label: string; value: string; photos?: string[]; }
export interface FcSummaryGroup { name: string; rows: FcSummaryRow[]; }

/** Build a human-readable summary of the checklist for the Master PDF. Renders
 *  each visible question as one label/value row (Title Case, prefilled values
 *  included), with that question's photos attached for inline rendering. Empty
 *  sections are dropped. */
export function summarizeFinalChecklist(
  a: FcAnswers,
  ctx: FcCompletionCtx,
  opts?: { excludeSectionIds?: string[] },
): FcSummaryGroup[] {
  const out: FcSummaryGroup[] = [];
  for (const section of FINAL_CHECKLIST) {
    // Sections the form hid (e.g. HVAC + Utilities on an OCCUPIED vacancy check)
    // must not render on the PDF either — otherwise they show as a blank section.
    if (opts?.excludeSectionIds?.includes(section.id)) continue;
    const rows: FcSummaryRow[] = [];
    for (const q of section.questions) {
      if (!fcQuestionVisible(q, ctx)) continue;
      const ans = a[q.id] || {};
      // Photos captured for THIS question — per-question photos first, then any
      // label-sticker photos (same source/order as finalChecklistPhotos).
      const photos: string[] = [];
      for (const u of (ans.photoUrls || [])) if (u) photos.push(u);
      for (const p of (q.photos || [])) for (const u of (ans.stickerPhotos?.[p.id] || [])) if (u) photos.push(u);
      rows.push({ label: q.label, value: fcRenderValue(q, ans, a, ctx), ...(photos.length ? { photos } : {}) });
    }
    if (rows.length) out.push({ name: section.name, rows });
  }
  return out;
}

/** Collect every photo URL captured in the Final Checklist — per-question photos
 *  plus all label-sticker photos — so the PDFs can render them (same as the
 *  Master report). Order: by checklist section/question, stickers after photos. */
export function finalChecklistPhotos(a: FcAnswers, opts?: { excludeSectionIds?: string[] }): string[] {
  const out: string[] = [];
  for (const section of FINAL_CHECKLIST) {
    if (opts?.excludeSectionIds?.includes(section.id)) continue;
    for (const q of section.questions) {
      const ans = a[q.id];
      if (!ans) continue;
      for (const u of (ans.photoUrls || [])) if (u) out.push(u);
      for (const p of (q.photos || [])) for (const u of (ans.stickerPhotos?.[p.id] || [])) if (u) out.push(u);
    }
  }
  return out;
}

/** The first unmet (visible, required) checklist item, described for the user
 *  (e.g. "HVAC & Air Filters · Label Sticker Photos: add the Air Handler photo").
 *  Returns null when the checklist is complete. Single source of truth for both
 *  the completeness gate and the submit tooltip/flash. */
// Per-question completeness. Returns the short reason it's INCOMPLETE, or null
// when satisfied. Shared by the submit gate and the section progress counts so
// they can never diverge.
function fcQuestionGap(
  q: FcQuestion, ans: FcAnswerState, ctx: FcCompletionCtx, a: FcAnswers,
  opts?: { skipLineRules?: boolean }
): string | null {
  if (q.type === 'device_subform') {
    if (q.required && !ans.value) return 'choose a device type';
    const dev = (q.devices || []).find((d) => d.value === ans.value);
    for (const f of fcVisibleDeviceFields(dev, ans)) {
      if (f.required && !((ans.device?.[f.id] || '').trim())) return `${f.label} required`;
    }
    return null;
  }
  if (q.type === 'number') {
    const eff = ans.quantity ?? ctx.airQtyPrefill ?? q.min ?? null;
    if (q.required && eff == null) return 'enter a value';
    return null;
  }
  if (q.type === 'filter_sizes') {
    if (!ctx.filterOptionsAvailable) return null;
    const count = fcFilterCount(a, ctx.airQtyPrefill);
    const sizes = ans.filterSizes || [];
    for (let i = 0; i < count; i++) {
      const sel = (sizes[i] || ctx.filterPrefills[i] || '').trim();
      if (!sel) return `select Filter Size #${i + 1}`;
      if (sel === FC_FILTER_OTHER && !((ans.filterSizesOther?.[i] || '').trim())) return `enter the custom Filter Size #${i + 1}`;
    }
    return null;
  }
  if (q.type === 'photo_set') {
    for (const p of (q.photos || [])) {
      if (p.required && !((ans.stickerPhotos?.[p.id] || []).length)) return `add the ${p.label} photo`;
    }
    return null;
  }
  // single_select
  if (q.required && !ans.value) return 'choose an answer';
  if ((q.photoRequiredOnValues || []).includes(ans.value || '') && !((ans.photoUrls || []).length)) return 'add a photo';
  if ((q.noteRequiredOnValues || []).includes(ans.value || '') && !((ans.note || '').trim())) return 'add a note';
  const cnt = (q.countOnValues || []).find((c) => c.value === ans.value);
  if (cnt && ans.count == null) return cnt.label;
  const addRule = (q.addLineOnValues || []).find((r) => r.value === ans.value);
  if (addRule && !opts?.skipLineRules && !ans.added && !ans.declined && !ctx.lineExists?.(addRule.rule.lineItemCode)) {
    return 'add or decline the suggested line';
  }
  return null;
}

export function finalChecklistGap(a: FcAnswers, ctx: FcCompletionCtx, opts?: { onlySectionIds?: string[]; skipLineRules?: boolean }): string | null {
  for (const section of FINAL_CHECKLIST) {
    if (opts?.onlySectionIds && !opts.onlySectionIds.includes(section.id)) continue;
    for (const q of section.questions) {
      if (!fcQuestionVisible(q, ctx)) continue;
      const g = fcQuestionGap(q, a[q.id] || {}, ctx, a, opts);
      if (g) return `${section.name} · ${q.label}: ${g}`;
    }
  }
  return null;
}

/** Answered/total counts for one Final Checklist section (visible questions
 *  only) — drives the "X/Y" pill and the form's header total. */
export function fcSectionCounts(
  a: FcAnswers, ctx: FcCompletionCtx, sectionId: string,
  opts?: { skipLineRules?: boolean }
): { completed: number; total: number } {
  const section = FINAL_CHECKLIST.find((s) => s.id === sectionId);
  if (!section) return { completed: 0, total: 0 };
  let completed = 0, total = 0;
  for (const q of section.questions) {
    if (!fcQuestionVisible(q, ctx)) continue;
    total++;
    if (!fcQuestionGap(q, a[q.id] || {}, ctx, a, opts)) completed++;
  }
  return { completed, total };
}

/** Parse the persisted Final Checklist blob (one `qa` record's JSON `note`) back
 *  into FcAnswers. Returns {} on anything malformed. */
export function parseFcAnswers(note: string | null | undefined): FcAnswers {
  try { return note ? (JSON.parse(note) as FcAnswers) : {}; } catch { return {}; }
}

/** Smart Home Tech values mirrored to their own inspection fields at completion:
 *    deviceType      — the selected Device Type (Bluetooth Lock / Smart Home Hub
 *                      / No Smart Devices); '' when unanswered
 *    deviceInstalled — the "Did you install a new lock/hub?" answer (Yes/No)
 *    serialNumber    — the device Serial Number (only when that field is visible:
 *                      always for a Bluetooth Lock, and for a Smart Home Hub only
 *                      when a new hub was installed) */
export function fcSmartHomeStamps(a: FcAnswers): { deviceType: string; deviceInstalled: string; serialNumber: string } {
  const ans = a['fc_smart_home_device'] || {};
  const picked = (ans.value || '').trim();
  const section = FINAL_CHECKLIST.find((s) => s.id === 'smart_home_tech');
  const q = section?.questions.find((x) => x.id === 'fc_smart_home_device');
  const dev = (q?.devices || []).find((d) => d.value === picked);
  if (!dev || !dev.fields) return { deviceType: picked, deviceInstalled: '', serialNumber: '' };
  const visible = fcVisibleDeviceFields(dev, ans);
  const get = (id: string) => (ans.device?.[id] || '').trim();
  return {
    deviceType: picked,
    deviceInstalled: get('installed_new'),
    serialNumber: visible.some((f) => f.id === 'serial') ? get('serial') : '',
  };
}

/** Pool Condition values mirrored to their own inspection fields at completion:
 *    poolCondition  — the Pass/Fail answer ('' when the question wasn't shown)
 *    poolFeedback   — the required note when Failed (the "what's wrong" reason)
 *    poolPhotoUrls  — the pool photo(s) (required on Fail), newline-joined so they
 *                     land in a single text field on the inspection */
export function fcPoolStamps(a: FcAnswers): { poolCondition: string; poolFeedback: string; poolPhotoUrls: string } {
  const ans = a['fc_pool_condition'] || {};
  return {
    poolCondition: (ans.value || '').trim(),
    poolFeedback: (ans.note || '').trim(),
    poolPhotoUrls: (ans.photoUrls || []).filter(Boolean).join('\n'),
  };
}

/** True only when every required (and visible) checklist item is satisfied —
 *  including that each line-item prompt has been explicitly accepted or declined.
 *  Derived from finalChecklistGap so the gate and the message can never diverge. */
export function isFinalChecklistComplete(a: FcAnswers, ctx: FcCompletionCtx): boolean {
  return finalChecklistGap(a, ctx) === null;
}

export const FINAL_CHECKLIST: FcSection[] = [
  {
    id: 'smart_home_tech',
    name: 'Smart Home Tech',
    questions: [
      {
        id: 'fc_smart_home_device',
        label: 'Device Type',
        type: 'device_subform',
        required: true,
        devices: [
          {
            value: 'Bluetooth Lock',
            fields: [
              { id: 'installed_new', label: 'Did you install a new lock?', type: 'single_select', options: ['Yes', 'No'], required: true },
              { id: 'status', label: 'Status', type: 'single_select', options: ['Online', 'Offline'], required: true },
              { id: 'serial', label: 'Serial Number', type: 'text', required: true },
            ],
          },
          {
            value: 'Smart Home Hub',
            fields: [
              { id: 'installed_new', label: 'Did you install a new hub?', type: 'single_select', options: ['Yes', 'No'], required: true },
              // Serial Number shows + is required only when a new hub was installed.
              { id: 'serial', label: 'Serial Number', type: 'text', required: true, showWhen: { field: 'installed_new', equals: 'Yes' } },
              { id: 'status', label: 'Status', type: 'single_select', options: ['Online', 'Offline'], required: true },
              { id: 'location', label: 'Location of Hub', type: 'text', required: true },
            ],
          },
          { value: 'No Smart Devices', fields: null },
        ],
      },
    ],
  },

  {
    id: 'access_keys',
    name: 'Access & Keys',
    questions: [
      {
        id: 'fc_garage_remote',
        label: 'Garage Remote Present?',
        type: 'single_select',
        options: ['Yes', 'No', 'N/A'],
        required: true,
        photoRequiredOnValues: ['Yes'],
        noteRequiredOnValues: ['Yes'],
        notePrompt: 'Where Are They Left?',
        addLineOnValues: [
          { value: 'No', rule: { lineItemCode: 'GADRL1037', label: 'Universal Garage Remotes', ...t(100) } },
        ],
      },
      {
        id: 'fc_mailbox_keys',
        label: 'Mailbox Keys Present?',
        type: 'single_select',
        options: ['Yes', 'No', 'N/A'],
        required: true,
        // Only community-associated properties have mailboxes/keys; hide otherwise.
        requiresCommunity: true,
        photoRequiredOnValues: ['Yes'],
        noteRequiredOnValues: ['Yes'],
        notePrompt: 'Where Are They Left?',
        addLineOnValues: [
          { value: 'No', rule: { lineItemCode: 'CARPL1047', label: 'Replace Mailbox Key', ...t(100) } },
        ],
      },
    ],
  },

  {
    id: 'hvac_air_filters',
    name: 'HVAC & Air Filters',
    questions: [
      {
        id: 'fc_hvac_functioning',
        label: 'HVAC Functioning?',
        type: 'single_select',
        options: ['Yes', 'No'],
        required: true,
        // If it's not functioning, capture what's wrong.
        noteRequiredOnValues: ['No'],
        notePrompt: 'What is wrong with the HVAC?',
        addLineOnValues: [
          { value: 'No', rule: { lineItemCode: 'HVACL1603', label: 'HVAC Service Clean Top Off', ...t(0) } },
        ],
      },
      {
        id: 'fc_label_stickers',
        label: 'Label Sticker Photos',
        type: 'photo_set',
        required: true,
        help: 'Photograph the appliance label showing the Model & Serial #.',
        photos: [
          { id: 'air_handler', label: 'Air Handler', required: true },
          { id: 'outside_condenser', label: 'Outside Condenser', required: true },
          { id: 'water_heater', label: 'Water Heater', required: true },
        ],
      },
      {
        id: 'fc_air_filters_qty',
        label: 'Air Filters — Total Quantity',
        type: 'number',
        required: true,
        help: 'Pre-Filled From the Property Record — Confirm or Correct (Whole Number, 1–3).',
        prefillProperty: 'air_filters___total_quantity',
        min: 1,
        max: 3,
      },
      {
        id: 'fc_filter_sizes',
        label: 'Filter Size',
        type: 'filter_sizes',
        required: true,
        // count driven by fc_air_filters_qty; one wheel per filter, prefilled from
        // air_filters___type__1 / __2 / __3, options pulled from those fields.
        optionsFromProperty: 'air_filters___type__',
        prefillProperty: 'air_filters___type__',
      },
    ],
  },

  {
    id: 'utilities',
    name: 'Utilities',
    questions: [
      // Utilities: if a meter is shut OFF, require a photo of the meter AND the
      // meter number so the turn team / next tenant can have it reconnected.
      { id: 'fc_electric', label: 'Electric', type: 'single_select', options: ['On', 'Off'], required: true,
        photoRequiredOnValues: ['Off'], photoHint: 'Photo of the meter (showing the reading).',
        noteRequiredOnValues: ['Off'], notePrompt: 'Meter Number' },
      { id: 'fc_water', label: 'Water', type: 'single_select', options: ['On', 'Off'], required: true,
        photoRequiredOnValues: ['Off'], photoHint: 'Photo of the meter (showing the reading).',
        noteRequiredOnValues: ['Off'], notePrompt: 'Meter Number' },
      { id: 'fc_gas', label: 'Gas', type: 'single_select', options: ['On', 'Off', 'N/A'], required: true,
        photoRequiredOnValues: ['Off'], photoHint: 'Photo of the meter (showing the reading).',
        noteRequiredOnValues: ['Off'], notePrompt: 'Meter Number' },
      {
        id: 'fc_trash_bins',
        label: 'Trash Bins',
        type: 'single_select',
        options: ['Present', 'Missing', 'N/A'],
        required: true,
        photoRequiredOnValues: ['Present'],
        photoHint: 'Photograph the bins with the trash provider’s logo visible on the bin.',
        countOnValues: [{ value: 'Present', label: 'How Many Bins?', min: 1, max: 5 }],
        reminderOnValues: [{
          value: 'Present',
          text: 'Reminder: If the bins are empty, please move them to the side of the home or inside the garage before you leave.',
        }],
      },
      {
        id: 'fc_septic',
        label: 'Septic System',
        type: 'single_select',
        options: ['Needs Pump-Out', 'OK'],
        required: true,
        help: 'Shown Because This Property Has a Septic Fee on File.',
        showWhenProperty: { field: 'septic_fee', gt: 0 },
        addLineOnValues: [
          { value: 'Needs Pump-Out', rule: { lineItemCode: 'SPTCL1003', label: 'Septic Pump Out', ...t(0), optional: true } },
        ],
      },
      {
        id: 'fc_pool_condition',
        label: 'Pool Condition',
        type: 'single_select',
        options: ['Pass', 'Fail'],
        required: true,
        help: 'Shown Because This Property Has a Pool Fee on File.',
        // Only visible when the property carries a pool fee (known and > 0).
        showWhenProperty: { field: 'pool_fee', gt: 0 },
        // On Fail, require photo evidence AND a written reason.
        photoRequiredOnValues: ['Fail'],
        photoHint: 'Photo of the pool showing its condition.',
        noteRequiredOnValues: ['Fail'],
        notePrompt: 'What is wrong with the pool?',
      },
    ],
  },
];
