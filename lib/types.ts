// Types for the inspection app

export type ResponseType =
  | 'single_select'
  | 'multi_select'
  | 'boolean'
  | 'text'
  | 'number'
  | 'date'
  | 'photo_only'
  | 'signature';

export type TemplateType =
  | 'pm_scope_inspection'
  | 'pm_turn_inspection'
  | 'pm_community_inspection'
  | 'pm_vacancy_occupancy_check'
  | 'qc_new_construction_rrqc'
  | 'leasing_agent_1099_property_inspection';

export interface Question {
  hubspotRecordId: string;
  questionIdExternal: string;
  questionText: string;
  section: string;
  sectionOrder: number;
  displayOrder: number;
  responseType: ResponseType;
  responseOptions: string[];
  defaultValue: string;
  noteRequiredOnValues: string[];
  hasAssignedTo: boolean;
  assignedToOptions: string[];
  repeatsPerRoomType: string;
  appliesToTemplates: string[];
  isRequired: boolean;
  helpText: string;
}

export interface Property {
  recordId: string;
  name: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  bedrooms?: number | null;
  bathrooms?: number | null;
}

export interface HubSpotUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  fullName: string;
}

// One answer being collected for a single question
export interface AnswerInput {
  questionIdExternal: string;
  questionHubspotRecordId: string;
  questionText: string;
  section: string;
  location?: string;
  answerValue: string;
  note: string;
  // Renamed from "score" in v0.8 to match the HubSpot Inspection Answer
  // `quantity` field. Visible on Scope only when a triggered answer is selected.
  quantity: number | null;
  // Assigned to dropdown -- shows when question.hasAssignedTo is true AND answer is triggered.
  // Stored on the Inspection Answer record as the assigned_to field.
  assignedTo?: string;
  photoUrls: string[];
  // True when the inspector manually opened the optional note/photo panel.
  // The same note field is used whether or not the question is triggered;
  // this flag just tracks whether to keep the panel expanded after they collapse the answer.
  optionalPanelOpen?: boolean;
}

export type FormState = Record<string, AnswerInput>;

export interface SubmitPayload {
  templateType: TemplateType;
  propertyRecordId: string;
  propertyAddressSnapshot: string;
  inspectorName: string;
  inspectorEmail?: string;
  bedrooms: number;
  bathrooms: number;
  startedAt: string;
  completedAt: string;
  answers: AnswerInput[];
  sectionPhotoUrls: Record<string, string[]>;
}

export interface SubmitResult {
  success: boolean;
  inspectionRecordId?: string;
  inspectionExternalId?: string;
  inspectionName?: string;
  hubspotUrl?: string;
  pdfUrl?: string;
  error?: string;
}
