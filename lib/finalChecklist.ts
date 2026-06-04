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
}

export interface FcDevice {
  /** The option label the inspector picks (also the device card title). */
  value: string;
  /** null = a terminal "none" choice (e.g. "No Smart Devices") with no sub-fields. */
  fields: FcDeviceField[] | null;
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
  /** property air_filters___total_quantity — the effective qty when unanswered. */
  airQtyPrefill: number | null;
  /** Whether the HubSpot field exposes any filter-size options. When false we
   *  don't hard-require filter sizes (otherwise Submit could never unlock). */
  filterOptionsAvailable: boolean;
  /** property air_filters___type__1/2/3 — count as answered when prefilled. */
  filterPrefills: (string | null)[];
}

/** How many filter-size pickers are in play given the answered/prefilled qty. */
export function fcFilterCount(a: FcAnswers, airQtyPrefill: number | null): number {
  const q = a['fc_air_filters_qty']?.quantity ?? airQtyPrefill ?? 1;
  return Math.max(1, Math.min(3, Number(q) || 1));
}

/** Build a human-readable summary of the checklist for the Master PDF. Renders
 *  each visible question as one label/value row (Title Case, prefilled values
 *  included). Empty sections are dropped. */
export function summarizeFinalChecklist(
  a: FcAnswers,
  ctx: FcCompletionCtx,
): { name: string; rows: { label: string; value: string }[] }[] {
  const out: { name: string; rows: { label: string; value: string }[] }[] = [];
  for (const section of FINAL_CHECKLIST) {
    const rows: { label: string; value: string }[] = [];
    for (const q of section.questions) {
      if (q.showWhenProperty) {
        const v = ctx.septicFee ?? 0;
        if (!(v > (q.showWhenProperty.gt ?? 0))) continue;
      }
      const ans = a[q.id] || {};
      let value = '';
      if (q.type === 'device_subform') {
        if (!ans.value) { value = '—'; }
        else {
          const dev = (q.devices || []).find((d) => d.value === ans.value);
          const parts: string[] = [];
          for (const f of (dev?.fields || [])) {
            const fv = (ans.device?.[f.id] || '').trim();
            if (fv) parts.push(`${f.label}: ${fv}`);
          }
          value = parts.length ? `${ans.value} (${parts.join(', ')})` : ans.value;
        }
      } else if (q.type === 'number') {
        const eff = ans.quantity ?? ctx.airQtyPrefill ?? q.min ?? null;
        value = eff == null ? '—' : String(eff);
      } else if (q.type === 'filter_sizes') {
        const count = fcFilterCount(a, ctx.airQtyPrefill);
        const sizes: string[] = [];
        for (let i = 0; i < count; i++) {
          let s = (ans.filterSizes?.[i] || ctx.filterPrefills[i] || '').trim();
          if (s === FC_FILTER_OTHER) s = (ans.filterSizesOther?.[i] || '').trim();
          if (s) sizes.push(s);
        }
        value = sizes.length ? sizes.join(', ') : '—';
      } else if (q.type === 'photo_set') {
        value = (q.photos || [])
          .map((p) => `${p.label}: ${((ans.stickerPhotos?.[p.id] || []).length) ? '✓' : '—'}`)
          .join('  ·  ');
      } else { // single_select
        value = ans.value || '—';
        const extras: string[] = [];
        const cnt = (q.countOnValues || []).find((c) => c.value === ans.value);
        if (cnt && ans.count != null) extras.push(`${cnt.label} ${ans.count}`);
        if ((ans.photoUrls || []).length) extras.push(`Photo ✓`);
        if (ans.note) extras.push(`Note: ${ans.note}`);
        if (ans.added) extras.push(`Added line`);
        if (extras.length) value += ` — ${extras.join(' · ')}`;
      }
      rows.push({ label: q.label, value });
    }
    if (rows.length) out.push({ name: section.name, rows });
  }
  return out;
}

/** True only when every required (and visible) checklist item is satisfied —
 *  including that each line-item prompt has been explicitly accepted or declined.
 *  Drives the Submit hard-gate. */
export function isFinalChecklistComplete(a: FcAnswers, ctx: FcCompletionCtx): boolean {
  for (const section of FINAL_CHECKLIST) {
    for (const q of section.questions) {
      if (q.showWhenProperty) {
        const v = ctx.septicFee ?? 0;            // only septic uses showWhenProperty today
        if (!(v > (q.showWhenProperty.gt ?? 0))) continue; // hidden → not required
      }
      const ans = a[q.id] || {};
      if (q.type === 'device_subform') {
        if (q.required && !ans.value) return false;
        const dev = (q.devices || []).find((d) => d.value === ans.value);
        if (dev?.fields) {
          for (const f of dev.fields) {
            if (f.required && !((ans.device?.[f.id] || '').trim())) return false;
          }
        }
      } else if (q.type === 'number') {
        // The visible default (prefill or min) counts as the answer so an
        // untouched-but-displayed value doesn't silently block Submit.
        const eff = ans.quantity ?? ctx.airQtyPrefill ?? (q.min ?? null);
        if (q.required && eff == null) return false;
      } else if (q.type === 'filter_sizes') {
        if (!ctx.filterOptionsAvailable) continue; // can't require what can't be picked
        const count = fcFilterCount(a, ctx.airQtyPrefill);
        const sizes = ans.filterSizes || [];
        for (let i = 0; i < count; i++) {
          const sel = (sizes[i] || ctx.filterPrefills[i] || '').trim();
          if (!sel) return false;
          if (sel === FC_FILTER_OTHER && !((ans.filterSizesOther?.[i] || '').trim())) return false;
        }
      } else if (q.type === 'photo_set') {
        for (const p of (q.photos || [])) {
          if (p.required && !((ans.stickerPhotos?.[p.id] || []).length)) return false;
        }
      } else { // single_select
        if (q.required && !ans.value) return false;
        if ((q.photoRequiredOnValues || []).includes(ans.value || '') && !((ans.photoUrls || []).length)) return false;
        if ((q.noteRequiredOnValues || []).includes(ans.value || '') && !((ans.note || '').trim())) return false;
        const addRule = (q.addLineOnValues || []).find((r) => r.value === ans.value);
        if (addRule && !ans.added && !ans.declined) return false;
        const cnt = (q.countOnValues || []).find((c) => c.value === ans.value);
        if (cnt && ans.count == null) return false;
      }
    }
  }
  return true;
}

export const FINAL_CHECKLIST: FcSection[] = [
  {
    id: 'smart_home_tech',
    name: 'Smart Home Tech',
    questions: [
      {
        id: 'fc_smart_home_device',
        label: 'Pick the Type of Device',
        type: 'device_subform',
        required: true,
        devices: [
          {
            value: 'Bluetooth Lock',
            fields: [
              { id: 'status', label: 'Status', type: 'single_select', options: ['Online', 'Offline'], required: true },
              { id: 'serial', label: 'Serial Number', type: 'text', required: true },
              { id: 'notes', label: 'Notes', type: 'text', required: false },
            ],
          },
          {
            value: 'Smart Home Hub',
            fields: [
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
        addLineOnValues: [
          { value: 'No', rule: { lineItemCode: 'HVACL1603', label: 'HVAC Service Clean Top Off', ...t(0) } },
        ],
      },
      {
        id: 'fc_label_stickers',
        label: 'Label Sticker Photos',
        type: 'photo_set',
        required: true,
        help: 'Photograph the Applied ResiHome Label on Each Unit.',
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
      { id: 'fc_electric', label: 'Electric', type: 'single_select', options: ['On', 'Off'], required: true },
      { id: 'fc_water', label: 'Water', type: 'single_select', options: ['On', 'Off'], required: true },
      { id: 'fc_gas', label: 'Gas', type: 'single_select', options: ['On', 'Off', 'N/A'], required: true },
      {
        id: 'fc_trash_bins',
        label: 'Trash Bins',
        type: 'single_select',
        options: ['Present', 'Missing', 'N/A'],
        required: true,
        countOnValues: [{ value: 'Present', label: 'How Many Bins?', min: 1 }],
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
    ],
  },
];
