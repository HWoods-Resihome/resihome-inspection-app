import { Fragment, useMemo, useState, useCallback, useEffect, useRef } from 'react';
import type { Question, AnswerInput, TemplateType } from '@/lib/types';
import type { SavedAnswer } from '@/lib/hubspot';
import { QuestionItem, answerTone, isNA, isListingPriceQuestion, wantsRecommendedPrice } from './QuestionItem';
import { CameraCapture } from './CameraCapture';
import { PhotoLightbox } from '@/components/PhotoLightbox';
import { uploadFilesBatch } from '@/lib/photoUpload';
import { uploadPhotoOrQueue, uploadVideoEntryOrQueue, rehydrateQueuedPhotos, flushQueuedPhotos, onPhotoFlushResume, countQueuedPhotos } from '@/lib/offlinePhotoStore';
import { flushOutbox } from '@/lib/offlineOutbox';
import { loadCachedAnswers, saveCachedAnswers, clearCachedAnswers } from '@/lib/offlineCache';
import { useAnyCameraOpen } from '@/lib/cameraOpenState';
import { useStorageQuota, formatMB } from '@/lib/storageQuota';
import { PhotoThumb } from '@/components/PhotoThumb';
import { isVideoEntry } from '@/lib/media';
import { useAppDialog } from '@/components/AppDialog';

// Whether this browser supports the camera API. SSR-safe.
const hasMediaDevices = typeof navigator !== 'undefined'
  && !!navigator.mediaDevices?.getUserMedia;
import { useAutosave } from '@/lib/useAutosave';
import { SaveIndicator } from '@/components/inspection/SaveIndicator';
import { buildQaAnswerProps, buildSectionPhotoAnswerProps } from '@/lib/answerProps';
import { isHvacSection, isSmartHomeSection } from '@/lib/scopeWidgetSections';
import { FinalChecklist } from '@/components/FinalChecklist';
import { SyncingBadge } from '@/components/SyncingBadge';
import { UnlockButton } from '@/components/UnlockButton';
import { FitText } from '@/components/FitText';
import { openPdf } from '@/lib/pdfViewerBus';
import {
  finalChecklistGap, fcSectionCounts, summarizeFinalChecklist, finalChecklistPhotos,
  type FcAnswers, type FcAnswerState, type FcCompletionCtx,
} from '@/lib/finalChecklist';

// Extra outcome data passed up at submit (beyond answers/photos): the overall
// Review & Sign-Off verdict (→ inspection_result) and, for 1099/vacancy fails,
// whether the inspector asked to raise a maintenance ticket + its description.
export interface QuestionFormSubmitMeta {
  inspectionResult: 'pass' | 'fail' | null;
  maintenanceTicket: { wanted: boolean; description: string };
  /** Final Checklist (HVAC/Smart Home/Air Filters) summarized for the PDF. */
  finalChecklist?: { name: string; rows: { label: string; value: string }[] }[];
  /** Final Checklist sticker/label photo URLs for the PDF. */
  finalChecklistPhotos?: string[];
}

type Props = {
  questions: Question[];
  templateType: TemplateType;
  templateLabel: string;
  inspectorName: string;
  propertyName: string;
  /** Property record id — used to validate camera GPS against the property. */
  propertyRecordId?: string;
  bedrooms: number;
  bathrooms: number;
  /** Property's square footage (from `square_footage` on the property object).
   *  Optional — shown in the header next to bed/bath if present. */
  squareFootage?: number | null;
  /** Property lifecycle status (Turnkey / Vacant / Unmarketed / …) — shown on
   *  its own line in the header. */
  propertyStatus?: string | null;
  /** Move-in Ready date from the listing (M/D/YY) — shown as "MIR: …" to the
   *  right of the property status. */
  moveInReadyDate?: string | null;
  /** Inspection's region snapshot (used in the header subtitle). */
  inspectionRegion?: string;
  /** Inspection status + submitted timestamp — drive the header status badge and
   *  the (conditional) "Submitted" stamp, matching the Scope header. */
  status?: string;
  submittedAt?: string | null;
  /** Most-recent active listing price + listing date for the property, shown in
   *  the header. Pulled from the most recent published listing (or, if none is
   *  published, the most recent in "deposit taken"). Optional — omitted if the
   *  property has no qualifying listing or the listing object isn't configured. */
  listingPrice?: number | null;
  listingDate?: string | null;
  /** Listing status (e.g. "Active" / "Deposit Taken") shown in front of the price. */
  listingStatus?: string | null;
  /** Community/Visit only: the name of the community associated with the
   *  property, shown above the address in the header. */
  communityName?: string | null;
  /** Property air-filter fields — prefill the HVAC widget and are written back
   *  to the property as the inspector confirms/corrects them. */
  propertyAirFiltersTotal?: number | null;
  propertyAirFiltersType1?: string | null;
  propertyAirFiltersType2?: string | null;
  propertyAirFiltersType3?: string | null;
  /** Air-filter size dropdown options (from the HubSpot property field defs). */
  filterSizeOptions?: string[];
  onSubmit: (answers: AnswerInput[], sectionPhotoUrls: Record<string, string[]>, meta?: QuestionFormSubmitMeta) => void;
  onCancel: () => void;

  // Round B additions:
  // -- The HubSpot Inspection record ID (used for autosave POSTs)
  inspectionRecordId: string;
  // -- The Inspection's external ID (used as a prefix for answer external IDs)
  inspectionExternalId: string;
  // -- PDF URL for this inspection (only present after submit; shown as a link
  //    in the sticky header so the user can view the generated report).
  pdfUrl?: string | null;
  // -- Existing saved answers from HubSpot (when re-opening an in-progress inspection)
  existingAnswers?: SavedAnswer[];
  // -- Read-only mode (for Completed inspections, until user clicks Reopen)
  readOnly?: boolean;
  // -- Called when first user edit happens (for the Scheduled -> In Progress transition)
  onFirstEdit?: () => void;
  // -- Called when user clicks Cancel Inspection (different from form Cancel/Exit)
  onCancelInspection?: () => void;
};

// Status pill (mirrors the Scope Rate Card header).
function statusBadge(status?: string): { label: string; color: string } | null {
  switch ((status || '').trim().toLowerCase()) {
    case 'scheduled': return { label: 'Scheduled', color: 'bg-blue-100 text-blue-800 border-blue-200' };
    case 'in progress': case 'in-progress': case 'in_progress': return { label: 'In Progress', color: 'bg-amber-100 text-amber-800 border-amber-200' };
    case 'pending approval': case 'pending_approval': case 'pending-approval': case 'pendingapproval': return { label: 'Pending Approval', color: 'bg-purple-100 text-purple-800 border-purple-200' };
    case 'completed': case 'complete': case 'submitted': return { label: 'Completed', color: 'bg-emerald-100 text-emerald-800 border-emerald-200' };
    case 'cancelled': case 'canceled': return { label: 'Cancelled', color: 'bg-gray-100 text-gray-700 border-gray-200' };
    default: return null;
  }
}
// Format an ISO/epoch timestamp to M/D/YYYY (header "Submitted" stamp).
function fmtStamp(v?: string | null): string {
  if (!v) return '';
  const t = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  if (!isFinite(t) || isNaN(t)) return '';
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

// FitText is shared (components/FitText.tsx) — single-line auto-shrink text.

// Sections that do NOT require a section photo.
function sectionPhotosExempt(sectionName: string, sectionOrder: number, templateType?: string): boolean {
  if (sectionOrder === 10 || sectionOrder === 190 || sectionOrder === 900 || sectionOrder === 910) return true;
  const lower = sectionName.toLowerCase();
  if (lower.includes('overview')) return true;
  if (lower.includes('review') && lower.includes('sign')) return true;
  if (lower.includes('summary')) return true;
  if (lower.includes('hap')) return true;
  // Vacant Units: the evidence is captured by the per-QUESTION required photos
  // inside the section, so a separate SECTION photo is redundant — and was
  // blocking submit on the "Vacant Units" section even when its questions had
  // photos. Exempt any vacant-unit section from the section-photo requirement.
  if (lower.includes('vacant')) return true;
  // 1099: the Whole House section does not require a section photo.
  if (templateType === 'leasing_agent_1099_property_inspection' && /whole\s*house/.test(lower)) return true;
  return false;
}

// A SectionInstance represents one renderable section in the form.
// Non-repeating sections produce exactly one instance.
// Repeating sections (bedroom/bathroom) produce N instances based on counts.
interface SectionInstance {
  // Unique key for this instance (used in state maps + DOM IDs)
  instanceKey: string;
  // The original section name from the data (e.g., "Bedroom")
  baseSectionName: string;
  // The display name shown to the user (e.g., "Bedroom 1")
  displayName: string;
  // Optional location label sent on the Answer record (e.g., "Bedroom 1")
  location?: string;
  // sectionOrder from the original questions (used for sorting + exemption)
  sectionOrder: number;
  // The questions to render in this instance (copies of the base section's questions)
  questions: Question[];
  // For repeating sections only -- the instance number (1, 2, 3...)
  instanceNumber?: number;
  // For repeating sections only -- 'bedroom' or 'bathroom'
  roomType?: string;
}

// Compose the per-question state key for an instance.
function answerKey(questionIdExternal: string, instanceKey: string): string {
  return `${questionIdExternal}::${instanceKey}`;
}

// Reconstruct the SAME deterministic natural key the autosave hook uses when
// saving an answer (lib/useAutosave.ts buildAnswerExternalId). Hydration matches
// saved answers back to form slots by this key — the reliable approach — instead
// of re-deriving a fragile match from section/location strings.
function buildAnswerExternalId(
  inspectionExternalId: string,
  questionIdExternal: string,
  instanceKey: string
): string {
  const safeQ = questionIdExternal.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeI = instanceKey.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${inspectionExternalId}_${safeQ}__${safeI}`;
}

// Slugify section/instance display name for use in DOM IDs.
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function QuestionForm({
  questions, templateType, templateLabel, inspectorName, propertyName, propertyRecordId,
  bedrooms, bathrooms, squareFootage, propertyStatus, moveInReadyDate, inspectionRegion, status, submittedAt, listingPrice, listingDate, listingStatus, communityName, onSubmit, onCancel,
  inspectionRecordId, inspectionExternalId, pdfUrl,
  existingAnswers, readOnly, onFirstEdit, onCancelInspection,
  propertyAirFiltersTotal, propertyAirFiltersType1, propertyAirFiltersType2, propertyAirFiltersType3,
  filterSizeOptions,
}: Props) {
  const dialog = useAppDialog();
  // These three Q&A templates get the Scope-Rate-Card-style treatment (logo
  // header, plain Action Required styling, single Take button, no default
  // answers, collapse/expand-all, no Cancel button). RRQC (also rendered by this
  // component) keeps its existing behavior, so everything is gated on this flag.
  const scopeStyle =
    templateType === 'leasing_agent_1099_property_inspection' ||
    templateType === 'pm_vacancy_occupancy_check' ||
    templateType === 'pm_community_inspection';
  const isCommunity = templateType === 'pm_community_inspection';
  // Community / Visit inspections drop the reused Scope widgets (HVAC & Air
  // Filters, Smart Home Tech, Utilities) entirely. Everything else scope-style
  // (1099, occupancy) keeps them.
  const fcEnabled = scopeStyle && !isCommunity;
  // Property values used to prefill the HVAC air-filter widget.
  const propertyValues = useMemo<Record<string, string>>(() => ({
    air_filters___total_quantity: propertyAirFiltersTotal != null ? String(propertyAirFiltersTotal) : '',
    air_filters___type__1: propertyAirFiltersType1 || '',
    air_filters___type__2: propertyAirFiltersType2 || '',
    air_filters___type__3: propertyAirFiltersType3 || '',
  }), [propertyAirFiltersTotal, propertyAirFiltersType1, propertyAirFiltersType2, propertyAirFiltersType3]);

  // ── Reused Scope FinalChecklist (HVAC & Air Filters + Smart Home Tech) ──────
  // The Q&A templates render the EXACT Scope widgets and persist them the same
  // way the rate card does: one JSON-blob Answer record (answer_id_external
  // FINALCHECKLIST-<id>). No line-item behavior here (no onAddLine).
  const FC_ONLY = useMemo(() => ['hvac_air_filters', 'smart_home_tech', 'utilities'], []);
  // Offline-queue sectionId tag for Final Checklist photos (HVAC label stickers,
  // etc.). The camKey (`qid:key`) rides in lineExternalId. The flush recognizes
  // this tag and swaps the synced URL back into fcAnswers — WITHOUT it, FC photos
  // upload but their draft blob: URL is revoked and never replaced, leaving the
  // broken "?" tile. (Mirrors RateCardForm's handling.)
  const FC_PHOTO_SECTION = '__final_checklist__';
  const [fcAnswers, setFcAnswers] = useState<FcAnswers>({});
  const fcRecordIdRef = useRef<string | null>(null);
  const fcHydratedRef = useRef(false);
  const fcSaveTimer = useRef<any>(null);

  // Hydrate the checklist blob from the saved answer on open.
  useEffect(() => {
    if (!fcEnabled || fcHydratedRef.current) return;
    fcHydratedRef.current = true;
    const blob = (existingAnswers || []).find(
      (a) => a.questionIdExternal === 'fc__all' || (a.answerIdExternal || '').startsWith('FINALCHECKLIST-')
    );
    if (blob) {
      fcRecordIdRef.current = blob.recordId || null;
      try { const parsed = JSON.parse(blob.note || '{}'); if (parsed && typeof parsed === 'object') setFcAnswers(parsed); } catch { /* ignore */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeStyle]);

  // Strip offline-draft (blob:) photo URLs before persisting.
  const fcStripBlobs = useCallback((a: FcAnswers): FcAnswers => {
    const out: FcAnswers = {};
    for (const [k, v] of Object.entries(a)) {
      const nv: FcAnswerState = { ...v };
      if (nv.photoUrls) nv.photoUrls = nv.photoUrls.filter((u) => !u.startsWith('blob:'));
      if (nv.stickerPhotos) {
        const sp: Record<string, string[]> = {};
        for (const [pk, arr] of Object.entries(nv.stickerPhotos)) sp[pk] = (arr || []).filter((u) => !u.startsWith('blob:'));
        nv.stickerPhotos = sp;
      }
      out[k] = nv;
    }
    return out;
  }, []);

  // Persist the checklist as a single JSON-blob answer (mirrors the rate card).
  const saveFc = useCallback(async (toSave: FcAnswers): Promise<void> => {
    if (readOnly) return;
    const body = {
      upserts: [{
        recordId: fcRecordIdRef.current || undefined,
        answerProps: buildQaAnswerProps({
          answerIdExternal: `FINALCHECKLIST-${inspectionRecordId}`,
          inspectionIdExternal: inspectionExternalId,
          questionIdExternal: 'fc__all',
          questionText: 'HVAC & Smart Home',
          section: 'HVAC & Smart Home',
          summaryInstanceLabel: '',
          answerValue: 'final_checklist',
          note: JSON.stringify(fcStripBlobs(toSave)),
        }, { isScope: false }),
        questionHubspotRecordId: null,
      }],
      archives: [] as string[],
    };
    try {
      const r = await fetch(`/api/inspections/${inspectionRecordId}/answers`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, bumpStatusToInProgress: true }),
      });
      if (r.ok) { const d = await r.json(); const rid = d.results?.[0]?.recordId; if (rid) fcRecordIdRef.current = rid; }
    } catch { /* offline — the next save / submit retries */ }
  }, [readOnly, inspectionRecordId, inspectionExternalId, fcStripBlobs]);

  const onFcPatch = useCallback((questionId: string, patch: Partial<FcAnswerState>) => {
    if (readOnly) return;
    setFcAnswers((prev) => {
      const next = { ...prev, [questionId]: { ...prev[questionId], ...patch } };
      if (fcSaveTimer.current) clearTimeout(fcSaveTimer.current);
      fcSaveTimer.current = setTimeout(() => { void saveFc(next); }, 900);
      return next;
    });
    onFirstEdit?.();
  }, [readOnly, saveFc, onFirstEdit]);

  // Validation context (HVAC + Smart Home only; no septic, no line rules).
  const fcCtx: FcCompletionCtx = {
    septicFee: null,
    airQtyPrefill: propertyAirFiltersTotal ?? null,
    filterOptionsAvailable: (filterSizeOptions?.length || 0) > 0,
    filterPrefills: [propertyAirFiltersType1 || null, propertyAirFiltersType2 || null, propertyAirFiltersType3 || null],
  };

  // Transform the raw questions:
  //   - 1099 drops the HAP section entirely
  //   - the HVAC and Smart Home sections (HubSpot-defined) are intercepted and
  //     replaced by the Scope-style widget questions (lib/scopeWidgetSections),
  //     preserving the original section name + order. The HubSpot question
  //     records are left untouched; we just render these instead.
  //   - the HVAC and Smart Home sections are STRIPPED here and replaced by the
  //     reused Scope FinalChecklist widgets (rendered after the questions), so
  //     they mirror the rate card exactly. The HubSpot question records are left
  //     untouched; we just don't render them.
  const formQuestions = useMemo(() => {
    let base = templateType === 'leasing_agent_1099_property_inspection'
      ? questions.filter((q) => !/\bhap\b/i.test(q.section))
      : questions;
    // Community / Visit: the Overview section (and its community-name prompt) is
    // dropped — the community name is pulled from the property and shown in the
    // header instead.
    if (isCommunity) base = base.filter((q) => !/overview/i.test(q.section));
    // Strip the HubSpot HVAC, Smart Home, and Safety/Electric sections — they're
    // replaced by the reused Scope widgets (HVAC & Air Filters, Smart Home, and
    // Utilities) rendered below.
    return scopeStyle
      ? base.filter((q) => !isHvacSection(q.section) && !isSmartHomeSection(q.section)
          && !/\b(safety|electric|utilit)/i.test(q.section))
      : base;
  }, [questions, templateType, scopeStyle]);
  // Build the list of section instances. Repeating sections expand into multiple.
  const sectionInstances: SectionInstance[] = useMemo(() => {
    // First group questions by base section
    const bySection = new Map<string, { sectionOrder: number; questions: Question[] }>();
    for (const q of formQuestions) {
      if (!bySection.has(q.section)) {
        bySection.set(q.section, { sectionOrder: q.sectionOrder, questions: [] });
      }
      bySection.get(q.section)!.questions.push(q);
    }

    const out: SectionInstance[] = [];

    for (const [sectionName, info] of bySection.entries()) {
      // Determine if this whole section repeats. We do this section-wide:
      // if ANY question in the section has repeats_per_room_type set, the whole section repeats.
      // (Per the data model, the section's questions are either all repeating or none are.)
      const repeatType = info.questions.find((q) => !!q.repeatsPerRoomType)?.repeatsPerRoomType || '';

      if (repeatType === 'bedroom' && bedrooms > 0) {
        for (let i = 1; i <= bedrooms; i++) {
          // Bedroom 1 is the master/main; show "(Main)" suffix only for display.
          // The `location` field (which gets stored on Answer records) stays unchanged
          // so historical inspections still match correctly.
          const displaySuffix = i === 1 ? ' (Main)' : '';
          out.push({
            instanceKey: `bedroom-${i}`,
            baseSectionName: sectionName,
            displayName: `Bedroom ${i}${displaySuffix}`,
            location: `Bedroom ${i}`,
            sectionOrder: info.sectionOrder,
            questions: info.questions,
            instanceNumber: i,
            roomType: 'bedroom',
          });
        }
      } else if (repeatType === 'bathroom' && bathrooms > 0) {
        // Bathrooms can be fractional (1.5, 2.5). We expand each whole/half into its own:
        // 2 BA -> Bathroom 1, Bathroom 2
        // 2.5 BA -> Bathroom 1, Bathroom 2, Half Bath
        const wholeBaths = Math.floor(bathrooms);
        const hasHalf = bathrooms - wholeBaths >= 0.5;
        for (let i = 1; i <= wholeBaths; i++) {
          const displaySuffix = i === 1 ? ' (Main)' : '';
          out.push({
            instanceKey: `bathroom-${i}`,
            baseSectionName: sectionName,
            displayName: `Bathroom ${i}${displaySuffix}`,
            location: `Bathroom ${i}`,
            sectionOrder: info.sectionOrder,
            questions: info.questions,
            instanceNumber: i,
            roomType: 'bathroom',
          });
        }
        if (hasHalf) {
          out.push({
            instanceKey: 'bathroom-half',
            baseSectionName: sectionName,
            displayName: 'Half Bath',
            location: 'Half Bath',
            sectionOrder: info.sectionOrder,
            questions: info.questions,
            roomType: 'bathroom',
          });
        }
      } else if (repeatType) {
        // Some other repeat type, or count is 0. Render once, no location.
        out.push({
          instanceKey: slugify(sectionName),
          baseSectionName: sectionName,
          displayName: sectionName,
          sectionOrder: info.sectionOrder,
          questions: info.questions,
        });
      } else {
        out.push({
          instanceKey: slugify(sectionName),
          baseSectionName: sectionName,
          displayName: sectionName,
          sectionOrder: info.sectionOrder,
          questions: info.questions,
        });
      }
    }

    out.sort((a, b) => {
      // Primary sort: sectionOrder
      if (a.sectionOrder !== b.sectionOrder) return a.sectionOrder - b.sectionOrder;
      // Secondary: instance number (so Bedroom 1, 2, 3 stay in order)
      return (a.instanceNumber ?? 0) - (b.instanceNumber ?? 0);
    });

    return out;
  }, [formQuestions, bedrooms, bathrooms]);

  // Helper: derive instanceKey from a saved answer's `location` field.
  // Inverse of how the form builds location during submit.
  // "Bedroom 1" -> "bedroom-1", "Bathroom 2" -> "bathroom-2", "Half Bath" -> "bathroom-half",
  // "" -> slugified base section name (for non-repeating sections).
  function locationToInstanceKey(location: string, baseSection: string): string {
    if (!location) {
      return slugify(baseSection);
    }
    const lower = location.toLowerCase().trim();
    if (lower === 'half bath') return 'bathroom-half';
    const m = lower.match(/^(bedroom|bathroom)\s+(\d+)$/);
    if (m) return `${m[1]}-${m[2]}`;
    return slugify(location);
  }

  // Initialize answer state. Keyed by `${questionIdExternal}::${instanceKey}` so each
  // repeating instance has independent state. If existingAnswers are provided, hydrate
  // from them.
  const [answers, setAnswers] = useState<Record<string, AnswerInput>>(() => {
    const init: Record<string, AnswerInput> = {};
    // Step 1: blank defaults for every section instance question
    for (const inst of sectionInstances) {
      for (const q of inst.questions) {
        const key = answerKey(q.questionIdExternal, inst.instanceKey);
        init[key] = {
          questionIdExternal: q.questionIdExternal,
          questionHubspotRecordId: q.hubspotRecordId,
          questionText: q.questionText,
          section: q.section,
          location: inst.location,
          // scopeStyle templates start with NO pre-filled answer — the inspector
          // must make every selection explicitly (no silent defaults).
          answerValue: scopeStyle ? '' : (q.defaultValue || ''),
          note: '',
          quantity: null,
          // recommendedAmount left undefined (untouched) so it's only written for
          // answers that actually use the dependent input (the 1099 listing price).
          photoUrls: [],
          // Notes/photos panel starts CLOSED. It opens automatically once an
          // answer is selected when that answer requires a note/photo (handled by
          // QuestionItem's forcedOpen), and the inspector can open it any time.
          optionalPanelOpen: false,
        };
      }
    }
    // Step 2: overlay any existing saved Q&A answers from HubSpot.
    //
    // PRIMARY match: the deterministic natural key (answer_id_external) that the
    // answer was SAVED under. This is reliable because save and hydrate now use
    // the exact same key derivation. This fixes answers silently failing to
    // re-display (and being miscounted as unanswered) when the location/section
    // heuristic didn't line up on reopen.
    //
    // FALLBACK match: the older location/section heuristic, for any legacy
    // records saved before answer_id_external matching existed.
    if (existingAnswers && existingAnswers.length > 0) {
      // Build externalId -> { key, questionIdExternal } across every form slot.
      const externalIdToKey = new Map<string, string>();
      for (const inst of sectionInstances) {
        for (const q of inst.questions) {
          const eid = buildAnswerExternalId(inspectionExternalId, q.questionIdExternal, inst.instanceKey);
          externalIdToKey.set(eid, answerKey(q.questionIdExternal, inst.instanceKey));
        }
      }

      for (const sa of existingAnswers) {
        if (sa.answerType !== 'qa') continue;

        // Try the reliable natural-key match first.
        let key: string | undefined =
          sa.answerIdExternal ? externalIdToKey.get(sa.answerIdExternal) : undefined;

        // Fallback: legacy location/section heuristic.
        if (!key) {
          const matchingInst = sectionInstances.find(
            (inst) =>
              inst.questions.some((q) => q.questionIdExternal === sa.questionIdExternal) &&
              ((sa.location && inst.location === sa.location) ||
               (!sa.location && !inst.location))
          );
          if (matchingInst) key = answerKey(sa.questionIdExternal, matchingInst.instanceKey);
        }

        if (!key) continue;
        const existing = init[key];
        if (!existing) continue;
        init[key] = {
          ...existing,
          answerValue: sa.answerValue || existing.answerValue,
          note: sa.note || '',
          quantity: sa.quantity,
          recommendedAmount: sa.recommendedAmount != null ? sa.recommendedAmount : undefined,
          assignedTo: sa.assignedTo || undefined,
          photoUrls: sa.photoUrls || [],
          optionalPanelOpen: !!(sa.note || sa.quantity != null || (sa.photoUrls && sa.photoUrls.length > 0)),
        };
      }
    }
    return init;
  });

  // Map of answer key -> HubSpot Answer recordId (populated as autosave succeeds
  // OR pre-populated from existingAnswers on load).
  const answerRecordIdsRef = useRef<Map<string, string>>(new Map());

  // Section photos keyed by instanceKey (so Bedroom 1 and Bedroom 2 have separate photos)
  const [sectionPhotos, setSectionPhotos] = useState<Record<string, string[]>>(() => {
    const out: Record<string, string[]> = {};
    if (existingAnswers) {
      for (const sa of existingAnswers) {
        if (sa.answerType !== 'section_photo') continue;
        // Use location to map to the correct instance
        const matchingInst = sectionInstances.find((inst) => {
          if (sa.location && inst.location === sa.location) return true;
          if (!sa.location && (inst.baseSectionName === sa.section || slugify(inst.baseSectionName) === slugify(sa.section))) return true;
          return false;
        });
        const key = matchingInst?.instanceKey ?? locationToInstanceKey(sa.location, sa.section);
        if (sa.photoUrls && sa.photoUrls.length > 0) {
          if (!out[key]) out[key] = [];
          out[key].push(...sa.photoUrls);
        }
      }
    }
    return out;
  });

  // Which section instance has the in-app camera open right now (null = closed).
  // Only one camera can be open at a time; this also tells us where to append
  // captured photos when the user taps Done.
  const [sectionCameraInstance, setSectionCameraInstance] = useState<string | null>(null);
  // While ANY camera overlay is open, stop rendering section photo thumbnails so
  // they don't sit decoded in memory under the camera (the iOS WebKit crash).
  const cameraOpenAnywhere = useAnyCameraOpen();

  // 1099 / vacancy "raise a maintenance ticket on a failed review" widget state.
  // Shown in the Review & Sign-Off section only when its verdict is Fail.
  const [maintTicketWanted, setMaintTicketWanted] = useState<'' | 'Yes' | 'No'>('');
  const [maintTicketDescription, setMaintTicketDescription] = useState('');

  // Map of instanceKey -> HubSpot Answer recordId for section_photo records
  const sectionPhotoRecordIdsRef = useRef<Map<string, string>>(new Map());
  // Populate from existing answers
  useEffect(() => {
    if (!existingAnswers) return;
    const m = new Map<string, string>();
    const aMap = new Map<string, string>();
    // Reliable externalId -> form key lookup for qa answers (same as hydration).
    const externalIdToKey = new Map<string, string>();
    for (const inst of sectionInstances) {
      for (const q of inst.questions) {
        const eid = buildAnswerExternalId(inspectionExternalId, q.questionIdExternal, inst.instanceKey);
        externalIdToKey.set(eid, answerKey(q.questionIdExternal, inst.instanceKey));
      }
    }
    for (const sa of existingAnswers) {
      if (sa.answerType === 'section_photo') {
        // best-effort instanceKey
        const matchingInst = sectionInstances.find((inst) => {
          if (sa.location && inst.location === sa.location) return true;
          if (!sa.location && (inst.baseSectionName === sa.section || slugify(inst.baseSectionName) === slugify(sa.section))) return true;
          return false;
        });
        const key = matchingInst?.instanceKey ?? locationToInstanceKey(sa.location, sa.section);
        m.set(key, sa.recordId);
      } else if (sa.answerType === 'qa') {
        // Reliable natural-key match first; fall back to location heuristic.
        let key: string | undefined =
          sa.answerIdExternal ? externalIdToKey.get(sa.answerIdExternal) : undefined;
        if (!key) {
          const matchingInst = sectionInstances.find(
            (inst) =>
              inst.questions.some((q) => q.questionIdExternal === sa.questionIdExternal) &&
              ((sa.location && inst.location === sa.location) ||
               (!sa.location && !inst.location))
          );
          if (matchingInst) key = answerKey(sa.questionIdExternal, matchingInst.instanceKey);
        }
        if (key) aMap.set(key, sa.recordId);
      }
    }
    sectionPhotoRecordIdsRef.current = m;
    answerRecordIdsRef.current = aMap;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Initialize autosave
  const autosave = useAutosave({
    inspectionRecordId,
    inspectionExternalId,
    disabled: !!readOnly,
    onFirstSave: onFirstEdit,
    // QuestionForm only ever renders Q&A templates (1099, Community, Vacancy,
    // RRQC). Scope uses RateCardForm, never this component — so quantity /
    // assigned_to must never be written to HubSpot from here.
    isScope: false,
  });

  // After mount, hydrate the autosave hook with existing data so it knows
  // each answer's recordId (for PATCH updates instead of duplicate creates).
  useEffect(() => {
    if (!existingAnswers || existingAnswers.length === 0) return;
    const initial: Array<{ key: string; answer: AnswerInput; recordId: string; questionHubspotRecordId: string; instanceKey: string }> = [];
    for (const [key, recordId] of answerRecordIdsRef.current.entries()) {
      const a = answers[key];
      if (!a) continue;
      // Find the question to get the HubSpot record ID
      const q = formQuestions.find((x) => x.questionIdExternal === a.questionIdExternal);
      if (!q) continue;
      const [, instanceKey] = key.split('::');
      initial.push({
        key,
        answer: a,
        recordId,
        questionHubspotRecordId: q.hubspotRecordId,
        instanceKey,
      });
    }
    autosave.hydrate(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Collapsed state.
  // Scope: every section EXCEPT the first instance starts collapsed (Hayden's request for Scope).
  // Non-Scope: keep prior behavior -- everything open except repeating bedroom/bathroom instances 2..N + Half Bath.
  // Per-section collapse of the photo strip.
  const [photosCollapsed, setPhotosCollapsed] = useState<Record<string, boolean>>({});

  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    const c = new Set<string>();
    // Q&A templates: everything open except repeating bedroom/bathroom
    // instances 2..N and the Half Bath.
    for (const inst of sectionInstances) {
      if ((inst.roomType === 'bedroom' && (inst.instanceNumber ?? 0) > 1)
         || (inst.roomType === 'bathroom' && (inst.instanceNumber ?? 0) > 1)
         || inst.instanceKey === 'bathroom-half') {
        c.add(inst.instanceKey);
      }
    }
    return c;
  });

  function toggleCollapsed(instanceKey: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(instanceKey)) next.delete(instanceKey);
      else next.add(instanceKey);
      return next;
    });
  }

  function expandSection(instanceKey: string) {
    setCollapsed((prev) => {
      if (!prev.has(instanceKey)) return prev;
      const next = new Set(prev);
      next.delete(instanceKey);
      return next;
    });
  }

  // Collapse / expand ALL sections at once (mirrors the Scope Rate Card control).
  const anySectionOpen = sectionInstances.some((inst) => !collapsed.has(inst.instanceKey));
  // Token bumped on every collapse/expand-all so the reused Scope bubbles (which
  // own their own collapse state) follow the global toggle too.
  const [fcOpenToken, setFcOpenToken] = useState({ open: true, token: 0 });
  function setAllCollapsed(openAll: boolean) {
    setCollapsed(openAll ? new Set() : new Set(sectionInstances.map((inst) => inst.instanceKey)));
    setFcOpenToken((t) => ({ open: openAll, token: t.token + 1 }));
  }

  function updateAnswer(key: string, patch: Partial<AnswerInput>) {
    if (readOnly) return; // No edits in read-only mode

    // Skip noop-only updates (like toggling optionalPanelOpen) -- they shouldn't trigger autosave
    const onlyPanelToggle = Object.keys(patch).length === 1 && 'optionalPanelOpen' in patch;

    // Compute the merged value from the CURRENT answers (not via a side-effect
    // inside the setter, which is unreliable under React 18 strict mode and can
    // cause the autosave noteEdit to be skipped — the bug where the "Saving…"
    // indicator never appeared on the question form).
    const merged: AnswerInput = { ...answers[key], ...patch };
    setAnswers((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));

    if (!onlyPanelToggle) {
      const [, instanceKey] = key.split('::');
      // Persist only real URLs — offline draft (blob:) photos sync + swap later
      // (they stay in component state above for immediate display).
      const persistMerged: AnswerInput = { ...merged, photoUrls: (merged.photoUrls || []).filter((u) => !u.startsWith('blob:')) };
      autosave.noteEdit(key, persistMerged, persistMerged.questionHubspotRecordId, instanceKey);
    }
  }

  // uploadPhoto comes from @/lib/photoUpload (shared with RateCardForm).
  // The shared version has retry-with-backoff for flaky cell network uploads.

  // Upload progress: tracks which section is currently uploading and the count
  const [uploadingSection, setUploadingSection] = useState<{
    instanceKey: string;
    current: number;
    total: number;
  } | null>(null);

  async function handleSectionPhotoChange(instanceKey: string, files: FileList | null) {
    if (!files || files.length === 0) return;
    const fileArr = Array.from(files);
    setUploadingSection({ instanceKey, current: 0, total: fileArr.length });
    try {
      const { failed, errors } = await uploadFilesBatch(
        fileArr,
        (url) => {
          // Append the URL to section state as soon as that one upload finishes.
          // Inspector sees thumbnails appearing one by one.
          setSectionPhotos((prev) => ({
            ...prev,
            [instanceKey]: [...(prev[instanceKey] || []), url],
          }));
        },
        (current) => setUploadingSection((prev) => prev ? { ...prev, current } : prev),
        // Offline-aware: caches to IndexedDB on weak signal (draft), syncs later.
        (file) => uploadPhotoOrQueue(file, inspectionRecordId, instanceKey),
      );
      if (failed > 0) {
        // Show the first error reason so the inspector knows WHY it failed
        // (network drop, file too big, server reject) instead of a bare count.
        const reason = errors[0] ? `\n\nReason: ${errors[0]}` : '';
        void dialog.alert(
          `${failed} of ${fileArr.length} photo${fileArr.length === 1 ? '' : 's'} failed to upload. ` +
          `Photos that succeeded have been saved.${reason}`
        );
      }
    } catch (e: any) {
      void dialog.alert(`Photo upload failed: ${e.message || e}`);
    } finally {
      setUploadingSection(null);
    }
  }

  // Section-photo lightbox (swipe / markup / delete / video).
  const [photoLightbox, setPhotoLightbox] = useState<{ instanceKey: string; index: number } | null>(null);

  function removeSectionPhoto(instanceKey: string, idx: number) {
    if (readOnly) return;
    setSectionPhotos((prev) => ({
      ...prev,
      [instanceKey]: (prev[instanceKey] || []).filter((_, i) => i !== idx),
    }));
  }

  // Swap a section photo for its marked-up version (re-upload + replace in
  // place; the dirty-tracking effect persists it).
  async function replaceSectionPhoto(instanceKey: string, idx: number, file: File) {
    if (readOnly) return;
    try {
      const oldForReplace = (sectionPhotos[instanceKey] || [])[idx];
      const url = await uploadPhotoOrQueue(file, inspectionRecordId, instanceKey, { replacesUrl: oldForReplace });
      setSectionPhotos((prev) => {
        const arr = [...(prev[instanceKey] || [])];
        if (idx < 0 || idx >= arr.length) return prev;
        arr[idx] = url;
        return { ...prev, [instanceKey]: arr };
      });
    } catch (e) {
      console.error('[QuestionForm] section photo replace failed:', e);
    }
  }

  // Sync section photos to HubSpot whenever they change (debounced).
  // Each instance has a single section_photo Answer record; we upsert it when photos change.
  const sectionPhotoDirtyRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (readOnly) return;
    // Diff against the last-saved state by tracking which instances changed.
    // Simple approach: when sectionPhotos changes, mark all instances as potentially dirty.
    // Real diff happens at flush time.
    for (const instanceKey of Object.keys(sectionPhotos)) {
      sectionPhotoDirtyRef.current.add(instanceKey);
    }
  }, [sectionPhotos, readOnly]);

  useEffect(() => {
    if (readOnly) return;
    const id = setInterval(async () => {
      if (sectionPhotoDirtyRef.current.size === 0) return;
      const dirtyKeys = Array.from(sectionPhotoDirtyRef.current);
      sectionPhotoDirtyRef.current.clear();

      // Build a deterministic mapping from external ID -> instanceKey so we can
      // map responses back without fragile parsing.
      const externalIdToInstance = new Map<string, string>();
      const upserts: any[] = [];
      const archives: string[] = [];

      for (const instanceKey of dirtyKeys) {
        const urls = sectionPhotos[instanceKey] || [];
        // Never persist offline draft (blob:) URLs — they sync + swap later.
        const realUrls = urls.filter((u) => !u.startsWith('blob:'));
        const inst = sectionInstances.find((x) => x.instanceKey === instanceKey);
        if (!inst) continue;
        const existingRecordId = sectionPhotoRecordIdsRef.current.get(instanceKey);

        if (urls.length === 0) {
          // No photos -- archive the section_photo record if it exists
          if (existingRecordId) {
            archives.push(existingRecordId);
            sectionPhotoRecordIdsRef.current.delete(instanceKey);
          }
          continue;
        }
        // Only offline drafts so far — don't archive or upsert; the queue flush
        // will swap in real URLs and re-mark this dirty once they sync.
        if (realUrls.length === 0) continue;

        const externalId = `${inspectionExternalId}_sp_${instanceKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        externalIdToInstance.set(externalId, instanceKey);

        const baseSection = inst.baseSectionName;
        const props = buildSectionPhotoAnswerProps({
          answerIdExternal: externalId,
          inspectionIdExternal: inspectionExternalId,
          section: baseSection,
          summaryLabel: inst.displayName,
          photoUrls: realUrls,
          location: inst.location,
        });

        upserts.push({
          recordId: existingRecordId,
          answerProps: props,
          questionHubspotRecordId: null,
        });
      }

      if (upserts.length === 0 && archives.length === 0) return;

      try {
        const r = await fetch(`/api/inspections/${inspectionRecordId}/answers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ upserts, archives, bumpStatusToInProgress: true }),
        });
        if (!r.ok) {
          console.error('Section photo save failed', await r.text());
          // re-mark dirty so we retry next tick
          for (const k of dirtyKeys) sectionPhotoDirtyRef.current.add(k);
          return;
        }
        const data = await r.json();
        // Map each response back to its instanceKey using the deterministic table
        for (const result of (data.results || [])) {
          const eid = result.answerIdExternal;
          const ikey = externalIdToInstance.get(eid);
          if (ikey) {
            sectionPhotoRecordIdsRef.current.set(ikey, result.recordId);
          }
        }
        if (!hasEverHadSectionSave.current) {
          hasEverHadSectionSave.current = true;
          onFirstEdit?.();
        }
      } catch (e) {
        console.error('Section photo save error:', e);
        for (const k of dirtyKeys) sectionPhotoDirtyRef.current.add(k);
      }
    }, 2500);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, inspectionRecordId, inspectionExternalId, sectionPhotos, sectionInstances]);

  const hasEverHadSectionSave = useRef(false);

  // ---- Offline photo cache + auto-sync -----------------------------------
  // Captures on a weak signal cache to IndexedDB (draft blob: URLs) and
  // re-attach + persist when connectivity returns. Section photos queue under
  // their instanceKey; inline question photos queue under the answer key
  // (`${questionIdExternal}::${instanceKey}`, which contains '::').
  const photoRehydratedRef = useRef(false);
  const answersRef = useRef(answers); answersRef.current = answers;
  const autosaveRef = useRef(autosave); autosaveRef.current = autosave;
  const runPhotoFlush = useCallback(async () => {
    if (readOnly || !photoRehydratedRef.current) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    await flushQueuedPhotos(inspectionRecordId, ({ sectionId, oldUrl, newUrl, replacesUrl, lineExternalId }) => {
      // Final Checklist photo (HVAC label stickers, etc.): swap the draft/original
      // URL for the real one inside fcAnswers (photoUrls + per-slot stickerPhotos),
      // then persist. MUST run before the lineExternalId guard — FC photos carry
      // their camKey in lineExternalId. Without this the synced photo's draft URL
      // is revoked and never replaced (the broken "?" tile + "photo disappeared").
      if (sectionId === FC_PHOTO_SECTION) {
        const matchesFc = (u: string) => u === oldUrl || (!!replacesUrl && u === replacesUrl);
        setFcAnswers((cur) => {
          let changed = false;
          const swap = (arr?: string[]) => (arr || []).map((u) => (matchesFc(u) ? ((changed = true), newUrl) : u));
          const next: FcAnswers = {};
          for (const [qid, a] of Object.entries(cur)) {
            const n: FcAnswerState = { ...a };
            if (a.photoUrls) n.photoUrls = swap(a.photoUrls);
            if (a.stickerPhotos) n.stickerPhotos = Object.fromEntries(Object.entries(a.stickerPhotos).map(([k, v]) => [k, swap(v)]));
            next[qid] = n;
          }
          if (changed) void saveFc(next);
          return changed ? next : cur;
        });
        return;
      }
      if (lineExternalId) return;
      const matches = (u: string) => u === oldUrl || (!!replacesUrl && u === replacesUrl);
      if (sectionId.includes('::')) {
        // Inline question photo → swap in that answer + persist real URLs.
        const key = sectionId;
        const a = answersRef.current[key];
        if (!a || !(a.photoUrls || []).some(matches)) return;
        const sw = (a.photoUrls || []).map((u) => (matches(u) ? newUrl : u));
        setAnswers((cur) => (cur[key] ? { ...cur, [key]: { ...cur[key], photoUrls: (cur[key].photoUrls || []).map((u) => (matches(u) ? newUrl : u)) } } : cur));
        const [, instanceKey] = key.split('::');
        const persist = { ...a, photoUrls: sw.filter((u) => !u.startsWith('blob:')) };
        autosaveRef.current.noteEdit(key, persist, persist.questionHubspotRecordId, instanceKey);
        return;
      }
      // Section photo → swap + mark dirty so the debounced save persists it.
      setSectionPhotos((cur) => {
        const arr = cur[sectionId];
        if (!arr || !arr.some(matches)) return cur;
        sectionPhotoDirtyRef.current.add(sectionId);
        return { ...cur, [sectionId]: arr.map((u) => (matches(u) ? newUrl : u)) };
      });
    }).catch(() => {});
  }, [readOnly, inspectionRecordId, saveFc]);
  const runPhotoFlushRef = useRef(runPhotoFlush);
  runPhotoFlushRef.current = runPhotoFlush;

  // Rehydrate queued drafts on mount, then drain.
  useEffect(() => {
    if (readOnly || photoRehydratedRef.current) return;
    photoRehydratedRef.current = true;
    void rehydrateQueuedPhotos(inspectionRecordId).then((drafts) => {
      const bySection: Record<string, string[]> = {};
      const byQuestion: Record<string, string[]> = {};
      // Final Checklist drafts (HVAC label stickers, etc.) carry their camKey
      // (`qid:key`) in lineExternalId — restore them into fcAnswers so a draft
      // taken offline re-shows in its slot after a reopen.
      const fcDrafts = drafts.filter((d) => d.sectionId === FC_PHOTO_SECTION && !!d.lineExternalId);
      for (const d of drafts) {
        if (d.lineExternalId) continue;
        if (d.sectionId.includes('::')) (byQuestion[d.sectionId] = byQuestion[d.sectionId] || []).push(d.url);
        else (bySection[d.sectionId] = bySection[d.sectionId] || []).push(d.url);
      }
      if (fcDrafts.length) {
        setFcAnswers((cur) => {
          const next: FcAnswers = { ...cur };
          for (const d of fcDrafts) {
            const [qid, key] = (d.lineExternalId || '').split(':');
            if (!qid || !key) continue;
            const a: FcAnswerState = { ...(next[qid] || {}) };
            if (key === 'photo') {
              a.photoUrls = Array.from(new Set([...(a.photoUrls || []), d.url]));
            } else {
              const sp = { ...(a.stickerPhotos || {}) };
              sp[key] = Array.from(new Set([...(sp[key] || []), d.url]));
              a.stickerPhotos = sp;
            }
            next[qid] = a;
          }
          return next;
        });
      }
      if (Object.keys(bySection).length) {
        setSectionPhotos((cur) => {
          const n = { ...cur };
          for (const [k, urls] of Object.entries(bySection)) n[k] = Array.from(new Set([...(n[k] || []), ...urls]));
          return n;
        });
      }
      if (Object.keys(byQuestion).length) {
        setAnswers((cur) => {
          const n = { ...cur };
          for (const [k, urls] of Object.entries(byQuestion)) {
            if (n[k]) n[k] = { ...n[k], photoUrls: Array.from(new Set([...(n[k].photoUrls || []), ...urls])) };
          }
          return n;
        });
      }
    }).catch(() => {}).finally(() => { void runPhotoFlushRef.current(); });
  }, [readOnly, inspectionRecordId]);

  // Offline answer drafts (VISIBILITY) ------------------------------------------
  // The outbox guarantees offline answers SYNC; this mirror restores what the
  // inspector typed if they close + reopen the inspection still in a dead zone.
  // On first mount, overlay any stashed draft onto the known answer slots.
  const answerDraftMergedRef = useRef(false);
  useEffect(() => {
    if (readOnly || answerDraftMergedRef.current) return;
    answerDraftMergedRef.current = true;
    const draft = loadCachedAnswers<Record<string, AnswerInput>>(inspectionRecordId);
    if (draft && typeof draft === 'object') {
      setAnswers((prev) => {
        const next = { ...prev };
        for (const [k, v] of Object.entries(draft)) {
          if (next[k] && v && typeof v === 'object') next[k] = { ...next[k], ...v };
        }
        return next;
      });
    }
  }, [readOnly, inspectionRecordId]);

  // Persist the draft while there are UNSYNCED edits; clear it once everything
  // has saved (so a stale draft can never overlay newer server data).
  useEffect(() => {
    if (readOnly) return;
    const id = inspectionRecordId;
    const synced = autosave.saveState.kind === 'saved' || autosave.saveState.kind === 'idle';
    const t = setTimeout(() => {
      if (synced) clearCachedAnswers(id);
      else saveCachedAnswers(id, answers);
    }, 500);
    return () => clearTimeout(t);
  }, [answers, autosave.saveState, readOnly, inspectionRecordId]);

  // Auto-retry: flush on reconnect + periodic reconcile + when a camera session
  // closes (the flush is suspended while a camera is open, so resuming kicks this
  // to drain the just-captured photos right away).
  useEffect(() => {
    if (readOnly) return;
    // Drain BOTH queues: photos (IndexedDB) and the durable outbox (answers
    // entered offline that were stashed so they survive closing the app).
    const kick = () => { void runPhotoFlushRef.current(); void flushOutbox(); };
    window.addEventListener('online', kick);
    // Batch every 10s in the background (photo uploads are suspended while a
    // camera overlay is open — see flushQueuedPhotos — so this tick only does
    // work once the camera is closed).
    const iv = setInterval(kick, 10000);
    const unsub = onPhotoFlushResume(() => { void runPhotoFlushRef.current(); });
    // iOS suspends JS timers when the PWA is backgrounded / the screen locks, and
    // it has NO Background Sync — so a foregrounded app is the only window in
    // which queued photos can upload. Kick the instant the app becomes visible
    // again (and on bfcache restore) so sync resumes immediately instead of
    // waiting up to 15s — the main reason photos sat on "Saved Offline" on iPhone.
    const onVisible = () => { if (typeof document === 'undefined' || document.visibilityState === 'visible') kick(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onVisible);
    void flushOutbox(); // sync anything queued from a prior offline session on mount
    return () => {
      window.removeEventListener('online', kick); clearInterval(iv); unsub();
      document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('pageshow', onVisible);
    };
  }, [readOnly]);

  // When the in-app camera CLOSES, drain the photos captured during that session
  // right away. Photo uploads are suspended while a camera is open (to keep iOS
  // from OOM-crashing when an upload overlaps the next capture), so closing the
  // camera is exactly when the queued batch should sync.
  const prevCameraOpenRef = useRef(cameraOpenAnywhere);
  useEffect(() => {
    if (prevCameraOpenRef.current && !cameraOpenAnywhere) {
      void runPhotoFlushRef.current();
    }
    prevCameraOpenRef.current = cameraOpenAnywhere;
  }, [cameraOpenAnywhere]);

  // (Legacy widget visibility — the synthetic HVAC/Smart widgets were replaced
  // by the reused FinalChecklist, so every remaining question is always shown.)
  function isWidgetVisible(_qid: string, _instanceKey: string): boolean { return true; }

  // Vacancy / Occupancy: when the home is OCCUPIED, the interior-only items that
  // can't be assessed are hidden — HVAC & Air Filters, Utilities, and the Whole
  // House "General Condition (Interior)" question. Reactive to the occupancy answer.
  const isVacancy = templateType === 'pm_vacancy_occupancy_check';
  const occupied = isVacancy && Object.values(answers).some((a) => /\boccupied\b/i.test(a.answerValue || ''));
  const isHiddenWhenOccupied = (q: Question) => occupied && /general\s*condition.*interior/i.test(q.questionText || '');
  // FC sections still counted/required for submit (drop HVAC + Utilities when occupied).
  const fcGateIds = occupied ? FC_ONLY.filter((id) => id !== 'hvac_air_filters' && id !== 'utilities') : FC_ONLY;

  // Air-filter writeback: when the inspector changes the HVAC widget's filter
  // quantity / sizes, sync them onto the Property object (debounced). fcAnswers
  // starts empty (the widget prefills from the property), so a plain load never
  // writes — only real edits do. Sizes beyond the quantity are cleared.
  useEffect(() => {
    if (!fcEnabled || readOnly || !propertyRecordId) return;
    const qn = fcAnswers['fc_air_filters_qty']?.quantity ?? null;
    const sizes = fcAnswers['fc_filter_sizes']?.filterSizes || [];
    if (qn == null && !sizes.some(Boolean)) return;
    const n = qn != null ? Math.max(0, Math.min(3, qn)) : 3;
    const types = [0, 1, 2].map((i) => (i < n ? (sizes[i] || '') : ''));
    const t = setTimeout(() => {
      fetch(`/api/properties/${propertyRecordId}/air-filters`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ totalQuantity: qn ?? undefined, types }),
      }).catch(() => { /* best-effort */ });
    }, 1200);
    return () => clearTimeout(t);
  }, [fcAnswers, scopeStyle, readOnly, propertyRecordId]);

  function scrollToAndFlash(domId: string, instanceKey?: string) {
    if (typeof document === 'undefined') return;
    if (instanceKey) expandSection(instanceKey);
    // Allow expansion to render before scrolling
    setTimeout(() => {
      const el = document.getElementById(domId);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('flash-highlight');
      setTimeout(() => el.classList.remove('flash-highlight'), 1800);
    }, 60);
  }

  // Per-instance validation. Iterates instances in order so errors surface from top.
  function validate(): { message: string; scrollToDomId: string; instanceKey: string } | null {
    for (const inst of sectionInstances) {
      // Per-question validations
      for (const q of inst.questions) {
        // Hidden conditional widget fields / occupied-hidden questions aren't required.
        if (!isWidgetVisible(q.questionIdExternal, inst.instanceKey)) continue;
        if (isHiddenWhenOccupied(q)) continue;
        // When a maintenance ticket is being raised (Yes + the required ticket
        // description captures the detail), the free-text "Additional Comments"
        // question becomes optional — its content is redundant with the ticket.
        if (maintTicketEligible && maintTicketWanted === 'Yes'
            && /additional\s*comment/i.test(q.questionText || '')) continue;
        const key = answerKey(q.questionIdExternal, inst.instanceKey);
        const a = answers[key];
        const locTag = inst.location ? `${inst.location} -> ` : `${inst.displayName} -> `;
        if (q.isRequired && q.responseType === 'photo_only') {
          if (!a || (a.photoUrls?.length || 0) === 0) {
            return {
              message: `Photo required: ${locTag}${q.questionText}`,
              scrollToDomId: `q-${inst.instanceKey}-${q.questionIdExternal}`,
              instanceKey: inst.instanceKey,
            };
          }
        } else if (q.isRequired && (!a || !a.answerValue)) {
          return {
            message: `Required: ${locTag}${q.questionText}`,
            scrollToDomId: `q-${inst.instanceKey}-${q.questionIdExternal}`,
            instanceKey: inst.instanceKey,
          };
        }
        // Listing-price: an Increase/Reduce answer requires the recommended new
        // monthly rent (the dependent currency input).
        if (isListingPriceQuestion(q) && wantsRecommendedPrice(a?.answerValue || '') && (a?.recommendedAmount == null)) {
          return {
            message: `Recommended new rent required: ${locTag}${q.questionText}`,
            scrollToDomId: `q-${inst.instanceKey}-${q.questionIdExternal}`,
            instanceKey: inst.instanceKey,
          };
        }
        // Require a photo on this question when flagged — but N/A answers are
        // exempt (a not-applicable item needs no evidence).
        if (q.requiresPhoto && !isNA(a?.answerValue || '') && (!a || (a.photoUrls?.length || 0) === 0)) {
          return {
            message: `Photo required: ${locTag}${q.questionText}`,
            scrollToDomId: `q-${inst.instanceKey}-${q.questionIdExternal}`,
            instanceKey: inst.instanceKey,
          };
        }
        // Require a note when this value is configured (robust to the Good/Fail
        // relabel — a "Fail …" answer still triggers a value whose tone is fail)
        // OR when the question is flagged "Require note". N/A is exempt.
        if (a && a.answerValue && !isNA(a.answerValue)) {
          const failSel = answerTone(a.answerValue) === 'fail';
          const triggeredNote = q.noteRequiredOnValues.length > 0 && (
            q.noteRequiredOnValues.includes(a.answerValue)
            || (failSel && q.noteRequiredOnValues.some((v) => answerTone(v) === 'fail'))
          );
          if ((triggeredNote || q.requiresNote) && !a.note?.trim()) {
            return {
              message: `Note required: ${locTag}${q.questionText}`,
              scrollToDomId: `q-${inst.instanceKey}-${q.questionIdExternal}`,
              instanceKey: inst.instanceKey,
            };
          }
          // Assigned To validation: only if the question supports it AND this
          // isn't a plainStyle template (vendor assignment is Scope-only there).
          // useEffect in QuestionItem auto-defaults to "Vendor 1", so this is a backstop.
          if (triggeredNote && !scopeStyle && q.hasAssignedTo && !a.assignedTo?.trim()) {
            return {
              message: `Assigned To required: ${locTag}${q.questionText}`,
              scrollToDomId: `q-${inst.instanceKey}-${q.questionIdExternal}`,
              instanceKey: inst.instanceKey,
            };
          }
        }
      }
      // Section photo validation (per-instance)
      if (!sectionPhotosExempt(inst.baseSectionName, inst.sectionOrder, templateType)) {
        const photos = sectionPhotos[inst.instanceKey] || [];
        if (photos.length === 0) {
          return {
            message: `Section photo required: ${inst.displayName}`,
            scrollToDomId: `section-${inst.instanceKey}`,
            instanceKey: inst.instanceKey,
          };
        }
      }
    }
    // Maintenance-ticket widget: a description is required once "Yes" is chosen.
    if (maintTicketEligible && maintTicketWanted === 'Yes' && !maintTicketDescription.trim()) {
      return {
        message: 'Enter the maintenance ticket description, or choose “No”.',
        scrollToDomId: 'maint-ticket-widget',
        instanceKey: firstSummaryKey || '',
      };
    }
    return null;
  }

  // Guards the submit button for the whole persist→finalize round-trip so a
  // second tap on weak signal can't double-submit (ref = synchronous guard
  // against rapid taps; state = drives the disabled/label UI).
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  async function handleSubmit() {
    if (submittingRef.current) return;
    const err = validate();
    if (err) {
      await dialog.alert(err.message);
      scrollToAndFlash(err.scrollToDomId, err.instanceKey);
      return;
    }
    // HVAC + Smart Home checklist (reused Scope widgets) must be complete.
    if (fcEnabled) {
      const gap = finalChecklistGap(fcAnswers, fcCtx, { onlySectionIds: fcGateIds, skipLineRules: true });
      if (gap) { await dialog.alert(`Please complete: ${gap}`); return; }
    }
    // Don't finalize while photos are still queued — the persist below strips
    // unsynced blob: urls, so submitting now would LOSE them from the record (the
    // field failure where photos went missing). Try one more flush, then if any
    // remain, tell the inspector exactly what's pending and let them wait (the
    // safe default) rather than silently dropping evidence.
    if (!readOnly) {
      try { await runPhotoFlushRef.current(); } catch { /* surfaced below */ }
      let pendingPhotos = 0;
      try { pendingPhotos = await countQueuedPhotos(inspectionRecordId); } catch { /* treat as 0 */ }
      if (pendingPhotos > 0) {
        const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
        if (offline) {
          await dialog.alert(
            `${pendingPhotos} photo${pendingPhotos === 1 ? '' : 's'} still need${pendingPhotos === 1 ? 's' : ''} to upload, but you're offline. ` +
            `Move to an area with signal and stay on this screen until they finish, then submit — they aren't saved yet.`,
          );
          return;
        }
        const proceed = await dialog.confirm(
          `${pendingPhotos} photo${pendingPhotos === 1 ? '' : 's'} ${pendingPhotos === 1 ? 'is' : 'are'} still uploading. ` +
          `If you submit now ${pendingPhotos === 1 ? 'it' : 'they'} may not be attached to the report. ` +
          `Keep this screen open a few more seconds and they'll finish.`,
          { confirmLabel: 'Submit anyway', cancelLabel: 'Keep waiting' },
        );
        if (!proceed) return;
      }
    }
    const totalSectionPhotos = Object.values(sectionPhotos).flat().length;
    const totalQuestionPhotos = Object.values(answers).reduce((acc, a) => acc + a.photoUrls.length, 0);
    const ok = await dialog.confirm(
      `Submit ${Object.keys(answers).length} answers, ` +
      `${totalQuestionPhotos} question photos, ` +
      `${totalSectionPhotos} section photos to HubSpot?`,
      { confirmLabel: 'Submit' }
    );
    if (!ok) return;

    submittingRef.current = true;
    setSubmitting(true);
    try {
    // Persist ALL answered questions to HubSpot before finalizing. Do NOT rely
    // solely on the debounced autosave having flushed — if real-time autosave
    // hiccupped, those edits would otherwise live only in memory, the PDF would
    // still build (it reads in-memory state), and the record would be empty on
    // reopen. This explicit upsert is the authoritative save and MUST succeed.
    if (!readOnly) {
      // Flush any pending debounced edits first (handles recordId tracking).
      try { await autosave.flush(true); } catch { /* re-saved explicitly below */ }

      // Build a full upsert payload for every answered question, keyed by the
      // same deterministic natural key (answer_id_external) used everywhere.
      const upserts: Array<{
        recordId?: string;
        answerProps: Record<string, any>;
        questionHubspotRecordId?: string;
      }> = [];
      for (const inst of sectionInstances) {
        for (const q of inst.questions) {
          const key = answerKey(q.questionIdExternal, inst.instanceKey);
          const a = answers[key];
          if (!a) continue;
          const hasContent =
            (a.answerValue && a.answerValue.trim() !== '') ||
            (a.note && a.note.trim() !== '') ||
            a.quantity != null ||
            (a.assignedTo && a.assignedTo.trim() !== '') ||
            (a.photoUrls && a.photoUrls.length > 0);
          if (!hasContent) continue;

          const externalId = buildAnswerExternalId(inspectionExternalId, q.questionIdExternal, inst.instanceKey);
          const existingRecordId = answerRecordIdsRef.current.get(key);
          // QuestionForm only renders Q&A templates; Scope uses RateCardForm.
          // So quantity / assigned_to are never written from here (isScope:false).
          const props = buildQaAnswerProps({
            answerIdExternal: externalId,
            inspectionIdExternal: inspectionExternalId,
            questionIdExternal: a.questionIdExternal,
            questionText: a.questionText,
            section: a.section,
            summaryInstanceLabel: inst.instanceKey,
            answerValue: a.answerValue || '',
            location: inst.location,
            note: a.note,
            quantity: a.quantity,
            assignedTo: a.assignedTo,
            photoUrls: (a.photoUrls || []).filter((u) => !u.startsWith('blob:')),
          }, { isScope: false });
          upserts.push({
            recordId: existingRecordId || undefined,
            answerProps: props,
            questionHubspotRecordId: existingRecordId ? undefined : q.hubspotRecordId,
          });
        }
      }

      if (upserts.length > 0) {
        const resp = await fetch(`/api/inspections/${inspectionRecordId}/answers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ upserts, archives: [], bumpStatusToInProgress: true }),
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          await dialog.alert(
            `Could not save answers to HubSpot before submitting (${resp.status}). ` +
            `Your inspection was NOT submitted so nothing is lost — please check your ` +
            `connection and try Submit again.${text ? `\n\n${text.slice(0, 160)}` : ''}`
          );
          return; // Block submit — do not finalize an empty record.
        }
        // Update recordId map from the response so a later re-submit PATCHes.
        try {
          const data = await resp.json();
          for (const r of (data.results || []) as Array<{ recordId: string; answerIdExternal: string }>) {
            // Find the form key whose external id matches and store its recordId.
            for (const inst of sectionInstances) {
              for (const q of inst.questions) {
                const eid = buildAnswerExternalId(inspectionExternalId, q.questionIdExternal, inst.instanceKey);
                if (eid === r.answerIdExternal) {
                  answerRecordIdsRef.current.set(answerKey(q.questionIdExternal, inst.instanceKey), r.recordId);
                }
              }
            }
          }
        } catch { /* response parse is best-effort */ }
      }
    }

    // For non-Scope: ensure triggered answers get quantity=1 if not set
    const finalAnswers = Object.values(answers).map((a) => {
      const q = formQuestions.find((x) => x.questionIdExternal === a.questionIdExternal);
      const isTriggered = !!q && !!a.answerValue && q.noteRequiredOnValues.includes(a.answerValue);
      let finalQuantity = a.quantity;
      if (isTriggered && (finalQuantity == null || Number.isNaN(finalQuantity))) {
        finalQuantity = 1;
      }
      return { ...a, quantity: finalQuantity };
    });

    // Build sectionPhotoUrls keyed by display name (with location). The submit
    // API maps these to section_photo Answer records that include location.
    const sectionPhotoUrlsForApi: Record<string, string[]> = {};
    for (const inst of sectionInstances) {
      const urls = sectionPhotos[inst.instanceKey] || [];
      if (urls.length === 0) continue;
      // Use the instance display name as the key (e.g., "Bedroom 1") so PDFs and
      // Answer records preserve the location.
      sectionPhotoUrlsForApi[inst.displayName] = urls;
    }

    // Make sure the HVAC/Smart Home checklist blob is persisted before finalize.
    if (fcEnabled) { try { await saveFc(fcAnswers); } catch { /* surfaced via answers save */ } }

    // Maintenance-ticket outcome (1099 / vacancy fails). Append the inspector's
    // answers so they print on the PDF, and pass the structured outcome up so the
    // page can write inspection_result + raise the ticket after PDF generation.
    const wantsTicket = maintTicketEligible && maintTicketWanted === 'Yes' && !!maintTicketDescription.trim();
    const summarySection = summaryInstance?.baseSectionName || 'Review & Sign-Off';
    if (maintTicketEligible && maintTicketWanted) {
      finalAnswers.push({
        questionIdExternal: 'maint_ticket_request', questionHubspotRecordId: '',
        questionText: 'Submit a maintenance ticket?', section: summarySection,
        answerValue: maintTicketWanted, note: '', quantity: null, photoUrls: [],
      });
      if (wantsTicket) {
        finalAnswers.push({
          questionIdExternal: 'maint_ticket_description', questionHubspotRecordId: '',
          questionText: 'Maintenance ticket description', section: summarySection,
          answerValue: maintTicketDescription.trim(), note: '', quantity: null, photoUrls: [],
        });
      }
    }
    const meta: QuestionFormSubmitMeta = {
      inspectionResult: overallResult,
      maintenanceTicket: { wanted: wantsTicket, description: wantsTicket ? maintTicketDescription.trim() : '' },
      finalChecklist: fcEnabled ? summarizeFinalChecklist(fcAnswers, fcCtx) : undefined,
      finalChecklistPhotos: fcEnabled ? finalChecklistPhotos(fcAnswers) : undefined,
    };

    onSubmit(finalAnswers, sectionPhotoUrlsForApi, meta);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  // Completion progress per instance
  const sectionProgress = useMemo(() => {
    const out: Record<string, { completed: number; total: number }> = {};
    for (const inst of sectionInstances) {
      let completed = 0;
      let total = 0;
      for (const q of inst.questions) {
        if (!isWidgetVisible(q.questionIdExternal, inst.instanceKey)) continue;
        if (isHiddenWhenOccupied(q)) continue;
        // Optional questions don't count toward the progress total — e.g. the
        // all-optional Review / Sign-Off section should not show "0/1".
        if (!q.isRequired) continue;
        total++;
        const a = answers[answerKey(q.questionIdExternal, inst.instanceKey)];
        const done = q.responseType === 'photo_only'
          ? (a?.photoUrls?.length || 0) > 0
          : !!a?.answerValue;
        if (done) completed++;
      }
      out[inst.instanceKey] = { completed, total };
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionInstances, answers]);

  // Roll the reused Scope sections (HVAC/Smart Home/Utilities) into the header
  // total alongside the question sections.
  const fcTotals = fcEnabled
    ? fcGateIds.reduce((acc, id) => {
        const c = fcSectionCounts(fcAnswers, fcCtx, id, { skipLineRules: true });
        return { completed: acc.completed + c.completed, total: acc.total + c.total };
      }, { completed: 0, total: 0 })
    : { completed: 0, total: 0 };
  const totalCompleted = Object.values(sectionProgress).reduce((acc, s) => acc + s.completed, 0) + fcTotals.completed;
  const totalQuestions = Object.values(sectionProgress).reduce((acc, s) => acc + s.total, 0) + fcTotals.total;

  // Live Pass / Fail tally across all answered Good/Fail questions — shown in
  // the header by the address and updated as the inspector makes selections.
  // Device-storage status — photos sit in local IndexedDB until they sync, so
  // warn Q&A inspectors before the device fills up (parity with the scope form).
  const storage = useStorageQuota();

  const { passCount, failCount } = useMemo(() => {
    let pass = 0, fail = 0;
    for (const a of Object.values(answers)) {
      const t = answerTone(a.answerValue);
      if (t === 'good') pass++; else if (t === 'fail') fail++;
    }
    return { passCount: pass, failCount: fail };
  }, [answers]);

  // The Review/Sign-off/Summary section (if any) renders LAST — after the reused
  // Scope HVAC/Smart Home/Utilities bubbles. (After the cleanup these merge into
  // one "Review & Sign-Off" section.)
  const firstSummaryKey = sectionInstances.find((i) => /summary|review|sign.?off/i.test(i.baseSectionName))?.instanceKey;

  // Overall Pass/Fail verdict from the Review & Sign-Off section: any failing
  // answer → 'fail', else any passing answer → 'pass', else null. Synced to the
  // inspection's `inspection_result` field at submit (same as QC) and drives the
  // maintenance-ticket widget below.
  const summaryInstance = sectionInstances.find((i) => i.instanceKey === firstSummaryKey);
  const overallResult: 'pass' | 'fail' | null = useMemo(() => {
    if (!summaryInstance) return null;
    let hasFail = false, hasGood = false;
    for (const q of summaryInstance.questions) {
      const a = answers[answerKey(q.questionIdExternal, summaryInstance.instanceKey)];
      const tone = answerTone(a?.answerValue || '');
      if (tone === 'fail') hasFail = true;
      else if (tone === 'good') hasGood = true;
    }
    return hasFail ? 'fail' : hasGood ? 'pass' : null;
  }, [summaryInstance, answers]);
  // The maintenance-ticket prompt is offered only on the two templates with a
  // pass/fail sign-off, and only when that verdict is Fail.
  const maintTicketEligible =
    (templateType === 'leasing_agent_1099_property_inspection' || isVacancy)
    && overallResult === 'fail';
  // The failed sign-off question's id — the maintenance-ticket widget renders
  // directly under it (above Additional Comments), in line with the Fail tap.
  const summaryFailQuestionId: string | null = useMemo(() => {
    if (!summaryInstance) return null;
    for (const q of summaryInstance.questions) {
      const a = answers[answerKey(q.questionIdExternal, summaryInstance.instanceKey)];
      if (answerTone(a?.answerValue || '') === 'fail') return q.questionIdExternal;
    }
    return null;
  }, [summaryInstance, answers]);
  // Smart Home renders right after the Yard / Exterior section; HVAC + Utilities
  // stay grouped at the bottom (above Review & Sign-Off).
  const yardKey = sectionInstances.find((i) => /yard|exterior/i.test(i.baseSectionName))?.instanceKey;

  // Builder for a reused Scope bubble group (each section its own bubble).
  // seamless = render as plain rows (embedded inside another section);
  // mergeName = collapse the given sections into one section under that title.
  const makeFc = (only: string[], opts?: { seamless?: boolean; mergeName?: string }) => (
    <FinalChecklist
      bare
      seamless={opts?.seamless}
      mergeName={opts?.mergeName}
      only={only}
      openAllToken={fcOpenToken}
      answers={fcAnswers}
      onPatch={onFcPatch}
      uploadPhoto={(file, fieldKey) => uploadPhotoOrQueue(file, inspectionRecordId, FC_PHOTO_SECTION, { lineExternalId: fieldKey })}
      propertyName={propertyName}
      propertyRecordId={propertyRecordId}
      propertyValues={propertyValues}
      filterSizeOptions={filterSizeOptions}
      readOnly={readOnly}
    />
  );
  // Smart Home Tech renders just ABOVE the "Whole House" section (preferred);
  // if there's no Whole House section it falls in above Yard/Exterior, and with
  // neither it drops into the bottom group.
  const wholeHouseKey = sectionInstances.find((i) => /whole\s*house/i.test(i.baseSectionName))?.instanceKey;
  const smartAnchorKey = wholeHouseKey || yardKey;
  // 1099 ONLY: Smart Home Tech becomes the first rows INSIDE the Whole House
  // section (seamless — no separate section), and HVAC + Utilities merge into one
  // "HVAC / Utilities" section (utilities at the end). Other scope-style templates
  // keep the standalone-section layout (Smart Home above Whole House/Yard).
  const is1099 = templateType === 'leasing_agent_1099_property_inspection';
  const smartFc = fcEnabled && smartAnchorKey
    ? makeFc(['smart_home_tech'], is1099 ? { seamless: true } : undefined)
    : null;
  // When occupied (Vacancy/Occupancy), drop HVAC & Air Filters + Utilities from
  // the bottom group; Smart Home Tech stays.
  const bottomKeys = smartAnchorKey
    ? (occupied ? [] : ['hvac_air_filters', 'utilities'])
    : (occupied ? ['smart_home_tech'] : FC_ONLY);
  const bottomFc = fcEnabled && bottomKeys.length
    ? makeFc(bottomKeys, is1099 ? { mergeName: 'HVAC / Utilities' } : undefined)
    : null;

  // Header status badge + "Submitted" stamp (only while actually submitted).
  const headerBadge = statusBadge(status);
  const isSubmittedState = (() => {
    const s = (status || '').toLowerCase().replace(/[ -]/g, '_');
    return s === 'pending_approval' || s === 'completed' || s === 'complete';
  })();

  return (
    <main className="min-h-screen bg-white">
      {/* Device-storage warning. Photos sit in local storage until they sync;
          if the device fills up, new captures fail. Warn early. */}
      {storage.nearFull && (
        <div className={`px-4 py-1.5 text-xs font-heading font-semibold flex items-center justify-center gap-2 ${storage.critical ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'}`}>
          <span className={`inline-block w-2 h-2 rounded-full ${storage.critical ? 'bg-red-500' : 'bg-amber-500'}`} />
          {storage.critical
            ? `Device storage almost full (${formatMB(storage.usageBytes)} of ${formatMB(storage.quotaBytes)}). Sync or free up space soon — new photos may fail to save.`
            : `Device storage is filling up (${Math.round(storage.pct * 100)}% used). Reconnect to sync photos and free up space.`}
        </div>
      )}

      {/* Top block — title + inspector + Back. NOT sticky: scrolls away (Scope style). */}
      <div className="lz-head max-w-3xl mx-auto px-4 pt-3 pb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {/* Title + status on ONE line — the title font auto-shrinks so both
                the full template name AND the status chip fit without truncating
                (Unlock is now a small bubble, so there's room). min-h matches the
                Unlock/Back control row so the status chip lines up with them. */}
            <div className="flex items-center gap-2 min-h-[32px]">
              <FitText
                text={templateLabel}
                className="font-heading font-bold text-gray-900 flex-1 min-w-0"
                max={20}
                min={11}
              />
              {headerBadge && (
                <span className={`inline-flex items-center shrink-0 px-2 py-0.5 rounded-full text-xs font-semibold border ${headerBadge.color}`}>{headerBadge.label}</span>
              )}
            </div>
            <div className="text-xs text-gray-500 mt-0.5">
              Inspector: {inspectorName}
              {isSubmittedState && fmtStamp(submittedAt) && (
                <span className="text-gray-400">{'  ·  '}{fmtStamp(submittedAt)} Submitted</span>
              )}
            </div>
            {pdfUrl && (
              <a
                href={pdfUrl}
                onClick={(e) => { e.preventDefault(); openPdf(pdfUrl, `${templateLabel} Report`); }}
                className="mt-1 inline-flex items-center gap-1 text-xs font-heading font-semibold text-brand hover:underline cursor-pointer"
                title="View the generated inspection report"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                View PDF Report
              </a>
            )}
          </div>
          {/* Unlock (Rently code) + Back on ONE row so they don't add height.
              Compact circle to the LEFT of Back; hidden once read-only
              (completed / cancelled / view-only). */}
          <div className="shrink-0 self-start flex flex-row items-center gap-2">
          {!readOnly && (
            <UnlockButton
              propertyId={propertyRecordId}
              address={propertyName}
              inspectionId={inspectionRecordId}
            />
          )}
          <button
            type="button"
            onClick={async () => {
              if (!readOnly) {
                try { await autosave.flush(true); } catch (e) { console.error('Back: flush failed', e); }
              }
              onCancel();
            }}
            className="inline-flex items-center gap-1 h-8 px-2.5 text-xs font-heading font-semibold text-gray-700 hover:text-gray-900 border border-gray-300 hover:border-gray-400 rounded-lg bg-white"
            title="Save and go back"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M19 12H5" /><path d="M12 19l-7-7 7-7" /></svg>
            Back
          </button>
          </div>
        </div>
      </div>

      {/* Frozen header — logo + address + status + meta. The ONLY thing pinned
          on scroll (mirrors the Scope rate-card sticky header). */}
      <header className="sticky top-0 z-10 bg-white border-b-2 border-brand shadow-sm">
        <div className="max-w-3xl mx-auto px-4 py-1.5">
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={async () => { if (!readOnly) { try { await autosave.flush(true); } catch { /* leave anyway */ } } onCancel(); }}
              aria-label="Back to inspections"
              title="Back to inspections"
              className="shrink-0"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/favicon.svg" alt="ResiWalk" className="h-9 w-9 object-contain" />
            </button>
            <div className="min-w-0 flex-1">
              {/* Community / Visit: the community name sits ABOVE the address. */}
              {isCommunity && communityName && (
                <div className="text-sm font-heading font-bold text-brand truncate" title={communityName}>
                  {communityName}
                </div>
              )}
              {/* Full address on ONE line — never wraps; the font shrinks to fit
                  the available width. */}
              <FitText
                text={propertyName}
                className="font-heading font-semibold text-ink"
              />
              <div className="text-xs text-gray-500 truncate">
                {bedrooms} Bed / {bathrooms} Bath
                {squareFootage != null && squareFootage > 0 && (
                  <span> &middot; {squareFootage.toLocaleString()} sqft</span>
                )}
                {inspectionRegion && <span> &middot; {inspectionRegion}</span>}
              </div>
              {/* Property status (Turnkey / Vacant / Unmarketed / …) on its OWN
                  line, with the listing's Move-in Ready date to its right
                  (MIR: M/D/YY). Frozen at completion. */}
              {(propertyStatus || moveInReadyDate) && (
                <div className="text-xs text-gray-500 truncate">
                  {propertyStatus}
                  {propertyStatus && moveInReadyDate && <span> &middot; </span>}
                  {moveInReadyDate && <span>MIR: {moveInReadyDate}</span>}
                </div>
              )}
              {/* Listing line (status · price · listed date). SAME font/size/
                  weight as the meta lines above (text-xs, normal weight) — only
                  the COLOR differs: green when Active, amber otherwise, so listing
                  state still reads at a glance. */}
              {!isCommunity && (listingStatus || (typeof listingPrice === 'number' && listingPrice > 0) || listingDate) ? (
                <div className={`text-xs truncate ${
                  listingStatus
                    ? (/active/i.test(listingStatus) ? 'text-emerald-700' : 'text-amber-600')
                    : 'text-gray-500'
                }`}>
                  {listingStatus && <span>{listingStatus}</span>}
                  {typeof listingPrice === 'number' && listingPrice > 0 && (
                    <span>{listingStatus ? ' · ' : ''}Listing ${listingPrice.toLocaleString()}</span>
                  )}
                  {listingDate && (
                    <span>{(listingStatus || (typeof listingPrice === 'number' && listingPrice > 0)) ? ' · ' : ''}Listed {listingDate}</span>
                  )}
                </div>
              ) : null}
            </div>
            {/* Right column: live Pass/Fail tally stacked ABOVE the standardized
                save indicator, right-aligned and vertically centered. Keeping them
                here (instead of a full-width row below) removes a line and trims
                the header's height. The save indicator is hidden on short
                landscape to reclaim space. */}
            {(scopeStyle || !readOnly) && (
              <div className="shrink-0 flex flex-col items-end justify-center gap-1">
                {scopeStyle && (
                  <div className="flex items-center gap-1.5 text-[11px] font-heading font-bold">
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">{passCount} Pass</span>
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-brand/10 text-brand border border-brand/30">{failCount} Fail</span>
                  </div>
                )}
                {!readOnly && (
                  <div className="lz-hide text-right"><SaveIndicator phase={autosave.saveState.kind} /></div>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="lz-content max-w-3xl mx-auto px-4 py-6 pb-32">
        {/* Collapse / Expand all — top-right, just above the sections. */}
        {/* Answered counter (moved off the header so the property text gets full
            width) on the left; Collapse/Expand-all on the right. */}
        <div className="flex items-center justify-between mb-2 gap-3">
          <span className="text-xs font-heading font-semibold text-gray-600">
            <span className="text-brand">{totalCompleted}/{totalQuestions}</span> answered
          </span>
          {sectionInstances.length > 1 && (
            <button
              type="button"
              onClick={() => setAllCollapsed(!anySectionOpen)}
              className="inline-flex items-center gap-1 text-xs font-heading font-semibold text-gray-500 hover:text-gray-800 transition-colors"
              title={anySectionOpen ? 'Collapse all sections' : 'Expand all sections'}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                   className={`transition-transform ${anySectionOpen ? '' : 'rotate-180'}`}>
                <polyline points="18 15 12 9 6 15" />
              </svg>
              {anySectionOpen ? 'Collapse all' : 'Expand all'}
            </button>
          )}
        </div>
        {sectionInstances.map((inst) => {
          const prog = sectionProgress[inst.instanceKey];
          const sectionPhotoUrls = sectionPhotos[inst.instanceKey] || [];
          const photosRequired = !sectionPhotosExempt(inst.baseSectionName, inst.sectionOrder, templateType);
          const photosMissing = photosRequired && sectionPhotoUrls.length === 0;
          const isCollapsed = collapsed.has(inst.instanceKey);
          const sectionDomId = `section-${inst.instanceKey}`;

          return (
            <Fragment key={inst.instanceKey}>
            {/* HVAC + Utilities sit just above the Review & Sign-Off section. */}
            {inst.instanceKey === firstSummaryKey && bottomFc}
            {/* Non-1099 scope-style: Smart Home Tech is its own section above the
                anchor. (1099 embeds it inside the section body instead — below.) */}
            {!is1099 && inst.instanceKey === smartAnchorKey && smartFc}
            <section id={sectionDomId} className="lz-gap mb-8 scroll-mt-24 rounded-xl shadow-md overflow-hidden">
              {/* Section header (tappable to collapse) */}
              <button
                type="button"
                onClick={() => toggleCollapsed(inst.instanceKey)}
                aria-expanded={!isCollapsed}
                className="w-full bg-gray-50 text-gray-900 border-b border-gray-200 px-4 py-3 flex items-center justify-between text-left hover:bg-gray-100 transition"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <svg
                    width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                    className={`shrink-0 transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
                  >
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                  <h2 className="font-heading font-bold text-lg truncate">{inst.displayName}</h2>
                  {photosMissing && (
                    <span
                      className="inline-flex items-center gap-1 text-xs bg-amber-400 text-amber-950 font-heading font-bold px-2 py-0.5 rounded-full shrink-0"
                      title="This section requires at least one photo"
                    >
                      📷 Photos Needed
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0 ml-3">
                  {prog.total > 0 && (
                    <span className="text-sm bg-brand text-white font-heading font-semibold px-2.5 py-0.5 rounded-full">
                      {prog.completed}/{prog.total}
                    </span>
                  )}
                </div>
              </button>

              {!isCollapsed && (
                <div className="bg-white border-x border-b border-gray-200 divide-y divide-gray-100">
                  {/* Section photos — compact single-row layout (matches RateCardForm).
                      The amber highlight for missing required photos stays. */}
                  <div className={`px-3 py-1.5 ${photosMissing ? 'bg-amber-50' : 'bg-gray-50'}`}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-baseline gap-2 min-w-0">
                        <button
                          type="button"
                          onClick={() => setPhotosCollapsed((c) => ({ ...c, [inst.instanceKey]: !c[inst.instanceKey] }))}
                          className="flex items-baseline gap-1.5 min-w-0"
                        >
                          <span className={`text-gray-400 text-[10px] self-center transition-transform ${photosCollapsed[inst.instanceKey] ? '' : 'rotate-90'}`}>&#9654;</span>
                          <span className="text-xs font-semibold text-gray-700 uppercase tracking-wide whitespace-nowrap">
                            Photos
                            {photosRequired
                              ? <span className="text-brand ml-1">*</span>
                              : <span className="text-gray-400 normal-case font-normal ml-1">(Optional)</span>}
                          </span>
                        </button>
                        {photosMissing && uploadingSection?.instanceKey !== inst.instanceKey && (
                          <span className="text-xs text-amber-800 font-semibold whitespace-nowrap">&ge;1 Required</span>
                        )}
                        {uploadingSection?.instanceKey === inst.instanceKey && (
                          <span className="text-xs text-brand font-semibold">
                            {uploadingSection.current}/{uploadingSection.total}…
                          </span>
                        )}
                        {sectionPhotoUrls.length > 0 && !photosMissing && uploadingSection?.instanceKey !== inst.instanceKey && (
                          <span className="text-xs text-gray-500 whitespace-nowrap">{sectionPhotoUrls.length} added</span>
                        )}
                      </div>
                      {!readOnly && (
                        <div className="flex gap-2 items-center shrink-0">
                          <button
                            type="button"
                            onClick={() => setSectionCameraInstance(inst.instanceKey)}
                            disabled={!!uploadingSection || !hasMediaDevices}
                            className="inline-flex items-center gap-1 text-xs bg-brand text-white font-semibold py-1 px-2 rounded hover:bg-brand-dark disabled:bg-gray-300 disabled:cursor-not-allowed"
                            title={hasMediaDevices ? 'In-app camera' : 'Camera not supported in this browser'}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                              <circle cx="12" cy="13" r="4" />
                            </svg>
                            Take
                          </button>
                          {/* scopeStyle: single Take button (the in-app camera also
                              covers gallery selection), matching the Scope Rate Card. */}
                          {!scopeStyle && (
                          <label className={`inline-flex items-center gap-1 text-xs bg-brand/10 text-brand font-semibold py-1 px-2 rounded hover:bg-brand/20 ${
                            uploadingSection?.instanceKey === inst.instanceKey ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
                          }`}>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                              <polyline points="17 8 12 3 7 8" />
                              <line x1="12" y1="3" x2="12" y2="15" />
                            </svg>
                            Upload
                            <input
                              type="file"
                              accept="image/*"
                              multiple
                              onChange={(e) => handleSectionPhotoChange(inst.instanceKey, e.target.files)}
                              disabled={uploadingSection?.instanceKey === inst.instanceKey}
                              className="hidden"
                            />
                          </label>
                          )}
                        </div>
                      )}
                    </div>
                    {sectionPhotoUrls.length > 0 && !photosCollapsed[inst.instanceKey] && !cameraOpenAnywhere && (
                      <div className="flex gap-1.5 overflow-x-auto pb-1 mt-2 -mx-0.5 px-0.5">
                        {sectionPhotoUrls.map((url, idx) => (
                          <div key={`${url}-${idx}`} className="relative shrink-0">
                            <PhotoThumb
                              url={url}
                              alt=""
                              onClick={() => setPhotoLightbox({ instanceKey: inst.instanceKey, index: idx })}
                              className="w-16 h-16 object-cover rounded border border-gray-200 cursor-pointer"
                            />
                            {isVideoEntry(url) && (
                              <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                <span className="w-6 h-6 rounded-full bg-black/55 flex items-center justify-center">
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z" /></svg>
                                </span>
                              </span>
                            )}
                            {url.startsWith('blob:') && (
                              <SyncingBadge />
                            )}
                            {!readOnly && (
                              <button
                                type="button"
                                onClick={() => removeSectionPhoto(inst.instanceKey, idx)}
                                className="absolute -top-1 -right-1 bg-ink text-white text-xs w-4 h-4 rounded-full leading-none flex items-center justify-center hover:bg-brand"
                              >&times;</button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* 1099: Smart Home Tech renders as the FIRST rows of the Whole
                      House section (seamless — no separate section). */}
                  {is1099 && inst.instanceKey === smartAnchorKey && smartFc}

                  {/* Questions for this instance (hidden conditional widget
                      fields are filtered out). */}
                  {inst.questions.filter((q) => isWidgetVisible(q.questionIdExternal, inst.instanceKey) && !isHiddenWhenOccupied(q)).map((q) => {
                    const key = answerKey(q.questionIdExternal, inst.instanceKey);
                    // Render the maintenance-ticket widget immediately AFTER the
                    // failed Pass/Fail question (so it sits above Additional
                    // Comments, in line with the Fail tap).
                    const showTicketWidget = maintTicketEligible
                      && inst.instanceKey === firstSummaryKey
                      && q.questionIdExternal === summaryFailQuestionId;
                    return (
                      <Fragment key={key}>
                      <div id={`q-${inst.instanceKey}-${q.questionIdExternal}`} className="scroll-mt-24">
                        <QuestionItem
                          question={q}
                          answer={answers[key]}
                          onUpdate={(patch) => updateAnswer(key, patch)}
                          uploadPhoto={(file) => uploadPhotoOrQueue(file, inspectionRecordId, key)}
                          propertyName={propertyName}
                          propertyRecordId={propertyRecordId}
                          plainStyle={scopeStyle}
                          photoFirst={isCommunity}
                          compactOptions={isCommunity}
                          listingPrice={listingPrice}
                        />
                      </div>
                      {showTicketWidget && (
                        <div id="maint-ticket-widget" className="scroll-mt-24 mt-3 rounded-lg border border-brand/30 bg-brand/5 p-4">
                          <div className="font-heading font-semibold text-ink text-sm mb-2">Do you want to submit a maintenance ticket?</div>
                          <div className="flex gap-2">
                            {(['Yes', 'No'] as const).map((opt) => (
                              <button
                                key={opt}
                                type="button"
                                disabled={readOnly}
                                onClick={() => { setMaintTicketWanted(opt); if (opt === 'No') setMaintTicketDescription(''); }}
                                className={`px-4 py-2 rounded-lg text-sm font-heading font-semibold border transition-colors ${
                                  maintTicketWanted === opt
                                    ? 'bg-brand text-white border-brand'
                                    : 'bg-white text-ink border-gray-300 hover:border-brand/50'
                                }`}
                              >
                                {opt}
                              </button>
                            ))}
                          </div>
                          {maintTicketWanted === 'Yes' && (
                            <div className="mt-3">
                              <label htmlFor="maint-ticket-desc" className="block text-sm font-heading font-semibold text-ink mb-1.5">
                                Ticket description <span className="text-brand">*</span>
                              </label>
                              <textarea
                                id="maint-ticket-desc"
                                value={maintTicketDescription}
                                disabled={readOnly}
                                onChange={(e) => setMaintTicketDescription(e.target.value)}
                                rows={3}
                                placeholder="Describe the issue / work needed. This becomes the maintenance ticket description."
                                className="focus-brand w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base bg-white"
                              />
                              <div className="text-xs text-gray-500 mt-1">Required before you can submit.</div>
                            </div>
                          )}
                        </div>
                      )}
                      </Fragment>
                    );
                  })}

                </div>
              )}
            </section>
            </Fragment>
          );
        })}

        {/* If there's no Summary section, the bottom group renders here;
            otherwise it was rendered just above Review & Sign-Off. */}
        {!firstSummaryKey && bottomFc}
      </div>

      {/* Sticky submit bar.
          Layout: Cancel Inspection (destructive) anchored LEFT so it's
          isolated from the primary actions. Save & Close + Submit grouped
          on the right. Save & Close gets a green hover/active style for
          visual reassurance that it's saving work. Matches the same layout
          used in RateCardForm so behavior is consistent across templates. */}
      <div className="lz-foot fixed bottom-0 inset-x-0 bg-white border-t-2 border-brand px-3 sm:px-4 py-2 shadow-lg">
        <div className={`max-w-3xl mx-auto flex items-center gap-2 ${readOnly ? 'justify-center' : 'justify-between'}`}>
          {/* scopeStyle templates drop the destructive Cancel button and move
              Save & Close to the LEFT (Submit stays on the right). Completed /
              read-only inspections have no left actions, so the whole bar
              (Close + status) is centered instead. */}
          {!readOnly && (
          <div className="shrink-0">
            {!readOnly && onCancelInspection && !scopeStyle && (
              <button
                type="button"
                onClick={onCancelInspection}
                className="px-2.5 sm:px-3 py-2.5 sm:py-3 border border-red-300 rounded-lg hover:bg-red-50 font-heading font-semibold text-red-700 text-xs sm:text-sm whitespace-nowrap"
                title="Mark this Inspection as Cancelled in HubSpot"
              >
                Cancel
              </button>
            )}
            {!readOnly && scopeStyle && (
              <button
                type="button"
                onClick={async () => {
                  try {
                    await autosave.flush(true);
                  } catch (e) {
                    console.error('Save & Close: flush failed', e);
                  }
                  onCancel();
                }}
                className="px-2.5 sm:px-3 py-2.5 sm:py-3 border border-emerald-300 rounded-lg hover:bg-emerald-600 hover:text-white hover:border-emerald-600 active:bg-emerald-700 active:border-emerald-700 font-heading font-semibold text-emerald-700 text-xs sm:text-sm transition-colors whitespace-nowrap"
                title="Save any pending changes and return to the inspection list. Inspection stays In Progress."
              >
                Save &amp; Close
              </button>
            )}
          </div>
          )}
          <div className="flex items-center gap-2 justify-end shrink-0">
            {!readOnly && !scopeStyle && (
              <button
                type="button"
                onClick={async () => {
                  // Force a final flush so the last 2 seconds of debounced edits get saved.
                  // Inspection remains in current status (Scheduled or In Progress).
                  try {
                    await autosave.flush(true);
                  } catch (e) {
                    // Even if save fails, we should still leave -- alert and continue
                    console.error('Save & Close: flush failed', e);
                  }
                  onCancel();
                }}
                className="px-2.5 sm:px-3 py-2.5 sm:py-3 border border-emerald-300 rounded-lg hover:bg-emerald-600 hover:text-white hover:border-emerald-600 active:bg-emerald-700 active:border-emerald-700 font-heading font-semibold text-emerald-700 text-xs sm:text-sm transition-colors whitespace-nowrap"
                title="Save any pending changes and return to the inspection list. Inspection stays In Progress."
              >
                Save &amp; Close
              </button>
            )}
            {readOnly && (
              <button
                type="button"
                onClick={onCancel}
                className="px-3 py-3 border border-gray-300 rounded-lg hover:bg-gray-50 font-heading font-semibold text-ink text-sm whitespace-nowrap"
                title="Return to inspection list"
              >
                Close
              </button>
            )}
            {!readOnly && (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting}
                className="bg-brand hover:bg-brand-dark text-white font-heading font-bold px-3 sm:px-5 py-2.5 sm:py-3 rounded-lg active:scale-[0.99] transition text-xs sm:text-sm whitespace-nowrap disabled:opacity-60 disabled:cursor-not-allowed disabled:active:scale-100"
              >
                {submitting ? (
                  <span className="inline-flex items-center gap-1.5">
                    <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" /></svg>
                    Submitting…
                  </span>
                ) : (
                  <>
                    <span className="sm:hidden">Submit</span>
                    <span className="hidden sm:inline">Submit Inspection</span>
                  </>
                )}
              </button>
            )}
            {readOnly && (
              <div className="text-center text-sm text-gray-500 font-heading py-3">
                This Inspection is Completed (read-only)
              </div>
            )}
          </div>
        </div>
      </div>

      {/* In-app camera overlay for section photos. Multi-room ("whole house")
          mode: the inspector can switch between sections/rooms without leaving
          the camera; photos auto-save to the room they were taken in on every
          switch. Q&A sections are template-driven, so rename/add/delete are not
          offered here (only navigation). */}
      <CameraCapture
        isOpen={sectionCameraInstance !== null}
        addressSnapshot={propertyName}
        propertyRecordId={propertyRecordId}
        onClose={() => setSectionCameraInstance(null)}
        uploadPhoto={(file) => uploadPhotoOrQueue(file, inspectionRecordId, sectionCameraInstance || '')}
        uploadVideoEntry={(videoFile, posterFile) => uploadVideoEntryOrQueue(videoFile, posterFile, inspectionRecordId, sectionCameraInstance || '')}
        rooms={sectionInstances.map((inst) => {
          const roomPhotos = sectionPhotos[inst.instanceKey] || [];
          const count = roomPhotos.length;
          const required = !sectionPhotosExempt(inst.baseSectionName, inst.sectionOrder, templateType);
          return {
            id: inst.instanceKey,
            name: inst.displayName,
            photoCount: count,
            needsPhotos: required && count === 0,
            photos: roomPhotos,
          };
        })}
        currentRoomId={sectionCameraInstance || undefined}
        onRoomChange={(leavingKey, capturedUrls, enteringKey) => {
          if (capturedUrls.length > 0) {
            setSectionPhotos((prev) => ({
              ...prev,
              [leavingKey]: [...(prev[leavingKey] || []), ...capturedUrls],
            }));
          }
          setSectionCameraInstance(enteringKey);
        }}
        onComplete={(urls) => {
          const ikey = sectionCameraInstance;
          setSectionCameraInstance(null);
          if (ikey && urls.length > 0) {
            setSectionPhotos((prev) => ({
              ...prev,
              [ikey]: [...(prev[ikey] || []), ...urls],
            }));
          }
        }}
      />

      {/* Section-photo viewer (swipe / markup / delete / video) */}
      {photoLightbox && (sectionPhotos[photoLightbox.instanceKey] || []).length > 0 && (
        <PhotoLightbox
          groups={[{ id: photoLightbox.instanceKey, name: 'Photos' }]}
          photosByGroup={{ [photoLightbox.instanceKey]: sectionPhotos[photoLightbox.instanceKey] || [] }}
          initialGroupId={photoLightbox.instanceKey}
          initialIndex={Math.min(photoLightbox.index, (sectionPhotos[photoLightbox.instanceKey] || []).length - 1)}
          readOnly={readOnly}
          onClose={() => setPhotoLightbox(null)}
          onDelete={(_g, i) => removeSectionPhoto(photoLightbox.instanceKey, i)}
          onReplace={(_g, i, file) => replaceSectionPhoto(photoLightbox.instanceKey, i, file)}
        />
      )}
    </main>
  );
}
