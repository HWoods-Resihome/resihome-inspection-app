/**
 * Form builder — shared metadata + guardrails.
 *
 * The form builder lets admins edit the QUESTION-driven inspection templates
 * (add/edit/remove/reorder/toggle questions, change answer types) syncing to
 * HubSpot. Two templates are HARD-LOCKED: Scope Rate Card and Turn Re-Inspect
 * QC. Their behavior is wired into rate-card/QC code (not just questions), so
 * editing them here could silently break finalize/pricing/QC — never allow it.
 *
 * Phase 2 makes the editable template list dynamic; for now it's the four
 * question-driven templates.
 */
import type { ResponseType } from '@/lib/types';

export const PROTECTED_TEMPLATES = ['pm_scope_rate_card', 'pm_turn_reinspect_qc'];

export function isProtectedTemplate(t: string): boolean {
  return PROTECTED_TEMPLATES.includes(String(t).trim());
}

/** True if a question is attached to ANY protected template (so it's off-limits). */
export function touchesProtectedTemplate(applies: string[]): boolean {
  return (applies || []).some(isProtectedTemplate);
}

export interface EditableTemplate { id: string; label: string; }

// The question-driven templates the builder may edit. (Phase 2: load dynamically.)
export const EDITABLE_TEMPLATES: EditableTemplate[] = [
  { id: 'pm_community_inspection', label: 'Community / Visit Inspection' },
  { id: 'pm_vacancy_occupancy_check', label: 'Vacancy / Occupancy Check' },
  { id: 'qc_new_construction_rrqc', label: 'New Construction RRQC' },
  { id: 'leasing_agent_1099_property_inspection', label: 'Leasing Agent (1099) Inspection' },
];

export function isEditableTemplate(t: string): boolean {
  return EDITABLE_TEMPLATES.some((e) => e.id === t) && !isProtectedTemplate(t);
}

// Answer types an admin can pick, with friendly labels + whether they take options.
export const RESPONSE_TYPES: { value: ResponseType; label: string; hasOptions: boolean }[] = [
  { value: 'single_select', label: 'Single choice (dropdown/radio)', hasOptions: true },
  { value: 'multi_select', label: 'Multiple choice (checkboxes)', hasOptions: true },
  { value: 'boolean', label: 'Yes / No', hasOptions: false },
  { value: 'text', label: 'Text', hasOptions: false },
  { value: 'number', label: 'Number', hasOptions: false },
  { value: 'date', label: 'Date', hasOptions: false },
  { value: 'photo_only', label: 'Photo only', hasOptions: false },
  { value: 'signature', label: 'Signature', hasOptions: false },
];

export const RESPONSE_TYPE_VALUES = RESPONSE_TYPES.map((r) => r.value);

// The standard section names (mirrors lib/sections.ts SECTION_ORDER, plus the
// repeating room types) offered in the form builder's Section dropdown. Admins
// can also add a new section name via free text.
export const STANDARD_SECTIONS: string[] = [
  'Yard / Exterior', 'Entry / Foyer', 'Family / Living Room', 'Dining Room',
  'Kitchen', 'Hallway / Stairs', 'Bedroom', 'Bathroom', 'Half Bath',
  'Laundry Room', 'Garage', 'Whole House', 'HVAC / Mechanicals', 'Smart Home / Locks',
];

export interface QuestionInput {
  questionText?: string;
  section?: string;
  sectionOrder?: number;
  displayOrder?: number;
  responseType?: ResponseType;
  responseOptions?: string[];
  defaultValue?: string;
  noteRequiredOnValues?: string[];
  hasAssignedTo?: boolean;
  assignedToOptions?: string[];
  repeatsPerRoomType?: string;
  appliesToTemplates?: string[];
  isRequired?: boolean;
  helpText?: string;
  enabled?: boolean;
  requiresPhoto?: boolean;
}

/** Map an admin form input to HubSpot inspection_question properties. Only the
 *  keys present on `input` are emitted, so it works for partial (PATCH) updates. */
export function questionInputToProps(input: QuestionInput): Record<string, string> {
  const props: Record<string, string> = {};
  const pipe = (a?: string[]) => (a || []).map((s) => String(s).trim()).filter(Boolean).join('|');
  if (input.questionText !== undefined) props.question_text = String(input.questionText).slice(0, 500);
  if (input.section !== undefined) props.section = String(input.section).slice(0, 120);
  if (input.sectionOrder !== undefined) props.section_order = String(Number(input.sectionOrder) || 0);
  if (input.displayOrder !== undefined) props.display_order = String(Number(input.displayOrder) || 0);
  if (input.responseType !== undefined) props.response_type = String(input.responseType);
  if (input.responseOptions !== undefined) props.response_options = pipe(input.responseOptions);
  if (input.defaultValue !== undefined) props.default_value = String(input.defaultValue).slice(0, 500);
  if (input.noteRequiredOnValues !== undefined) props.note_required_on_values = pipe(input.noteRequiredOnValues);
  if (input.hasAssignedTo !== undefined) props.has_assigned_to = input.hasAssignedTo ? 'true' : 'false';
  if (input.assignedToOptions !== undefined) props.assigned_to_options = pipe(input.assignedToOptions);
  if (input.repeatsPerRoomType !== undefined) props.repeats_per_room_type = String(input.repeatsPerRoomType).slice(0, 60);
  if (input.appliesToTemplates !== undefined) props.applies_to_templates = pipe(input.appliesToTemplates);
  if (input.isRequired !== undefined) props.is_required = input.isRequired ? 'true' : 'false';
  if (input.helpText !== undefined) props.help_text = String(input.helpText).slice(0, 1000);
  if (input.enabled !== undefined) props.is_enabled = input.enabled ? 'true' : 'false';
  if (input.requiresPhoto !== undefined) props.requires_photo = input.requiresPhoto ? 'true' : 'false';
  return props;
}
