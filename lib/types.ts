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
  | 'leasing_agent_1099_property_inspection'
  | 'pm_scope_rate_card';

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

// Summary of an Inspection record for the list view (Round A).
// Distinct from the SubmitPayload because we're reading rather than writing,
// and we only need a subset of fields for the card display.
export interface InspectionSummary {
  recordId: string;
  inspectionIdExternal: string;
  inspectionName: string;
  templateType: string;
  status: string;              // 'Scheduled' | 'In Progress' | 'Completed' | 'Cancelled' (HubSpot label)
  propertyAddressSnapshot: string;
  inspectorName: string;
  inspectorEmail: string;
  bedroomsAtInspection: number | null;
  bathroomsAtInspection: number | null;
  startedAt: string | null;
  completedAt: string | null;
  scheduledDate: string | null;
  createdAt: string | null;
  totalQuestionsAnswered: number | null;
  // The PDF URL stored on the Inspection record (from pdf_attachment_url).
  // Populated when the PDF has been generated. Empty/null for inspections that
  // haven't been submitted yet (Scheduled, In Progress) or where PDF generation failed.
  pdfUrl: string | null;
  // Region snapshot captured at Rate Card inspection start. Empty for non-Rate-Card.
  regionSnapshot: string | null;
  // Custom section list as JSON, when the inspector has edited the default
  // section layout (added/removed/renamed/reordered sections). Empty/null means
  // use auto-derived defaults from bedroomsAtInspection + bathroomsAtInspection.
  // See lib/sections.ts for the descriptor shape and merge logic.
  sectionListJson: string | null;
  // Rate Card finalize outputs. Populated by /api/inspections/[id]/finalize
  // when the inspection is completed; null/empty before that. The vendor URLs
  // are a JSON object {vendorName: url}.
  pdfMasterUrl: string | null;
  pdfChargebackUrl: string | null;
  pdfChargebackXlsxUrl: string | null;
  pdfVendorUrlsJson: string | null;
  pdfGeneratedAt: string | null;
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

// ---------------------------------------------------------------------------
// Rate Card types
// ---------------------------------------------------------------------------

/**
 * A single line from the rate_card_line_item catalog object in HubSpot.
 * 853 of these exist after the Phase 1 loader runs.
 */
export interface RateCardLineItem {
  recordId: string;                  // HubSpot record id
  lineItemCode: string;              // natural key (e.g., "APLSL1009")
  laborShortDescription: string;
  laborFullDescription: string;
  category: string;
  subcategory: string;
  laborCode: string;
  laborMeas: string;                 // EA, LF, SF, HR, etc.
  laborHours: number;
  laborHourlyRateList: number;       // reference only; actual rate comes from region matrix
  materialCode: string;
  materialDescription: string;
  materialMeas: string;
  materialRate: number;              // consumption ratio per labor unit
  materialQty: number;               // usually 1.0
  materialCost: number;              // base, pre-adjustment
  billTo: string;
  workType: string;                  // Repair / Replace / Other
  isLaborOnly: boolean;
  isBidItem: boolean;
  isActive: boolean;
  catalogVersion: string;
}

/**
 * A region pricing record from the region_rate object.
 * 18 of these exist after Phase 1.
 */
export interface RegionRate {
  recordId: string;
  region: string;                          // "GA: Atlanta"
  materialCostAdjustment: number;          // 1.0152
  materialTaxAdjustment: number;           // 0.089 (used as 1 + 0.089 in math)
  // Category-specific hourly rates. Mirror of phase1_step2's CATEGORY_TO_PROPERTY.
  rateAppliance: number;
  rateCabinet: number;
  rateCarpentry: number;
  rateCleaning: number;
  rateConcrete: number;
  rateDoors: number;
  rateDrywall: number;
  rateElectrical: number;
  rateFence: number;
  rateFlooring: number;
  rateGarageDoors: number;
  rateGutters: number;
  rateHvac: number;
  rateHvacSibiUnits: number;
  rateInspections: number;
  rateLandscape: number;
  ratePainting: number;
  ratePestControl: number;
  ratePlumbing: number;
  rateRemediation: number;
  rateRoofing: number;
  rateSeptic: number;
  rateSiding: number;
  rateTrashDebrisRemoval: number;
  rateUnitTurns: number;
  rateUtilityActivation: number;
  rateWindowsGlass: number;
  ratesVersion: string;
  isActive: boolean;
}

/**
 * Inspector-supplied inputs for a single rate card line entry.
 * Saved to inspection_answer with answer_type='rate_card_line'.
 */
export interface RateCardLineInput {
  // Stable client-generated id for autosave de-dupe (same pattern as AnswerInput)
  externalId: string;
  // Section context
  section: string;                    // e.g., "Bedroom"
  location: string;                   // e.g., "Bedroom 1" (or empty for non-repeating)
  // Catalog reference
  lineItemCode: string;
  // Inspector inputs
  quantity: number;
  tenantBillBackPercent: number;      // 0..100, in 5% increments
  assignedTo: string;                 // vendor name
  note: string;
  // Bid item overrides (only used when catalog item is_bid_item=true)
  customLaborRate?: number | null;
  customAdjustedMaterialCost?: number | null;
  // Direct vendor cost override (any line). When set, REPLACES the computed
  // vendor_cost from the formula. Client = override * 1.20; tenant = client * %.
  // Labor/material totals still get snapshotted from the formula for traceability,
  // but they don't drive the final money.
  customVendorCost?: number | null;
  // Optional photos (same pattern as AnswerInput.photoUrls)
  photoUrls: string[];
  // Custom description override (inspector may edit the catalog's full description per Q-J)
  customLaborFullDescription?: string;
}

