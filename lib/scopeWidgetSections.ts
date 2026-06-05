// lib/scopeWidgetSections.ts
//
// The Scope Rate Card's "HVAC & Air Filters" and "Smart Home" sections (defined
// in lib/finalChecklist.ts) replicated for the question-driven templates (1099,
// occupancy, community, RRQC). The QuestionForm intercepts any section whose
// name looks like HVAC or Smart Home and renders THESE synthetic questions in
// place of the HubSpot-defined ones.
//
// Each synthetic field is a normal Question, so it flows through QuestionForm's
// existing state, hydration, autosave and submit — i.e. every field persists as
// its own Answer record (keyed by answer_id_external). Synthetic questions carry
// no HubSpot question record id; the answer→question association is best-effort
// (lib/hubspot.ts upsertAnswers skips it when absent), so nothing breaks.
//
// Behaviour the QuestionForm layers on top, driven by the WidgetMeta map:
//   - prefillFrom: seed the answer from a Property field (air-filter qty/types)
//   - isFilterQty: this answer syncs back to air_filters___total_quantity
//   - filterIndex: a filter-size field — visible/required only when qty >= index,
//                  and syncs back to air_filters___type__<index>
//   - showWhen: visible/required only when a sibling answer has one of the values

import type { Question, ResponseType } from '@/lib/types';

export interface WidgetMeta {
  prefillFrom?: string;
  isFilterQty?: boolean;
  filterIndex?: number;
  showWhen?: { questionId: string; values: string[] };
  min?: number;
  max?: number;
}
export type WidgetMetaMap = Record<string, WidgetMeta>;

// Section-name detectors. The HubSpot section these replace may be named a few
// ways ("HVAC", "HVAC & Air Filters", "Smart Home", "Smart Home / Lock"…).
export function isHvacSection(name: string): boolean {
  return /\bhvac\b/i.test(name) || /air\s*filter/i.test(name);
}
export function isSmartHomeSection(name: string): boolean {
  return /smart\s*home/i.test(name) || /smart\s*lock/i.test(name);
}

function mkQ(p: {
  questionIdExternal: string;
  questionText: string;
  section: string;
  sectionOrder: number;
  displayOrder: number;
  responseType: ResponseType;
  responseOptions?: string[];
  isRequired?: boolean;
  helpText?: string;
}): Question {
  return {
    hubspotRecordId: '',
    questionIdExternal: p.questionIdExternal,
    questionText: p.questionText,
    section: p.section,
    sectionOrder: p.sectionOrder,
    displayOrder: p.displayOrder,
    responseType: p.responseType,
    responseOptions: p.responseOptions ?? [],
    defaultValue: '',
    noteRequiredOnValues: [],
    hasAssignedTo: false,
    assignedToOptions: [],
    repeatsPerRoomType: '',
    appliesToTemplates: [],
    isRequired: p.isRequired ?? true,
    helpText: p.helpText ?? '',
  };
}

// HVAC & Air Filters — mirrors lib/finalChecklist.ts (minus the rate-card line
// adds and the septic question, per the product decision). HVAC Functioning is
// a plain Yes/No here (no vendor — that's Scope-only).
export function buildHvacQuestions(
  sectionName: string,
  sectionOrder: number,
  filterSizeOptions: string[]
): { questions: Question[]; meta: WidgetMetaMap } {
  const meta: WidgetMetaMap = {};
  const qs: Question[] = [];
  let d = 0;

  qs.push(mkQ({
    questionIdExternal: 'fc_hvac_functioning', questionText: 'HVAC Functioning?',
    section: sectionName, sectionOrder, displayOrder: d++,
    responseType: 'single_select', responseOptions: ['Yes', 'No'],
  }));

  for (const [id, label] of [
    ['air_handler', 'Air Handler'],
    ['outside_condenser', 'Outside Condenser'],
    ['water_heater', 'Water Heater'],
  ] as const) {
    qs.push(mkQ({
      questionIdExternal: `fc_label_${id}`, questionText: `Label Sticker — ${label}`,
      section: sectionName, sectionOrder, displayOrder: d++,
      responseType: 'photo_only',
      helpText: 'Photograph the appliance label showing the Model & Serial #.',
    }));
  }

  qs.push(mkQ({
    questionIdExternal: 'fc_air_filters_qty', questionText: 'Air Filters — Total Quantity',
    section: sectionName, sectionOrder, displayOrder: d++,
    responseType: 'number',
    helpText: 'Pre-filled from the property record — confirm or correct (whole number, 1–3).',
  }));
  meta['fc_air_filters_qty'] = { prefillFrom: 'air_filters___total_quantity', isFilterQty: true, min: 1, max: 3 };

  const useSelect = filterSizeOptions.length > 0;
  for (let i = 1; i <= 3; i++) {
    qs.push(mkQ({
      questionIdExternal: `fc_filter_size_${i}`, questionText: `Filter ${i} Size`,
      section: sectionName, sectionOrder, displayOrder: d++,
      responseType: useSelect ? 'single_select' : 'text',
      responseOptions: useSelect ? filterSizeOptions : [],
    }));
    meta[`fc_filter_size_${i}`] = { prefillFrom: `air_filters___type__${i}`, filterIndex: i };
  }

  return { questions: qs, meta };
}

// Smart Home — mirrors lib/finalChecklist.ts smart_home_tech: pick one device
// type, then fill that device's sub-fields.
export function buildSmartHomeQuestions(
  sectionName: string,
  sectionOrder: number
): { questions: Question[]; meta: WidgetMetaMap } {
  const meta: WidgetMetaMap = {};
  const qs: Question[] = [];
  let d = 0;

  qs.push(mkQ({
    questionIdExternal: 'fc_smart_home_device', questionText: 'Device Type',
    section: sectionName, sectionOrder, displayOrder: d++,
    responseType: 'single_select',
    responseOptions: ['Bluetooth Lock', 'Smart Home Hub', 'No Smart Devices'],
  }));

  qs.push(mkQ({
    questionIdExternal: 'fc_sh_status', questionText: 'Status',
    section: sectionName, sectionOrder, displayOrder: d++,
    responseType: 'single_select', responseOptions: ['Online', 'Offline'],
  }));
  meta['fc_sh_status'] = { showWhen: { questionId: 'fc_smart_home_device', values: ['Bluetooth Lock', 'Smart Home Hub'] } };

  qs.push(mkQ({
    questionIdExternal: 'fc_sh_serial', questionText: 'Serial Number',
    section: sectionName, sectionOrder, displayOrder: d++,
    responseType: 'text',
  }));
  meta['fc_sh_serial'] = { showWhen: { questionId: 'fc_smart_home_device', values: ['Bluetooth Lock'] } };

  qs.push(mkQ({
    questionIdExternal: 'fc_sh_location', questionText: 'Location of Hub',
    section: sectionName, sectionOrder, displayOrder: d++,
    responseType: 'text',
  }));
  meta['fc_sh_location'] = { showWhen: { questionId: 'fc_smart_home_device', values: ['Smart Home Hub'] } };

  return { questions: qs, meta };
}
