/**
 * RateCardForm — through Phase 4.5
 *
 * Sections + line-item picker + per-section photos with full HubSpot autosave
 * (Phase 3c) and inspector-customizable section list (Phase 4.5).
 *
 * Numbers are formatted with thousands separators (1,234.56).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TemplateType, RateCardLineItem, RegionRate, RateCardLineInput } from '@/lib/types';
import { EditableLineRow } from '@/components/EditableLineRow';
import { FinalChecklist } from '@/components/FinalChecklist';
import {
  finalChecklistGap,
  type FcAnswers, type FcAnswerState, type FcAddLineRule,
} from '@/lib/finalChecklist';
import { buildSectionPhotoAnswerProps, buildQaAnswerProps } from '@/lib/answerProps';
import { VoiceLineAssistant } from '@/components/VoiceLineAssistant';
import { CameraCapture } from '@/components/CameraCapture';
import { isInternalResolution, VENDORS, defaultVendorForCode } from '@/lib/vendors';
import { isAiWarm, warmAi } from '@/lib/aiWarm';
import { ListPicker } from '@/components/ListPicker';
import { getResolutionTimings, setResolutionTiming } from '@/lib/resolutionTiming';
import { AiReviewModal } from '@/components/AiReviewModal';
import { scopeHash, getPassedReviewHash, setPassedReviewHash, getIgnoredPhotoLines, addIgnoredPhotoLine, getReviewedItems, addReviewedItems, reviewSignature, saveReviewCache, loadReviewCache, clearReviewCache, type AiAdjustment } from '@/lib/aiReview';
import { calculateLine, roundMoney } from '@/lib/rateCardMath';
import { uploadFilesBatch, formatMoney } from '@/lib/photoUpload';

// Sentinel "section" used to queue Final Checklist photos through the offline
// photo store (so they survive offline like room/line photos). The flush + the
// rehydrate paths special-case this id to swap drafts in the checklist JSON.
const FC_PHOTO_SECTION = '__final_checklist__';
import { enqueue as outboxEnqueue, flushOutbox, entriesFor as outboxEntriesFor, countFor as outboxCountFor, isOfflineError, clearFor as outboxClearFor } from '@/lib/offlineOutbox';
import { reportSyncOutcome } from '@/lib/syncTelemetry';
import { uploadPhotoOrQueue, uploadVideoEntryOrQueue, countQueuedPhotos, rehydrateQueuedPhotos, flushQueuedPhotos, clearQueuedPhotos } from '@/lib/offlinePhotoStore';
import { loadCachedRateCard, saveCachedRateCard } from '@/lib/offlineCache';
import { useStorageQuota, formatMB } from '@/lib/storageQuota';
import { setErrorContext } from '@/lib/clientErrorReporter';
import { useAppDialog } from '@/components/AppDialog';
import { useFlash } from '@/components/Flash';
import {
  type SectionInstance,
  resolveSections,
  serializeSectionList,
  titleCaseSectionName,
  makeCustomSectionId,
} from '@/lib/sections';
import { SectionsManager } from '@/components/SectionsManager';
import { InspectionAuditTrail } from '@/components/InspectionAuditTrail';
import { PhotoLightbox } from '@/components/PhotoLightbox';
import { displayImageSrc } from '@/lib/photoDisplay';
import { isVideoEntry } from '@/lib/media';
import { stampEntryWithLabel, isStamped } from '@/lib/photoStamp';

// "M/DD/YYYY" stamp for the header submit/approve lines. Handles both ISO
// strings (text props) and epoch-ms strings (HubSpot datetime props).
function fmtStamp(v?: string | null): string {
  if (!v) return '';
  const s = String(v).trim();
  const d = /^\d+$/.test(s) ? new Date(Number(s)) : new Date(s);
  if (isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
}

interface RateCardFormProps {
  templateType: TemplateType;
  templateLabel: string;
  inspectorName: string;
  /** Submit/approve stamps for the header (ISO strings). */
  submittedAt?: string | null;
  /** Email of whoever submitted for approval, and the logged-in user's email.
   *  When they match AND status is pending_approval, the Finalize button is
   *  PERMANENTLY locked (mirrors the server) so the submitter can never finalize
   *  their own work — a second reviewer must. Their only move is Save & Close.
   *  A finalize admin (isFinalizeAdmin) is exempt and may finalize their own. */
  submittedByEmail?: string | null;
  currentUserEmail?: string | null;
  /** This user may finalize their OWN submission (bypass the dual-approval lock). */
  isFinalizeAdmin?: boolean;
  approverName?: string | null;
  approvedAt?: string | null;
  propertyName: string;
  /** Property record id — used to validate camera GPS against the property. */
  propertyRecordId?: string;
  bedrooms: number;
  bathrooms: number;
  /** Property's square footage (from `square_footage` on the property object).
   *  Optional — shown in the header next to bed/bath if present. */
  squareFootage?: number | null;
  /** Months the last tenant occupied the home (from
   *  `last_tenant_time_in_home_months` on the property). Drives AI-review
   *  depreciation. null/absent → AI review defaults to 12. */
  lastTenantMonths?: number | null;
  /** Most-recent active listing price + date, shown in the header (same as the
   *  question templates). Optional. */
  listingPrice?: number | null;
  listingDate?: string | null;
  /** Final Checklist: air-filter qty/types (prefilled + written back) + septic
   *  fee (gates the conditional septic question), and the live filter-size
   *  dropdown options pulled from the HubSpot field. All optional. */
  propertyAirFiltersTotal?: number | null;
  propertyAirFiltersType1?: string | null;
  propertyAirFiltersType2?: string | null;
  propertyAirFiltersType3?: string | null;
  propertySepticFee?: number | null;
  filterSizeOptions?: string[];
  /** Current HubSpot status value, e.g. 'scheduled' | 'in_progress' |
   *  'pending_approval' | 'completed' | 'cancelled'. Controls which terminal
   *  button is shown at the bottom of the form:
   *    - scheduled/in_progress → "Submit for Approval" (flip to pending_approval)
   *    - pending_approval     → "Finalize & Generate PDFs"
   *    - completed            → form is read-only (controlled by `readOnly`)
   *  If omitted, defaults to behaving like in_progress. */
  inspectionStatus?: string;
  inspectionRecordId: string;
  inspectionExternalId: string;
  inspectionRegion: string;
  /**
   * Stored JSON section list (custom rename/delete/reorder/add by inspector).
   * Empty/null = use auto-derived defaults. See lib/sections.ts.
   */
  sectionListJson: string | null;
  pdfUrl?: string;
  readOnly?: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  onCancelInspection?: () => void;
}

// 16 sections after Phase 1 cleanup. Order requested by Hayden in v0.16.1:
//   - Bedroom/Bathroom interleaved (Bedroom 1 -> Bathroom 1 -> Bedroom 2 -> ...)
//   - Half Bath appended after the last regular bathroom if bathrooms has a .5
//   - Whole House added (new), placed before HVAC / Mechanicals
//   - Garage moved to after Basement
//   - Bonus Room moved to after the bedrooms/bathrooms block
//   - Laundry Room placed before Bonus Room
//
// The interleaving requires custom logic in expandSections() rather than a flat
// list, so BASE_SECTIONS here covers only the non-repeating sections AND a
// single placeholder for the bedroom/bathroom block.
// Section list, defaults, and ordering live in lib/sections.ts so RateCardForm
// and QuestionForm both stay in sync. PHOTO_EXEMPT is derived per-section via
// the SectionInstance.photoOptional flag.

// "Whole House" is a catch-all/miscellaneous bucket, not a real room — never
// require a section photo for it (in addition to the per-section photoOptional).
function sectionPhotoExempt(name: string): boolean {
  return /\bwhole\s*house\b/i.test((name || '').trim());
}

/** "{qty} {friendly unit}" for inline display, e.g. 3 EA -> "3 ea", 1448 SF ->
 *  "1,448 sq ft". Returns '' for invalid quantities. */
function friendlyQtyUnit(qty: number, meas: string): string {
  if (!isFinite(qty) || qty <= 0) return '';
  const n = qty.toLocaleString('en-US', { maximumFractionDigits: 2 });
  const u = (meas || '').trim().toUpperCase();
  const friendly = u === 'SF' ? 'sq ft' : u === 'LF' ? 'lin ft' : u === 'SY' ? 'sq yd'
    : u === 'EA' ? 'ea' : u === 'HR' ? 'hr' : (meas || '').trim().toLowerCase();
  return friendly ? `${n} ${friendly}` : n;
}

// A deterministic AI-review check: "the scope has NO line of this category
// anywhere." The inspector validates (Approve = none needed, or Decline → add).
function missingCategoryCheck(kind: 'paint' | 'cleaning'): AiAdjustment {
  const label = kind === 'paint' ? 'Paint' : 'Cleaning';
  return {
    id: `missing_${kind}`,
    type: 'add',
    sectionId: '',
    missingCategory: kind,
    title: `No ${label} Lines in This Scope`,
    rationale: `This scope has no ${label.toLowerCase()} line items in any room. Confirm none are needed for this turn, or add them.`,
    severity: 'medium',
  };
}

export function RateCardForm(props: RateCardFormProps) {
  const dialog = useAppDialog();
  const flashApi = useFlash();
  // Sections are now stateful — they may be customized (renamed, deleted,
  // reordered, or have additions). The initial value is taken from the prop
  // `sectionListJson` if set, else derived from bedrooms+bathrooms.
  const [sections, setSections] = useState<SectionInstance[]>(
    () => resolveSections(props.sectionListJson, props.bedrooms, props.bathrooms)
  );
  // Manage Sections modal open state
  const [showSectionsManager, setShowSectionsManager] = useState(false);
  // Header settings (gear) dropdown — houses Manage Sections + Refresh Pricing.
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  // Audit trail modal (who submitted/approved/reopened/cancelled, and when).
  const [showAuditTrail, setShowAuditTrail] = useState(false);
  // Keys of line rows whose edit modal is open — used to hide the floating mic
  // (it should never float over a modal/other screen when idle).
  const [openEditors, setOpenEditors] = useState<Set<string>>(new Set());
  const setEditorOpen = useCallback((key: string, open: boolean) => {
    setOpenEditors((prev) => {
      if (open === prev.has(key)) return prev;
      const next = new Set(prev);
      if (open) next.add(key); else next.delete(key);
      return next;
    });
  }, []);
  // Floating-mic visibility: the mic only lives on the bare form + camera. Over
  // any other overlay it hides UNLESS a conversation is actively engaged.
  const [voiceEngaged, setVoiceEngaged] = useState(false);
  const [cameraOverlayOpen, setCameraOverlayOpen] = useState(false);
  // Measured footer height, so the floating mic vertically centers on the
  // Save & Close / Submit row (exact regardless of device safe-area padding).
  const footerRef = useRef<HTMLDivElement | null>(null);
  const [footerH, setFooterH] = useState(60);
  // The bottom action row only (Save & Close / Submit), measured separately so
  // the centered voice mic stays centered on THAT row even when the AI-review
  // status bar adds height above it.
  const actionRowRef = useRef<HTMLDivElement | null>(null);
  const [actionRowH, setActionRowH] = useState(60);
  useEffect(() => {
    const el = footerRef.current;
    if (!el) return;
    const update = () => {
      setFooterH(el.offsetHeight || 60);
      setActionRowH(actionRowRef.current?.offsetHeight || el.offsetHeight || 60);
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (actionRowRef.current) ro.observe(actionRowRef.current);
    return () => ro.disconnect();
  }, []);
  // Photo lightbox (tap a photo to view/swipe/mark-up/tag/delete). Either a
  // room's section photos or a single line item's photos.
  type LightboxState =
    | { kind: 'section'; sectionId: string; index: number }
    | { kind: 'line'; sectionId: string; externalId: string; index: number }
    | { kind: 'after'; sectionId: string; externalId: string; index: number };
  const [lightbox, setLightbox] = useState<LightboxState | null>(null);

  // ----- Catalog + regions ---------------------------------------------
  const [catalog, setCatalog] = useState<RateCardLineItem[]>([]);
  const [regions, setRegions] = useState<RegionRate[]>([]);
  // O(1) code→item lookup, built once per catalog load. The catalog has ~1,000+
  // rows (and grows); resolving line items with catalog.find() inside the
  // per-render totals/breakdown loops was O(lines × catalog) on every keystroke.
  // Use this Map instead. Rebuilds automatically whenever `catalog` changes.
  const catalogByCode = useMemo(() => {
    const m = new Map<string, RateCardLineItem>();
    for (const c of catalog) m.set(c.lineItemCode, c);
    return m;
  }, [catalog]);
  // Fresh handle to the code→item map for callbacks that run outside the render
  // closure (notably the AI-review deterministic "missing category" checks). The
  // runAiReview callback does NOT list catalog in its deps, so without this it
  // could read the empty map captured before the catalog loaded — which made
  // every lookup miss and falsely flagged BOTH Paint and Cleaning as missing
  // even when those lines were present.
  const catalogByCodeRef = useRef(catalogByCode);
  useEffect(() => { catalogByCodeRef.current = catalogByCode; }, [catalogByCode]);
  // Fresh regions for callbacks that don't list `regions` in their deps (e.g.
  // runAiReview) — otherwise pricing computes as $0 against a stale empty array.
  const regionsRef = useRef(regions);
  useEffect(() => { regionsRef.current = regions; }, [regions]);
  const inspectionRegion = props.inspectionRegion || '';
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const [dataLoaded, setDataLoaded] = useState(false);

  // ----- Lines + photos in state ---------------------------------------
  // Internal Resolution after-photo requirement is active only once the
  // after_photo_urls property exists in HubSpot (migration run). The GET
  // response reports it; we gate the finalize block on it so it can't deadlock
  // before the migration (you couldn't save after-photos to satisfy it).
  const [afterPhotosEnabled, setAfterPhotosEnabled] = useState(false);
  // Internal Resolution "Complete Now / Complete Later" per line (device-local).
  // "later" defers the after-photo requirement at finalize.
  const [resolutionTimings, setResolutionTimings] = useState<Record<string, 'now' | 'later'>>({});
  const setLineTiming = useCallback((lineExternalId: string, v: 'now' | 'later') => {
    setResolutionTiming(props.inspectionRecordId, lineExternalId, v);
    setResolutionTimings((m) => ({ ...m, [lineExternalId]: v }));
  }, [props.inspectionRecordId]);
  const [linesBySection, setLinesBySection] = useState<Record<string, RateCardLineInput[]>>({});
  const [photosBySection, setPhotosBySection] = useState<Record<string, string[]>>({});
  // Live mirror of photosBySection so async save paths persist the LATEST merged
  // list (optimistic per-photo adds land in state) instead of a stale closure
  // snapshot captured when a long upload/camera session started.
  const photosBySectionRef = useRef<Record<string, string[]>>({});

  // HubSpot record IDs for upsert tracking. Updated after each successful save.
  // externalId -> HubSpot inspection_answer record id
  const [recordIdsByExternalId, setRecordIdsByExternalId] = useState<Record<string, string>>({});
  // sectionId -> HubSpot inspection_answer record id (for section_photo records)
  const [sectionPhotoRecordIds, setSectionPhotoRecordIds] = useState<Record<string, string>>({});

  // Offline outbox: number of saves queued for this inspection (waiting to sync)
  // and whether the browser currently reports being online.
  const [pendingSync, setPendingSync] = useState(0);
  const [pendingPhotos, setPendingPhotos] = useState(0);
  // True when queued items have stopped draining (no progress across ticks) so
  // the banner can offer Retry / Clear instead of an endless "Syncing…".
  const [syncStuck, setSyncStuck] = useState(false);
  // True while a flush/retry is actively running (drives the Retry button's
  // "Retrying…" feedback so it's clear something is happening).
  const [flushing, setFlushing] = useState(false);
  // Last sync failure reason, surfaced via the banner's "Details" for field troubleshooting.
  const [lastSyncError, setLastSyncError] = useState<string | null>(null);
  // Start high so the first tick can't falsely flag "stuck" before a sync round.
  const lastPendingRef = useRef(Number.POSITIVE_INFINITY);
  const [online, setOnline] = useState(true);
  // Device storage: photos/video queue in IndexedDB until they sync. Warn the
  // inspector before they run out of room (otherwise captures silently fail).
  const storage = useStorageQuota();
  // Tag error reports with the open inspection so field crashes are diagnosable.
  useEffect(() => { setErrorContext({ inspectionRecordId: props.inspectionRecordId }); }, [props.inspectionRecordId]);

  // Tracks whether existing data has been loaded so we don't trigger autosave
  // during the initial hydration.
  const [linesHydrated, setLinesHydrated] = useState(false);

  // Save status indicator (replaces the debounced autosave hook in v0.19.3).
  // Each line/photo save now fires immediately as the user makes the change;
  // this tracks the visible "Saving... / Saved / Error" badge.
  type SaveStatus =
    | { kind: 'idle' }
    | { kind: 'saving' }
    | { kind: 'saved'; at: number }
    | { kind: 'error'; message: string };
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'idle' });
  // Live status for the header badge: mirrors the prop but flips Scheduled →
  // In Progress the moment the first edit saves (the server bumps it too), so
  // the pill doesn't keep showing "Scheduled" after edits.
  const [liveStatus, setLiveStatus] = useState<string | undefined>(props.inspectionStatus);
  useEffect(() => { setLiveStatus(props.inspectionStatus); }, [props.inspectionStatus]);
  useEffect(() => {
    if ((saveStatus.kind === 'saving' || saveStatus.kind === 'saved') && liveStatus === 'scheduled') {
      setLiveStatus('in_progress');
    }
  }, [saveStatus, liveStatus]);
  /** When true, show the error-detail modal with the last save failure text.
   *  Click "⚠ Save failed — click for details" in the sticky header to open. */
  const [showSaveErrorDetail, setShowSaveErrorDetail] = useState(false);

  // When set, the section has a "pending new" row at the bottom that's currently
  // in edit mode (waiting to be filled out + saved). Only one pending new row
  // per section at a time; clicking + Add again while one is pending is a no-op.
  const [pendingNewBySection, setPendingNewBySection] = useState<Record<string, true>>({});
  // Bumped each time a fresh "new line" editor is opened in a section, so the
  // editor remounts clean (used in its React key) when chaining rows.
  const [newRowNonce, setNewRowNonce] = useState<Record<string, number>>({});

  // Mobile detection — drives the full-screen stacked line editor instead of
  // the inline table row, which is unusable on a phone.
  const [isMobile, setIsMobile] = useState(false);
  // Per-section collapse of the photo strip.
  const [photosCollapsed, setPhotosCollapsed] = useState<Record<string, boolean>>({});
  useEffect(() => {
    // Use the fit (stacked) line layout on narrow screens AND on short/landscape
    // phones — otherwise the wide multi-column table overflowed and forced a
    // horizontal scroll on the line-item cards in landscape.
    const mq = window.matchMedia('(max-width: 640px), (max-height: 540px)');
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  // Camera modal (for in-app capture). When non-null, captures append to this section.
  const [cameraSectionId, setCameraSectionId] = useState<string | null>(null);
  // AI Camera (Beta): when true, the section camera opens with the AI assist
  // layer on top (live call-outs while you talk + pan). Take button = false.
  const [aiCameraMode, setAiCameraMode] = useState(false);
  // AI camera warm-up: prime catalog embeddings + Haiku (same cold-start work the
  // mic button does) so the first spoken call-out is fast. The Beta button stays
  // disabled until this completes, exactly like the floating mic.
  // Seed from the session-level flag so the Beta button is usable immediately if
  // the home screen / mic already warmed the AI — no redundant "getting ready…".
  const [aiCamWarmed, setAiCamWarmed] = useState(() => isAiWarm());
  const aiCamWarmStartedRef = useRef(false);
  useEffect(() => {
    if (aiCamWarmStartedRef.current || !online) return;
    if (props.readOnly || props.templateType !== 'pm_scope_rate_card') return;
    aiCamWarmStartedRef.current = true;
    (async () => {
      await warmAi(); // de-duped; no-op unless cold/stale
      setAiCamWarmed(true); // set even on failure so the button can't get stuck
    })();
  }, [online, props.readOnly, props.templateType]);
  // One-time border flash the moment warm-up flips the button from plain camera
  // ("Take") to the AI-hybrid icon — only on a genuine false→true transition
  // (not when it was already warm from a prior screen).
  const [warmFlash, setWarmFlash] = useState(false);
  const prevWarmRef = useRef(aiCamWarmed);
  useEffect(() => {
    if (!prevWarmRef.current && aiCamWarmed) {
      setWarmFlash(true);
      const t = setTimeout(() => setWarmFlash(false), 1300);
      prevWarmRef.current = aiCamWarmed;
      return () => clearTimeout(t);
    }
    prevWarmRef.current = aiCamWarmed;
  }, [aiCamWarmed]);
  // ----- AI scope review -----
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiStreaming, setAiStreaming] = useState(false);
  const [aiApplying, setAiApplying] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  // True only after the AI Review has been genuinely attempted (with auto-retry)
  // and ultimately failed because of connectivity — NOT a server/content error.
  // This is what unlocks the "submit without review" escape hatch, so the bypass
  // is only ever offered after a valiant effort to actually run the check.
  const [aiConnectivityFailed, setAiConnectivityFailed] = useState(false);
  const [aiSummary, setAiSummary] = useState('');
  const [aiAdjustments, setAiAdjustments] = useState<AiAdjustment[]>([]);
  // Approve/decline decisions, persisted so they survive a reload mid-review.
  const [aiDecisions, setAiDecisions] = useState<Record<string, 'approve' | 'decline'>>({});
  // The scope hash that last passed review (null = never reviewed this scope).
  // Persisted per inspection so it survives a reload (see lib/aiReview).
  const [reviewedHash, setReviewedHash] = useState<string | null>(null);
  // ----- Final Checklist (bottom-of-form questionnaire) -----
  const [fcAnswers, setFcAnswers] = useState<FcAnswers>({});
  // Outer collapse of the Final Checklist bubble — lifted so the form's global
  // Expand/Collapse-all reaches it. Defaults open.
  const [fcOpen, setFcOpen] = useState(true);
  const fcRecordIdRef = useRef<string | undefined>(undefined);
  const fcSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fcAfTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Upload progress (per section)
  const [uploadingSection, setUploadingSection] = useState<{
    sectionId: string;
    current: number;
    total: number;
  } | null>(null);

  // ----- Finalize (generate PDFs) state ---------------------------------
  // While finalize is running we lock the form so the inspector can't change
  // anything mid-render. The result modal stays open until they hit Done; on
  // Done we navigate away and the parent re-fetches.
  type FinalizeResult = {
    generatedAt: string;
    pdfs: {
      master: { name: string; url: string };
      chargeback: { name: string; url: string } | null;
      chargebackXlsx: { name: string; url: string } | null;
      vendors: Array<{ vendor: string; name: string; url: string }>;
    };
    email: {
      sent: boolean;
      reason?: string;
      message?: string;
      recipients?: { to: string[]; cc: string[] };
    } | null;
    maintenanceTicket?: {
      ok: boolean;
      configured: boolean;
      ticketId?: number;
      url?: string | null;
      error?: string;
    } | null;
    totals: { vendor: number; client: number; tenant: number; lineCount: number };
  };
  const [finalizing, setFinalizing] = useState(false);
  // "Submit for Approval" in-flight state (the finalize path uses `finalizing`).
  // The ref is a synchronous guard so a fast double-tap can't fire two
  // submit/finalize POSTs in the same frame before the disabled state renders.
  const [submitting, setSubmitting] = useState(false);
  const submitGuardRef = useRef(false);
  const [finalizeResult, setFinalizeResult] = useState<FinalizeResult | null>(null);

  // Ref to the finalize handler so the auto-resume effect (below) can call the
  // latest version without re-running when the handler identity changes.
  const finalizeHandlerRef = useRef<null | (() => Promise<void>)>(null);
  // Guard so we only auto-resume once even if the effect re-runs.
  const autoFinalizeTriggered = useRef(false);

  // Auto-resume finalize after returning from the Gmail OAuth flow. The
  // callback redirects to /inspection/{id}?finalizeNow=1 once the user has
  // connected their account. We strip the param from the URL so a refresh
  // doesn't re-trigger, then kick the same finalize handler the button uses.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (autoFinalizeTriggered.current) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('finalizeNow') === '1' && props.inspectionStatus === 'pending_approval') {
      autoFinalizeTriggered.current = true;
      // Clean the URL (remove the query param) without a navigation.
      params.delete('finalizeNow');
      const clean = window.location.pathname + (params.toString() ? `?${params}` : '');
      window.history.replaceState({}, '', clean);
      // Defer a tick so the component is fully mounted + handler ref is set.
      setTimeout(() => { finalizeHandlerRef.current?.(); }, 50);
    }
  }, [props.inspectionStatus]);

  // Browser supports in-app camera?
  const hasMediaDevices = typeof window !== 'undefined' &&
    !!window.navigator?.mediaDevices?.getUserMedia;

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Totals-header drill-down: tap the totals to reveal a by-category breakdown,
  // then tap a category to reveal its individual line items — all in the same
  // table, with the $ figures shown at every level.
  const [overviewExpanded, setOverviewExpanded] = useState(false);
  const [expandedCats, setExpandedCats] = useState<Record<string, boolean>>({});

  // The room the floating voice assistant is currently working on. Changing it
  // (manually or by voice) expands + scrolls to that section.
  const [currentSectionId, setCurrentSectionId] = useState<string>('');
  // The bottom spacer is small by default (no wasted white space). It expands to
  // ~a viewport only while we're scrolling to the LAST section, so a line added
  // there can still rise to the top; it collapses again when we move elsewhere.
  const [expandTailSpace, setExpandTailSpace] = useState(false);
  // sectionId -> the section's DOM node, for scroll-into-view on room change.
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});

  // Default the assistant's current room to the first section once loaded.
  useEffect(() => {
    if (!currentSectionId && sections.length > 0) setCurrentSectionId(sections[0].id);
  }, [sections, currentSectionId]);

  // The active room (where the assistant is adding line items) is always kept
  // expanded so the inspector can see the lines landing.
  useEffect(() => {
    if (currentSectionId) setExpanded((e) => (e[currentSectionId] ? e : { ...e, [currentSectionId]: true }));
  }, [currentSectionId]);

  // Height of the sticky totals header (measured live so it stays correct as
  // the header grows/shrinks), plus a little breathing room. Used to scroll a
  // section to just below the header rather than under it.
  const stickyOffset = () => {
    const h = (typeof document !== 'undefined'
      ? document.getElementById('sticky-totals-header')?.getBoundingClientRect().height
      : 0) || 0;
    return Math.round(h) + 12;
  };

  // Switch the assistant's working room: expand it and scroll it into view.
  const navigateToSection = useCallback((sectionId: string) => {
    setCurrentSectionId(sectionId);
    setExpanded((e) => ({ ...e, [sectionId]: true }));
    // Only grow the tail spacer when heading to the very last section.
    setExpandTailSpace(sections.length > 1 && sectionId === sections[sections.length - 1]?.id);
    // Defer so the expand (and any spacer growth) has applied before we scroll.
    setTimeout(() => {
      const el = sectionRefs.current[sectionId];
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const top = window.scrollY + rect.top - stickyOffset();
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }, 60);
  }, [sections]);

  // After a voice add/edit, bring the affected LINE (preferred) or section up
  // to just below the sticky header so the change is easy to see. Same behavior
  // on desktop and mobile. The tall bottom spacer guarantees room to scroll even
  // the last line to the top.
  const revealSection = useCallback((sectionId: string, lineExternalId?: string) => {
    setExpanded((e) => ({ ...e, [sectionId]: true }));
    // Grow the tail spacer only when the changed line is in the last section, so
    // it can rise to the top; otherwise keep the spacer small.
    setExpandTailSpace(sections.length > 1 && sectionId === sections[sections.length - 1]?.id);
    setTimeout(() => {
      // Prefer the specific line element so the changed card lands at the top.
      let el: Element | null = null;
      if (lineExternalId && typeof document !== 'undefined') {
        el = document.querySelector(`[data-line-id="${CSS.escape(lineExternalId)}"]`);
      }
      if (!el) el = sectionRefs.current[sectionId] || null;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const top = window.scrollY + rect.top - stickyOffset();
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }, 120);
  }, [sections]);
  // form mounts, so the FIRST "add line item" click is instant instead of
  // waiting on the (large) catalog fetch. Fire-and-forget; ensureDataLoaded
  // guards against double-loading, and the hydration effect below will reuse
  // whatever this has loaded. Skipped in read-only (completed) inspections.
  useEffect(() => {
    if (props.readOnly) return;
    void ensureDataLoaded();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch catalog + regions with a hard timeout so a stalled request on weak
  // service fails fast (and the cache-first path below can take over) instead of
  // spinning forever. `refresh` bypasses the server-side 60-min cache.
  async function fetchRateCardData(refresh: boolean, timeoutMs: number): Promise<{ catalog: RateCardLineItem[]; regions: RegionRate[] }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const qs = refresh ? '?refresh=1' : '';
      const [catRes, regRes] = await Promise.all([
        fetch(`/api/rate-card/catalog${qs}`, { signal: ctrl.signal }),
        fetch(`/api/rate-card/regions${qs}`, { signal: ctrl.signal }),
      ]);
      const catData = await catRes.json();
      const regData = await regRes.json();
      if (!catRes.ok) throw new Error(catData.error || `Catalog HTTP ${catRes.status}`);
      if (!regRes.ok) throw new Error(regData.error || `Regions HTTP ${regRes.status}`);
      return { catalog: catData.items || [], regions: regData.regions || [] };
    } finally {
      clearTimeout(timer);
    }
  }

  // Quietly refresh from the network and update both state + the local cache.
  // Never surfaces an error — it's a background freshen, the (cached) data the
  // inspector is already using stays valid if it fails.
  async function revalidateRateCardInBackground(): Promise<void> {
    try {
      const { catalog, regions } = await fetchRateCardData(false, 20000);
      if (catalog.length === 0) return;
      setCatalog(catalog);
      setRegions(regions);
      saveCachedRateCard(catalog, regions);
    } catch {
      /* offline / weak signal — keep the cached catalog */
    }
  }

  async function ensureDataLoaded(): Promise<boolean> {
    if (dataLoaded || dataLoading) return dataLoaded;
    setDataLoading(true);
    setDataError(null);

    // Cache-first: the catalog is identical for every inspection, so if we have
    // it cached locally use it INSTANTLY — the manual "add line item" search then
    // works with zero network, fully offline. We revalidate in the background.
    const cached = loadCachedRateCard();
    if (cached) {
      setCatalog(cached.catalog);
      setRegions(cached.regions);
      setDataLoaded(true);
      setDataLoading(false);
      void revalidateRateCardInBackground();
      return true;
    }

    // No cache (first ever load): fetch with a timeout and cache for next time.
    try {
      const { catalog, regions } = await fetchRateCardData(false, 25000);
      setCatalog(catalog);
      setRegions(regions);
      setDataLoaded(true);
      saveCachedRateCard(catalog, regions);
      return true;
    } catch (e: any) {
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      setDataError(offline
        ? 'You appear to be offline. The line-item catalog hasn’t been saved to this device yet — connect once to load it, then it works offline.'
        : (e?.name === 'AbortError' ? 'Loading the line-item catalog timed out (weak signal). Pull to retry once you have signal.' : String(e?.message || e)));
      return false;
    } finally {
      setDataLoading(false);
    }
  }

  /**
   * Force-refresh the rate card catalog and region rates from HubSpot,
   * bypassing the server-side 60-minute cache. Used when an admin has
   * edited line item pricing or regional rates in HubSpot and wants the
   * change to reflect in the app immediately rather than waiting for the
   * cache TTL to expire.
   *
   * Note: this DOES NOT recalculate existing saved lines — their stored
   * vendor/client/tenant totals were computed from the rates that were
   * current at save time. To refresh those, the inspector would need to
   * open and re-save each affected line.
   */
  async function refreshCatalogFromHubSpot(): Promise<void> {
    setDataLoading(true);
    setDataError(null);
    try {
      const { catalog, regions } = await fetchRateCardData(true, 30000);
      setCatalog(catalog);
      setRegions(regions);
      setDataLoaded(true);
      saveCachedRateCard(catalog, regions);
      void dialog.alert(`Rate card refreshed: ${catalog.length} line items, ${regions.length} regions loaded from HubSpot.`);
    } catch (e: any) {
      setDataError(String(e?.message || e));
      void dialog.alert(`Refresh failed: ${e?.message || e}`);
    } finally {
      setDataLoading(false);
    }
  }

  // ----- Load saved lines + photos on mount ---------------------------
  // Triggered once per inspection. Fetches existing inspection_answer records,
  // partitions by answer_type, and hydrates linesBySection + photosBySection.
  // After this completes, linesHydrated=true and autosave is enabled.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/inspections/${props.inspectionRecordId}`);
        if (!r.ok) {
          console.warn(`[RateCardForm] could not load existing answers: HTTP ${r.status}`);
          if (!cancelled) setLinesHydrated(true);   // unblock autosave anyway
          return;
        }
        const data = await r.json();
        if (cancelled) return;

        setAfterPhotosEnabled(data.afterPhotosEnabled === true);
        // Restore per-line Internal Resolution timing choices: device-local
        // first, then overlay the server-persisted map (set at submit) so the
        // approver — on any device — sees the same "Complete Later" choices.
        {
          let merged: Record<string, 'now' | 'later'> = { ...getResolutionTimings(props.inspectionRecordId) };
          try {
            const serverMap = JSON.parse(data.inspection?.resolutionTimingJson || '{}');
            if (serverMap && typeof serverMap === 'object') merged = { ...merged, ...serverMap };
          } catch { /* ignore malformed */ }
          setResolutionTimings(merged);
        }
        const answers = data.answers || [];

        // Build a lookup: "label||location" -> sectionId, PLUS a fallback by
        // `location` alone. A section rename changes its label, but the saved
        // answers still carry the OLD label — so an exact label match would
        // orphan (hide) the items after a rename. `location` is immutable across
        // a rename (e.g. "Bathroom 1"), so it recovers the items.
        const sectionLookup: Record<string, string> = {};
        const sectionByLocation: Record<string, string> = {};
        for (const s of sections) {
          sectionLookup[`${s.label}||${s.location}`] = s.id;
          if (s.location) {
            // Only map a location that's unique to one section (repeating rooms);
            // ambiguous/blank locations fall through to the label match.
            sectionByLocation[s.location] = sectionByLocation[s.location] === undefined ? s.id : '';
          }
        }
        const resolveSectionId = (section: string, location: string): string => {
          const exact = sectionLookup[`${section}||${location}`];
          if (exact) return exact;
          if (location && sectionByLocation[location]) return sectionByLocation[location];
          return section;
        };

        const linesAcc: Record<string, RateCardLineInput[]> = {};
        const photosAcc: Record<string, string[]> = {};
        const lineRecordIds: Record<string, string> = {};
        const photoRecordIds: Record<string, string> = {};
        let fcInit: FcAnswers | null = null;
        let fcRid: string | undefined;

        for (const ans of answers) {
          if (ans.answerType === 'rate_card_line' && ans.rateCardLine) {
            const rc = ans.rateCardLine;
            const sectionId = resolveSectionId(ans.section, ans.location);
            // rc.customLaborFullDescription is whatever was stored in answer_value
            // — the catalog subtext/short description (default) or an inspector
            // override. Treat it as an override only if it differs from BOTH the
            // short description and the preferred catalog description (subtext).
            const catalogItem = catalogByCode.get(rc.lineItemCode);
            const storedDesc = rc.customLaborFullDescription || '';
            const catalogShort = catalogItem?.laborShortDescription || '';
            const catalogPreferred = (catalogItem?.laborSubtext && catalogItem.laborSubtext.trim())
              || catalogItem?.laborFullDescription || '';
            const customDesc = storedDesc && storedDesc !== catalogShort && storedDesc !== catalogPreferred
              ? storedDesc
              : undefined;
            const line: RateCardLineInput = {
              externalId: ans.answerIdExternal,
              section: ans.section,
              location: ans.location,
              lineItemCode: rc.lineItemCode,
              quantity: rc.quantityDecimal,
              tenantBillBackPercent: rc.tenantBillBackPercent,
              assignedTo: ans.assignedTo,
              note: ans.note,
              customLaborRate: rc.customLaborRate,
              customAdjustedMaterialCost: rc.customAdjustedMaterialCost,
              customVendorCost: rc.customVendorCost,
              customLaborFullDescription: customDesc,
              photoUrls: ans.photoUrls || [],
              afterPhotoUrls: ans.afterPhotoUrls || [],
            };
            if (!linesAcc[sectionId]) linesAcc[sectionId] = [];
            linesAcc[sectionId].push(line);
            lineRecordIds[line.externalId] = ans.recordId;
          } else if (ans.answerType === 'section_photo') {
            const sectionId = resolveSectionId(ans.section, ans.location);
            photosAcc[sectionId] = ans.photoUrls || [];
            photoRecordIds[sectionId] = ans.recordId;
          } else if (ans.answerType === 'qa' && ans.questionIdExternal === 'fc__all') {
            // Final Checklist is persisted as a single qa answer (JSON in note).
            fcRid = ans.recordId;
            try { fcInit = ans.note ? JSON.parse(ans.note) : null; } catch { fcInit = null; }
          }
        }

        // If we found existing lines, ensure the catalog is loaded too so the
        // form can render them (the catalog is needed to look up line item
        // details like description, unit, isBidItem).
        if (Object.keys(linesAcc).length > 0) {
          await ensureDataLoaded();
        }

        if (cancelled) return;
        setLinesBySection(linesAcc);
        setPhotosBySection(photosAcc);
        setRecordIdsByExternalId(lineRecordIds);
        setSectionPhotoRecordIds(photoRecordIds);
        if (fcInit) setFcAnswers(fcInit);
        if (fcRid) fcRecordIdRef.current = fcRid;
        // Auto-expand sections that have content so the user can see their work
        const expandedInit: Record<string, boolean> = {};
        for (const sid of Object.keys(linesAcc)) expandedInit[sid] = true;
        for (const sid of Object.keys(photosAcc)) expandedInit[sid] = true;
        setExpanded((cur) => ({ ...expandedInit, ...cur }));
        setLinesHydrated(true);
      } catch (e: any) {
        console.error('[RateCardForm] load failed:', e);
        if (!cancelled) setLinesHydrated(true);
      }
    })();
    return () => { cancelled = true; };
    // sections is derived from props.bedrooms/bathrooms; safe to include
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.inspectionRecordId]);

  // Hydration runs before the (large) catalog finishes loading, so a stored
  // description that simply equals the catalog's text gets mis-flagged as a
  // custom override (and then stops tracking catalog edits). Once the catalog
  // is available, reconcile once: clear customLaborFullDescription on lines
  // where it matches the catalog short/preferred text — leaving only genuine
  // inspector overrides.
  const descReconciledRef = useRef(false);
  useEffect(() => {
    if (descReconciledRef.current) return;
    if (!linesHydrated || catalog.length === 0) return;
    descReconciledRef.current = true;
    setLinesBySection((bySection) => {
      let changed = false;
      const next: Record<string, RateCardLineInput[]> = {};
      for (const [sid, lines] of Object.entries(bySection)) {
        next[sid] = lines.map((l) => {
          if (!l.customLaborFullDescription) return l;
          const item = catalogByCode.get(l.lineItemCode);
          if (!item) return l;
          const short = item.laborShortDescription || '';
          const preferred = (item.laborSubtext && item.laborSubtext.trim()) || item.laborFullDescription || '';
          if (l.customLaborFullDescription === short || l.customLaborFullDescription === preferred) {
            changed = true;
            const { customLaborFullDescription, ...rest } = l;
            return rest as RateCardLineInput;
          }
          return l;
        });
      }
      return changed ? next : bySection;
    });
  }, [linesHydrated, catalog]);

  // ----- Offline outbox: replay queued saves when back online ----------
  const refreshPending = useCallback(() => {
    setPendingSync(outboxCountFor(props.inspectionRecordId));
    void countQueuedPhotos(props.inspectionRecordId).then(setPendingPhotos).catch(() => {});
  }, [props.inspectionRecordId]);

  // Escape hatch: discard the queued items that can't sync so the inspector
  // isn't stuck behind a wedged entry. Confirmed, since it drops unsynced work.
  const clearStuckQueue = useCallback(async () => {
    const ok = await dialog.confirm(
      'Discard the changes that haven’t synced?\n\nThis removes the queued items stuck on this device that can’t upload. Anything already saved to the server is unaffected. This can’t be undone.',
      { confirmLabel: 'Discard queued', cancelLabel: 'Keep trying' }
    );
    if (!ok) return;
    try { outboxClearFor(props.inspectionRecordId); } catch { /* noop */ }
    await clearQueuedPhotos(props.inspectionRecordId).catch(() => {});
    setSyncStuck(false);
    lastPendingRef.current = 0;
    refreshPending();
  }, [props.inspectionRecordId, refreshPending, dialog]);

  // Live handle to savePhotosForSection so the memoized flusher always calls
  // the latest closure (current sectionPhotoRecordIds / sections), not a stale one.
  const savePhotosRef = useRef<(sectionId: string, urls: string[]) => Promise<void>>(async () => {});
  savePhotosRef.current = savePhotosForSection;

  const runFlush = useCallback(async () => {
    setFlushing(true);
    try {
    const outboxRes = await flushOutbox((entry, data) => {
      // Stitch results back so the in-memory state stays correct without a reload.
      if (entry.kind === 'line') {
        const result = data?.results?.[0];
        if (result?.recordId && result?.answerIdExternal) {
          setRecordIdsByExternalId((cur) => ({ ...cur, [result.answerIdExternal]: result.recordId }));
        }
      } else if (entry.kind === 'sectionList' && entry.body?.section_list_json) {
        lastSavedSectionJsonRef.current = entry.body.section_list_json;
      } else if (entry.kind === 'sectionPhoto' && entry.meta?.sectionId) {
        const rid = data?.results?.[0]?.recordId;
        if (rid) setSectionPhotoRecordIds((cur) => ({ ...cur, [entry.meta!.sectionId as string]: rid }));
      }
    });

    // Upload queued offline photos/videos. Accumulate the URL swaps (draft -> real,
    // and for annotations the replaced original -> real) and apply them ONCE after
    // the loop, computing the new lists from the committed refs (reliable) rather
    // than reading state straight after setState (which hasn't applied yet).
    const sectionUrlMap = new Map<string, string>();   // url-to-replace -> real url (in section strips)
    const lineUrlMap = new Map<string, string>();      // url-to-replace -> real url (on line photos)
    const fcUrlMap = new Map<string, string>();        // url-to-replace -> real url (in the Final Checklist)
    const photoRes = await flushQueuedPhotos(props.inspectionRecordId, ({ oldUrl, newUrl, replacesUrl, lineExternalId, sectionId }) => {
      if (sectionId === FC_PHOTO_SECTION) {
        if (oldUrl) fcUrlMap.set(oldUrl, newUrl);
        if (replacesUrl) fcUrlMap.set(replacesUrl, newUrl);
        return;
      }
      if (lineExternalId) {
        // Line-photo annotation: the draft (oldUrl) and the original (replacesUrl)
        // both map to the real URL on that line.
        if (oldUrl) lineUrlMap.set(oldUrl, newUrl);
        if (replacesUrl) lineUrlMap.set(replacesUrl, newUrl);
      } else {
        if (oldUrl) sectionUrlMap.set(oldUrl, newUrl);
        // Section-photo annotation: keep any line tagged with the original in sync.
        if (replacesUrl) lineUrlMap.set(replacesUrl, newUrl);
      }
    }).catch(() => ({ synced: 0 } as any));

    if (sectionUrlMap.size > 0) {
      const cur = photosBySectionRef.current;
      const nextPhotos: Record<string, string[]> = { ...cur };
      const touched = new Set<string>();
      for (const [sid, urls] of Object.entries(cur)) {
        let changed = false;
        const swapped = urls.map((u) => { const real = sectionUrlMap.get(u); if (real) { changed = true; touched.add(sid); return real; } return u; });
        if (changed) nextPhotos[sid] = swapped;
      }
      if (touched.size > 0) {
        setPhotosBySection(nextPhotos);
        for (const sid of touched) {
          void savePhotosRef.current(sid, (nextPhotos[sid] || []).filter((u) => !u.startsWith('blob:')));
        }
      }
    }

    if (lineUrlMap.size > 0) {
      const cur = linesBySectionRef.current;
      const toPersist: { sectionId: string; line: RateCardLineInput }[] = [];
      const nextLines: Record<string, RateCardLineInput[]> = { ...cur };
      for (const [sid, lines] of Object.entries(cur)) {
        let sectionChanged = false;
        const updatedLines = lines.map((l) => {
          const photos = l.photoUrls || [];
          let lineChanged = false;
          const swapped = photos.map((u) => { const real = lineUrlMap.get(u); if (real) { lineChanged = true; return real; } return u; });
          if (!lineChanged) return l;
          sectionChanged = true;
          const updated = { ...l, photoUrls: swapped };
          toPersist.push({ sectionId: sid, line: updated });
          return updated;
        });
        if (sectionChanged) nextLines[sid] = updatedLines;
      }
      if (toPersist.length > 0) {
        setLinesBySection(nextLines);
        for (const u of toPersist) void handleSaveLineForSection(u.sectionId, u.line);
      }
    }

    if (fcUrlMap.size > 0) {
      // Swap the Final Checklist's draft (blob:) photo URLs for the real ones,
      // then re-save the checklist JSON (now with real URLs).
      setFcAnswers((prev) => {
        let changed = false;
        const swap = (arr?: string[]) => (arr || []).map((u) => { const real = fcUrlMap.get(u); if (real) { changed = true; return real; } return u; });
        const next: FcAnswers = {};
        for (const [qid, ans] of Object.entries(prev)) {
          const n: FcAnswerState = { ...ans };
          if (ans.photoUrls) n.photoUrls = swap(ans.photoUrls);
          if (ans.stickerPhotos) n.stickerPhotos = Object.fromEntries(Object.entries(ans.stickerPhotos).map(([k, v]) => [k, swap(v)]));
          next[qid] = n;
        }
        if (changed) doSaveFinalChecklist(next);
        return changed ? next : prev;
      });
    }

    refreshPending();
    if (outboxRes.synced > 0 || (photoRes && photoRes.synced > 0)) setSaveStatus({ kind: 'saved', at: Date.now() });
    // Capture the last failure reason for the banner's "Details"; clear it once
    // everything has drained.
    const stillPending = (outboxRes.remaining || 0) > 0 || (photoRes && (photoRes as any).remaining > 0);
    const err = outboxRes.lastError || (photoRes && (photoRes as any).lastError) || null;
    setLastSyncError(stillPending ? (err || null) : null);
    // Sync telemetry: surface work that isn't draining (or was permanently
    // dropped after exhausting retries) in the "stuck work" admin view.
    reportSyncOutcome({
      inspectionId: props.inspectionRecordId,
      outbox: { synced: outboxRes.synced, remaining: outboxRes.remaining, failedPermanently: (outboxRes as any).failedPermanently },
      photos: photoRes ? { synced: (photoRes as any).synced, remaining: (photoRes as any).remaining, failedPermanently: (photoRes as any).failedPermanently } : undefined,
      lastError: err,
    });
    } finally {
      setFlushing(false);
    }
  }, [refreshPending, props.inspectionRecordId]);

  useEffect(() => {
    if (typeof navigator !== 'undefined') setOnline(navigator.onLine !== false);
    refreshPending();
    const onOnline = () => { setOnline(true); void runFlush(); };
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    // The service worker's Background Sync asks the open tab to run the full
    // upload+attach flow (it has the form context the SW lacks).
    const onSwMessage = (e: MessageEvent) => { if (e.data?.type === 'resiwalk-flush') void runFlush(); };
    navigator.serviceWorker?.addEventListener?.('message', onSwMessage);
    // Periodic retry + reconcile while anything is queued (covers flaky signal
    // where 'online' never fires, AND queued PHOTOS — not just the outbox — so
    // the "Syncing…" banner can't get stuck after the queue has actually
    // drained or after a background-sync upload.
    const iv = setInterval(() => {
      const outbox = outboxCountFor(props.inspectionRecordId);
      void countQueuedPhotos(props.inspectionRecordId).then((photos) => {
        // Reconcile the displayed counts (clears a stale banner).
        setPendingSync(outbox);
        setPendingPhotos(photos);
        const total = outbox + photos;
        const onlineNow = typeof navigator === 'undefined' || navigator.onLine !== false;
        // "Stuck" = still pending and not shrinking since the last tick while
        // online (the flush isn't making progress). Surfaces Retry/Clear.
        setSyncStuck(total > 0 && onlineNow && total >= lastPendingRef.current);
        lastPendingRef.current = total;
        if (total > 0 && onlineNow) void runFlush();
      }).catch(() => {});
    }, 15000);
    void runFlush(); // attempt anything left from a previous session
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      navigator.serviceWorker?.removeEventListener?.('message', onSwMessage);
      clearInterval(iv);
    };
  }, [runFlush, refreshPending, props.inspectionRecordId]);

  // After hydration, re-show any line saves still queued offline (created in a
  // prior session/refresh while offline) so the inspector's work isn't lost
  // from view before it syncs.
  const outboxMergedRef = useRef(false);
  useEffect(() => {
    if (outboxMergedRef.current || !linesHydrated) return;
    outboxMergedRef.current = true;
    const pending = outboxEntriesFor(props.inspectionRecordId)
      .filter((e) => e.kind === 'line' && e.meta?.line && e.meta?.sectionId);
    if (pending.length === 0) return;
    setLinesBySection((bySection) => {
      const next = { ...bySection };
      for (const e of pending) {
        const sid = e.meta!.sectionId as string;
        const line = e.meta!.line as RateCardLineInput;
        const arr = next[sid] ? [...next[sid]] : [];
        if (!arr.some((l) => l.externalId === line.externalId)) { arr.push(line); next[sid] = arr; }
      }
      return next;
    });
  }, [linesHydrated, props.inspectionRecordId]);

  // Re-show photos still queued offline (drafts from a prior session) so the
  // inspector's captures aren't lost from view before they upload.
  const photoMergedRef = useRef(false);
  useEffect(() => {
    if (photoMergedRef.current || !linesHydrated) return;
    photoMergedRef.current = true;
    void rehydrateQueuedPhotos(props.inspectionRecordId).then((drafts) => {
      if (drafts.length === 0) return;
      // Section drafts: append new captures, or swap the replaced original for
      // an annotation draft. Line-photo annotation drafts are merged into the
      // line instead of the section strip.
      const fcDrafts = drafts.filter((d) => d.sectionId === FC_PHOTO_SECTION);
      const sectionDrafts = drafts.filter((d) => d.sectionId !== FC_PHOTO_SECTION && !d.lineExternalId);
      const lineDrafts = drafts.filter((d) => d.sectionId !== FC_PHOTO_SECTION && d.lineExternalId);
      if (fcDrafts.length > 0) {
        // Re-show offline Final Checklist photos in their field (camKey = "qid:photoKey").
        setFcAnswers((m) => {
          const next = { ...m };
          for (const d of fcDrafts) {
            const [qid, key] = (d.lineExternalId || '').split(':');
            if (!qid || !key) continue;
            const ans = { ...(next[qid] || {}) };
            if (key === 'photo') {
              const arr = [...(ans.photoUrls || [])];
              if (!arr.includes(d.url)) arr.push(d.url);
              ans.photoUrls = arr;
            } else {
              const sp = { ...(ans.stickerPhotos || {}) };
              const arr = [...(sp[key] || [])];
              if (!arr.includes(d.url)) arr.push(d.url);
              sp[key] = arr; ans.stickerPhotos = sp;
            }
            next[qid] = ans;
          }
          return next;
        });
      }
      if (sectionDrafts.length > 0) {
        setPhotosBySection((m) => {
          const next = { ...m };
          for (const d of sectionDrafts) {
            const arr = next[d.sectionId] ? [...next[d.sectionId]] : [];
            if (d.replacesUrl && arr.includes(d.replacesUrl)) {
              next[d.sectionId] = arr.map((u) => (u === d.replacesUrl ? d.url : u));
            } else if (!arr.includes(d.url)) {
              arr.push(d.url); next[d.sectionId] = arr;
            }
          }
          return next;
        });
      }
      if (lineDrafts.length > 0) {
        setLinesBySection((m) => {
          const next = { ...m };
          for (const d of lineDrafts) {
            const lines = next[d.sectionId];
            if (!lines) continue;
            next[d.sectionId] = lines.map((l) => {
              if (l.externalId !== d.lineExternalId) return l;
              const photos = l.photoUrls || [];
              if (d.replacesUrl && photos.includes(d.replacesUrl)) {
                return { ...l, photoUrls: photos.map((u) => (u === d.replacesUrl ? d.url : u)) };
              }
              return l;
            });
          }
          return next;
        });
      }
      setPendingPhotos((n) => Math.max(n, drafts.length));
    }).catch(() => {});
  }, [linesHydrated, props.inspectionRecordId]);

  /**
   * Used by Save & Close / Submit / Cancel Inspection to ensure any open
   * inline edits get committed (pushing their state into linesBySection,
   * which triggers an immediate save inside handleSaveLineForSection) BEFORE
   * we navigate. Then we wait for any in-flight save POST to complete.
   *
   * The 'ratecard:commit-all' event tells every open EditableLineRow to run
   * its commit path. That immediately fires handleSaveLineForSection, which
   * issues a POST. We then poll briefly for saveStatus !== 'saving'.
   */
  const saveInFlightRef = useRef(0);
  // Serializes line-save POSTs. Voice can emit several proposals in one breath
  // ("clean the carpet, paint one wall, fix nail holes" → 3 lines); firing
  // those POSTs concurrently let HubSpot drop/reject some writes (each also
  // bumps inspection status + touches the record), so lines that the UI showed
  // as "Added" vanished on reload. Chaining them guarantees one-at-a-time,
  // ordered persistence.
  useEffect(() => { photosBySectionRef.current = photosBySection; }, [photosBySection]);
  // Live mirror of linesBySection so the offline flusher can read current line
  // photos when persisting a synced annotation replacement.
  const linesBySectionRef = useRef<Record<string, RateCardLineInput[]>>({});
  useEffect(() => { linesBySectionRef.current = linesBySection; }, [linesBySection]);
  // Live mirror of the externalId→HubSpot recordId map. The AI-apply runs in a
  // memoized callback whose closure would otherwise capture a STALE (empty) map,
  // sending edits without a recordId → HubSpot tries to CREATE and collides on
  // the unique answer_id_external (lost edits). Reading the ref keeps it current.
  const recordIdsByExternalIdRef = useRef<Record<string, string>>({});
  useEffect(() => { recordIdsByExternalIdRef.current = recordIdsByExternalId; }, [recordIdsByExternalId]);
  // Last section-layout JSON we know the server has, for optimistic-concurrency
  // (compare-and-swap) on section edits so two tabs/devices don't clobber each
  // other's room changes.
  const lastSavedSectionJsonRef = useRef<string>(props.sectionListJson || '');
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  function enqueueSave<T>(work: () => Promise<T>): Promise<T> {
    const next = saveChainRef.current.catch(() => { /* isolate prior failures */ }).then(work);
    saveChainRef.current = next.then(() => { /* drop value */ }, () => { /* keep chain alive */ });
    return next;
  }
  async function commitAndWait(): Promise<void> {
    window.dispatchEvent(new CustomEvent('ratecard:commit-all'));
    // Wait two animation frames so the commit events have triggered the
    // setState calls and the corresponding fetches.
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    // Poll up to 30s for the latest save to finish.
    const start = Date.now();
    while (saveInFlightRef.current > 0 && Date.now() - start < 30000) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // "+ Add Line Item" — start a new inline-edit row in this section.
  async function handleAddLine(section: SectionInstance) {
    const ok = await ensureDataLoaded();
    if (!ok) return;
    setExpanded((e) => ({ ...e, [section.id]: true }));
    // If a new row is already open, commit it first (saves it if complete,
    // discards if empty) so the inspector can keep adding rows back-to-back
    // without manually hitting Save each time.
    if (pendingNewBySection[section.id]) {
      window.dispatchEvent(new CustomEvent('ratecard:commit-all'));
    }
    // Bump the nonce so the re-opened editor is a FRESH instance (clears the
    // prior row's typed values) rather than reusing the same component state.
    setNewRowNonce((n) => ({ ...n, [section.id]: (n[section.id] || 0) + 1 }));
    setPendingNewBySection((p) => ({ ...p, [section.id]: true }));
  }

  // Save (or upsert) a line in the given section. Used by EditableLineRow.onSave
  // for both new and existing lines.
  // Save (or upsert) a line in the given section. Used by EditableLineRow.onSave
  // for both new and existing lines.
  //
  // Strategy (v0.19.3): immediate, synchronous save. The previous debounced
  // autosave hook had a timing window where Save & Close could navigate before
  // dirty marks had been picked up. By POSTing inline at the moment of save,
  // we eliminate that window entirely. The trade-off is slightly more network
  // chatter (one save per row edit instead of per 2s burst) but for an
  // inspector typing maybe 20-30 lines per inspection that's fine.
  // Move an existing line to another room (voice: "that should go in bathroom
  // one"). Remove it from the old room's LOCAL state, then save it into the new
  // room — the save upserts by externalId, so the record is re-homed in place
  // (no delete + re-create, no external-id churn).
  async function handleMoveLineToSection(fromSectionId: string, toSectionId: string, line: RateCardLineInput) {
    if (fromSectionId && fromSectionId !== toSectionId) {
      setLinesBySection((m) => {
        if (!m[fromSectionId]) return m;
        return { ...m, [fromSectionId]: m[fromSectionId].filter((l) => l.externalId !== line.externalId) };
      });
    }
    return handleSaveLineForSection(toSectionId, line);
  }

  async function handleSaveLineForSection(sectionId: string, line: RateCardLineInput): Promise<{ ok: boolean; error?: string; requested?: string; routedTo?: string; reRouted?: boolean; recordId?: string; skippedSave?: boolean }> {
    // Stamp the line's section/location from the TARGET section. Voice proposals
    // may have been generated for a different room earlier in the same turn
    // (e.g. "go to the kitchen and add a microwave"); routing is by sectionId, so
    // the section/location written to the record must match that section — not
    // whatever the proposal happened to carry.
    // Resolve the target to a REAL, currently-rendered section. The id is
    // normally valid, but a voice turn can hand us a stale/phantom id (e.g. the
    // rooms list changed mid-conversation, or the section_list_json reconciled
    // to different ids). If we appended to a phantom key the line would SAVE but
    // be invisible in the form — the exact "it said Added but the card is empty"
    // bug. Fall back: match by the line's section/location (the server stamps
    // the room name onto the proposal), then by display name, then to the
    // focused section, so a line is NEVER lost to a non-rendered group.
    let targetSection = sections.find((s) => s.id === sectionId);
    if (!targetSection && (line.section || line.location)) {
      const sec = (line.section || '').trim().toLowerCase();
      const loc = (line.location || '').trim().toLowerCase();
      const want = (line.location || line.section || '').trim().toLowerCase();
      targetSection = sections.find((s) => (s.label || '').toLowerCase() === sec && (s.location || '').toLowerCase() === loc)
        || sections.find((s) => (s.displayName || s.label || '').toLowerCase() === want)
        || sections.find((s) => (s.label || '').toLowerCase() === want);
    }
    if (!targetSection && currentSectionId) {
      targetSection = sections.find((s) => s.id === currentSectionId);
    }
    // The id we actually key the line under, everywhere below.
    const effSectionId = targetSection ? targetSection.id : sectionId;
    if (targetSection) {
      line = { ...line, section: targetSection.label, location: targetSection.location };
    }
    if (effSectionId !== sectionId) {
      console.warn(`[RateCardForm] voice add re-routed: requested "${sectionId}" not a current section; using "${effSectionId}" (${targetSection?.displayName || targetSection?.label || '??'}).`);
    }
    // Is this a brand-new line or an edit of an existing one? Used to gate the
    // Whole House auto-fill so a deliberate quantity edit isn't overwritten.
    const isNewLine = !((linesBySection[effSectionId] || []).some((l) => l.externalId === line.externalId));
    // Whole House + SF unit: default the quantity to the property's square
    // footage — but ONLY when first adding the line (not on a later edit), and
    // only when the quantity is still the default (1/empty), so a deliberate
    // quantity is always respected.
    if (
      isNewLine &&
      targetSection &&
      /whole\s*house/i.test(targetSection.label) &&
      props.squareFootage != null &&
      props.squareFootage > 0 &&
      (line.quantity == null || line.quantity === 1)
    ) {
      const item = catalogByCode.get(line.lineItemCode);
      if (item && /^sf$/i.test((item.laborMeas || '').trim())) {
        line = { ...line, quantity: props.squareFootage };
      }
    }
    // Optimistic update — push into local state immediately so the UI reflects
    // the change even before the network round-trip.
    setLinesBySection((m) => {
      const existing = m[effSectionId] || [];
      const found = existing.findIndex((l) => l.externalId === line.externalId);
      const next = [...existing];
      if (found >= 0) next[found] = line;
      else next.push(line);
      return { ...m, [effSectionId]: next };
    });
    setPendingNewBySection((p) => {
      if (!p[effSectionId]) return p;
      const next = { ...p };
      delete next[effSectionId];
      return next;
    });
    // Make sure the room the line landed in is expanded so it's actually visible.
    setExpanded((e) => (e[effSectionId] ? e : { ...e, [effSectionId]: true }));

    // Skip the network call if we're not yet ready to save (still hydrating).
    // The line is now in linesBySection; once linesHydrated flips true the
    // useEffect below will catch up any pending dirty lines.
    // Not ready to persist yet (still hydrating) or read-only: the line is in
    // local state; treat as a non-failure so the assistant doesn't cry wolf.
    if (!linesHydrated || props.readOnly) {
      return { ok: true, requested: sectionId, routedTo: effSectionId, reRouted: effSectionId !== sectionId, skippedSave: true };
    }

    const routing = { requested: sectionId, routedTo: effSectionId, reRouted: effSectionId !== sectionId };
    saveInFlightRef.current++;
    setSaveStatus({ kind: 'saving' });
    // Run through the serial queue so concurrent voice adds don't race each
    // other (and the inspection record) at HubSpot. recordId is read at
    // execution time so a create that just stitched back its id is reused.
    // Returns the real outcome so callers (voice) can report the truth.
    return enqueueSave<{ ok: boolean; error?: string }>(async () => {
      // Declared outside try so the offline-enqueue path in catch can reuse it.
      const recordId = recordIdsByExternalId[line.externalId];
      try {
        // Retry transient failures (flaky field LTE, HubSpot 429/5xx) so a line
        // the inspector saw "Added" isn't silently lost. A 4xx (bad request) is
        // not retryable — fail fast so the real error surfaces.
        const body = JSON.stringify({
          upserts: [{ recordId, line }],
          archives: [],
          bumpStatusToInProgress: true,
        });
        let r: Response | null = null;
        let lastErr = '';
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0) await new Promise((res) => setTimeout(res, 600 * attempt));
          try {
            r = await fetch(`/api/inspections/${props.inspectionRecordId}/rate-card-lines`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body,
            });
          } catch (netErr: any) {
            lastErr = String(netErr?.message || netErr);
            r = null;
            continue; // network blip — retry
          }
          if (r.ok) break;
          if (r.status >= 400 && r.status < 500 && r.status !== 429) {
            const text = await r.text();
            throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`); // not retryable
          }
          lastErr = `HTTP ${r.status}`;
        }
        if (!r || !r.ok) {
          throw new Error(lastErr || 'save failed after retries');
        }
        const data = await r.json();
        // Stitch the new record id back if this was a fresh create
        const result = data.results?.[0];
        if (result?.recordId && result?.answerIdExternal) {
          setRecordIdsByExternalId((cur) => ({
            ...cur,
            [result.answerIdExternal]: result.recordId,
          }));
        }
        setSaveStatus({ kind: 'saved', at: Date.now() });
        return { ok: true, ...routing, recordId: result?.recordId };
      } catch (e: any) {
        console.error('[RateCardForm] line save failed:', e);
        const error = String(e?.message || e);
        // Offline / transient: queue the save so it isn't lost, and treat it as
        // a success for the UI (the line stays; it'll sync when back online).
        if (isOfflineError(e)) {
          outboxEnqueue({
            inspectionRecordId: props.inspectionRecordId,
            endpoint: `/api/inspections/${props.inspectionRecordId}/rate-card-lines`,
            method: 'POST',
            body: { upserts: [{ recordId, line }], archives: [], bumpStatusToInProgress: true },
            kind: 'line',
            meta: { sectionId: effSectionId, line, externalId: line.externalId },
          });
          setPendingSync(outboxCountFor(props.inspectionRecordId));
          setSaveStatus({ kind: 'saved', at: Date.now() });
          return { ok: true, ...routing, recordId: undefined };
        }
        setSaveStatus({ kind: 'error', message: error });
        return { ok: false, error, ...routing };
      } finally {
        saveInFlightRef.current--;
      }
    });
  }

  // ----- Final Checklist: persistence, line-add, and air-filter write-back -----
  // Property values the checklist reads (prefill + conditional septic).
  const fcPropertyValues = {
    air_filters___total_quantity: props.propertyAirFiltersTotal ?? null,
    air_filters___type__1: props.propertyAirFiltersType1 ?? null,
    air_filters___type__2: props.propertyAirFiltersType2 ?? null,
    air_filters___type__3: props.propertyAirFiltersType3 ?? null,
    septic_fee: props.propertySepticFee ?? null,
  };

  // Drop device-local draft (blob:) photo URLs before persisting — those are
  // replaced with the real URL once the queued photo uploads (see runFlush).
  function fcStripBlobs(a: FcAnswers): FcAnswers {
    const clean = (arr?: string[]) => (arr || []).filter((u) => !u.startsWith('blob:'));
    const out: FcAnswers = {};
    for (const [qid, ans] of Object.entries(a)) {
      const next: FcAnswerState = { ...ans };
      if (ans.photoUrls) next.photoUrls = clean(ans.photoUrls);
      if (ans.stickerPhotos) {
        next.stickerPhotos = Object.fromEntries(Object.entries(ans.stickerPhotos).map(([k, v]) => [k, clean(v)]));
      }
      out[qid] = next;
    }
    return out;
  }

  // Persist the whole checklist as ONE qa answer (JSON blob in `note`), upserted
  // by a stable external id. Serialized with the other answer writes.
  function doSaveFinalChecklist(answersToSave: FcAnswers) {
    const sanitized = fcStripBlobs(answersToSave);
    const body = {
      upserts: [{
        recordId: fcRecordIdRef.current,
        answerProps: buildQaAnswerProps({
          answerIdExternal: `FINALCHECKLIST-${props.inspectionRecordId}`,
          inspectionIdExternal: props.inspectionExternalId,
          questionIdExternal: 'fc__all',
          questionText: 'Final Checklist',
          section: 'Final Checklist',
          summaryInstanceLabel: '',
          answerValue: 'final_checklist',
          note: JSON.stringify(sanitized),
        }, { isScope: true }),
        questionHubspotRecordId: null,
      }],
      archives: [] as string[],
    };
    saveInFlightRef.current++;
    setSaveStatus({ kind: 'saving' });
    void enqueueSave(async () => {
      try {
        const r = await fetch(`/api/inspections/${props.inspectionRecordId}/answers`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        if (!r.ok) { const t = await r.text(); throw new Error(`HTTP ${r.status}: ${t.slice(0, 300)}`); }
        const data = await r.json();
        const rid = data.results?.[0]?.recordId;
        if (rid) fcRecordIdRef.current = rid;
        setSaveStatus({ kind: 'saved', at: Date.now() });
      } catch (e: any) {
        if (isOfflineError(e)) {
          // Replayed verbatim when back online (stitch is a no-op for this kind).
          outboxEnqueue({
            inspectionRecordId: props.inspectionRecordId,
            endpoint: `/api/inspections/${props.inspectionRecordId}/answers`,
            method: 'POST', body, kind: 'sectionList', meta: {},
          });
          setPendingSync(outboxCountFor(props.inspectionRecordId));
          setSaveStatus({ kind: 'saved', at: Date.now() });
        } else {
          setSaveStatus({ kind: 'error', message: String(e?.message || e) });
        }
      } finally { saveInFlightRef.current--; }
    });
  }

  function scheduleFcSave(answersToSave: FcAnswers) {
    if (!linesHydrated || props.readOnly) return;
    if (fcSaveTimer.current) clearTimeout(fcSaveTimer.current);
    fcSaveTimer.current = setTimeout(() => doSaveFinalChecklist(answersToSave), 900);
  }

  // Write the confirmed air-filter qty/types back onto the Property in HubSpot.
  function scheduleAirFilterWriteback(a: FcAnswers) {
    if (!props.propertyRecordId || props.readOnly) return;
    if (fcAfTimer.current) clearTimeout(fcAfTimer.current);
    fcAfTimer.current = setTimeout(() => {
      const totalQuantity = a['fc_air_filters_qty']?.quantity ?? null;
      const types = a['fc_filter_sizes']?.filterSizes ?? [];
      void fetch(`/api/properties/${props.propertyRecordId}/air-filters`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ totalQuantity, types }),
      }).catch(() => { /* best-effort write-back */ });
    }, 1500);
  }

  function handleFcPatch(qid: string, patch: Partial<FcAnswerState>) {
    setFcAnswers((prev) => {
      const next = { ...prev, [qid]: { ...prev[qid], ...patch } };
      scheduleFcSave(next);
      if (qid === 'fc_air_filters_qty' || qid === 'fc_filter_sizes') scheduleAirFilterWriteback(next);
      return next;
    });
  }

  function fcWholeHouseSection() {
    return sections.find((s) => /whole\s*house/i.test(s.label));
  }

  // Whole-inspection dedupe by exact catalog lineItemCode.
  function fcLineExists(lineItemCode: string): boolean {
    return Object.values(linesBySection).some((arr) => arr.some((l) => l.lineItemCode === lineItemCode));
  }

  async function handleFcAddLine(rule: FcAddLineRule): Promise<{ externalId: string; costLabel: string } | null> {
    const ready = await ensureDataLoaded();
    if (!ready) return null;
    const item = catalogByCode.get(rule.lineItemCode);
    if (!item) { void dialog.alert(`Couldn't find "${rule.label}" (${rule.lineItemCode}) in the rate card catalog.`); return null; }
    const wh = fcWholeHouseSection();
    if (!wh) { void dialog.alert('No Whole House section found to add the line to.'); return null; }
    const externalId = `RCLINE-${(typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;
    const line: RateCardLineInput = {
      externalId, section: wh.label, location: wh.location || '',
      lineItemCode: item.lineItemCode, quantity: rule.quantity,
      tenantBillBackPercent: rule.tenantBillBackPercent, assignedTo: rule.vendor,
      note: '', customLaborRate: null, customAdjustedMaterialCost: null, customVendorCost: null,
      photoUrls: [],
    };
    let costLabel = '';
    try {
      const calc = calculateLine(item, inspectionRegion, regions, {
        quantity: rule.quantity, tenantBillBackPercent: rule.tenantBillBackPercent,
        customLaborRate: null, customAdjustedMaterialCost: null, customVendorCost: null,
      });
      costLabel = rule.tenantBillBackPercent > 0
        ? `$${formatMoney(roundMoney(calc.tenantCost))} Tenant`
        : `$${formatMoney(roundMoney(calc.vendorCost))} Vendor`;
    } catch { /* cost label is best-effort */ }
    // Fire the save in the BACKGROUND so the "Added" confirmation shows
    // instantly (no network wait). handleSaveLineForSection already does the
    // optimistic state update + its own retry/offline handling. We don't scroll
    // to the line — the inspector stays in the checklist.
    void handleSaveLineForSection(wh.id, line)
      .then((res) => { if (!res.ok) void dialog.alert(`Couldn't add the line: ${res.error || 'unknown error'}`); })
      .catch(() => { /* handled inside */ });
    return { externalId, costLabel };
  }

  function handleFcUndoLine(externalId: string) {
    const wh = fcWholeHouseSection();
    if (wh) void handleDeleteLine(wh.id, externalId);
  }

  // Remove EVERY line in the scope with this catalog code, wherever it lives.
  // Used by the Final Checklist's "Remove" action when a suggested line (e.g. the
  // HVAC Service Clean) already exists — including ones added manually elsewhere,
  // which handleFcUndoLine (Whole House only) wouldn't reach. Snapshot the targets
  // first, then delete, so we don't mutate while iterating.
  function handleFcRemoveByCode(lineItemCode: string) {
    const targets: Array<{ sectionId: string; externalId: string }> = [];
    for (const [sectionId, arr] of Object.entries(linesBySection)) {
      for (const l of arr) {
        if (l.lineItemCode === lineItemCode) targets.push({ sectionId, externalId: l.externalId });
      }
    }
    for (const t of targets) void handleDeleteLine(t.sectionId, t.externalId);
  }

  // The pending new row was discarded (user pressed Esc or blurred with empty fields).
  function handleDiscardNew(sectionId: string) {
    setPendingNewBySection((p) => {
      if (!p[sectionId]) return p;
      const next = { ...p };
      delete next[sectionId];
      return next;
    });
  }

  async function handleDeleteLine(sectionId: string, externalId: string) {
    // Remember the line (and its position) so we can restore it if the archive
    // fails — otherwise the row vanishes from the UI but still exists in HubSpot
    // and reappears on reload.
    const prevLines = linesBySection[sectionId] || [];
    const removedIdx = prevLines.findIndex((l) => l.externalId === externalId);
    const removed = removedIdx >= 0 ? prevLines[removedIdx] : null;
    setLinesBySection((m) => {
      const existing = m[sectionId] || [];
      return { ...m, [sectionId]: existing.filter((l) => l.externalId !== externalId) };
    });
    const recordId = recordIdsByExternalId[externalId];
    if (!recordId || !linesHydrated || props.readOnly) return;
    saveInFlightRef.current++;
    setSaveStatus({ kind: 'saving' });
    await enqueueSave(async () => {
      try {
        const r = await fetch(`/api/inspections/${props.inspectionRecordId}/rate-card-lines`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ upserts: [], archives: [recordId] }),
        });
        if (!r.ok) {
          const text = await r.text();
          throw new Error(`HTTP ${r.status}: ${text.slice(0, 400)}`);
        }
        setRecordIdsByExternalId((cur) => {
          const next = { ...cur };
          delete next[externalId];
          return next;
        });
        setSaveStatus({ kind: 'saved', at: Date.now() });
      } catch (e: any) {
        console.error('[RateCardForm] line delete failed:', e);
        // Offline / transient: queue the archive and keep the line removed (it
        // syncs when back online). Otherwise restore it so the UI matches HubSpot.
        if (isOfflineError(e)) {
          outboxEnqueue({
            inspectionRecordId: props.inspectionRecordId,
            endpoint: `/api/inspections/${props.inspectionRecordId}/rate-card-lines`,
            method: 'POST',
            body: { upserts: [], archives: [recordId] },
            kind: 'lineArchive',
          });
          setPendingSync(outboxCountFor(props.inspectionRecordId));
          setSaveStatus({ kind: 'saved', at: Date.now() });
        } else {
          if (removed) {
            setLinesBySection((m) => {
              const existing = m[sectionId] || [];
              if (existing.some((l) => l.externalId === externalId)) return m;
              const next = [...existing];
              next.splice(Math.min(removedIdx, next.length), 0, removed);
              return { ...m, [sectionId]: next };
            });
          }
          setSaveStatus({ kind: 'error', message: String(e?.message || e) });
        }
      } finally {
        saveInFlightRef.current--;
      }
    });
  }

  // ----- Section list mutators ----------------------------------------
  // All section edits go through these so the persistence path is consistent.
  // Each one updates local state, then PATCHes the new JSON to HubSpot. We
  // also handle cascading deletes (archive line/photo records when a section
  // with content is removed).

  async function persistSectionList(next: SectionInstance[]): Promise<void> {
    const json = serializeSectionList(next);
    try {
      const r = await fetch(`/api/inspections/${props.inspectionRecordId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // Send the base we believe is current so the server can reject a write
        // that would clobber a change made elsewhere.
        body: JSON.stringify({ section_list_json: json, baseSectionListJson: lastSavedSectionJsonRef.current }),
      });
      if (r.status === 409) {
        const data = await r.json().catch(() => ({}));
        const serverJson = String(data.currentSectionListJson || '');
        lastSavedSectionJsonRef.current = serverJson;
        try { setSections(resolveSections(serverJson, props.bedrooms, props.bathrooms)); } catch { /* keep current */ }
        void dialog.alert('The room layout was changed on another device, so it was reloaded here. Please re-apply your change.');
        return;
      }
      if (r.ok) {
        lastSavedSectionJsonRef.current = json;
      } else {
        console.error('[RateCardForm] section_list_json save failed:', r.status);
      }
    } catch (e) {
      console.error('[RateCardForm] section_list_json save failed:', e);
      // Offline: queue the layout change to sync later.
      if (isOfflineError(e)) {
        outboxEnqueue({
          inspectionRecordId: props.inspectionRecordId,
          endpoint: `/api/inspections/${props.inspectionRecordId}`,
          method: 'PATCH',
          body: { section_list_json: json, baseSectionListJson: lastSavedSectionJsonRef.current },
          kind: 'sectionList',
        });
        setPendingSync(outboxCountFor(props.inspectionRecordId));
      }
    }
  }

  function handleRenameSection(sectionId: string, newLabel: string) {
    const trimmed = titleCaseSectionName(newLabel);
    if (!trimmed) return;
    setSections((cur) => {
      const next = cur.map((s) => {
        if (s.id !== sectionId) return s;
        // When the inspector renames, treat the new label as both label and
        // displayName. The location field stays immutable (still used by saved
        // answers); the display value just becomes the user's choice. So
        // renaming "Bedroom 1" to "Master Suite" shows "Master Suite", not
        // "Master Suite — Bedroom 1".
        return { ...s, label: trimmed, displayName: trimmed };
      });
      persistSectionList(next);
      return next;
    });
  }

  async function handleDeleteSection(sectionId: string, skipConfirm = false): Promise<boolean> {
    const section = sections.find((s) => s.id === sectionId);
    if (!section) return false;

    const lines = linesBySection[sectionId] || [];
    // Confirm ONLY when the room has line items (deleting those is destructive).
    // An empty room deletes immediately with no prompt. `skipConfirm` (used by
    // the Sections manager, which has its own UX) can still bypass.
    if (!skipConfirm && lines.length > 0) {
      const roomName = section.displayName || section.label;
      const ok = await dialog.confirm(
        `"${roomName}" has ${lines.length} line item${lines.length === 1 ? '' : 's'}. Deleting the room removes ${lines.length === 1 ? 'it' : 'them all'}. Delete the room?`,
        { confirmLabel: 'Delete Room', cancelLabel: 'Keep' }
      );
      if (!ok) return false;
    }

    // Cascade: archive every saved line + section photo for this section.
    const lineArchives: string[] = [];
    for (const line of lines) {
      const recordId = recordIdsByExternalId[line.externalId];
      if (recordId) lineArchives.push(recordId);
    }
    const photoRecordId = sectionPhotoRecordIds[sectionId];

    // Local state updates
    setSections((cur) => {
      const next = cur.filter((s) => s.id !== sectionId);
      persistSectionList(next);
      return next;
    });
    setLinesBySection((m) => {
      const next = { ...m };
      delete next[sectionId];
      return next;
    });
    setPhotosBySection((m) => {
      const next = { ...m };
      delete next[sectionId];
      return next;
    });
    setExpanded((e) => {
      const next = { ...e };
      delete next[sectionId];
      return next;
    });

    // Network: archive line records, then photo record
    if (lineArchives.length > 0 && linesHydrated && !props.readOnly) {
      saveInFlightRef.current++;
      try {
        await fetch(`/api/inspections/${props.inspectionRecordId}/rate-card-lines`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ upserts: [], archives: lineArchives }),
        });
      } catch (e) {
        console.error('[RateCardForm] section delete: line archive failed', e);
      } finally {
        saveInFlightRef.current--;
      }
    }
    if (photoRecordId && linesHydrated && !props.readOnly) {
      saveInFlightRef.current++;
      try {
        await fetch(`/api/inspections/${props.inspectionRecordId}/answers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ upserts: [], archives: [photoRecordId] }),
        });
        setSectionPhotoRecordIds((m) => {
          const next = { ...m };
          delete next[sectionId];
          return next;
        });
      } catch (e) {
        console.error('[RateCardForm] section delete: photo archive failed', e);
      } finally {
        saveInFlightRef.current--;
      }
    }
    return true;
  }

  function handleAddSection(rawLabel: string) {
    const label = titleCaseSectionName(rawLabel);
    if (!label) return;
    setSections((cur) => {
      const existingIds = new Set(cur.map((s) => s.id));
      const newId = makeCustomSectionId(label, existingIds);
      const newSection: SectionInstance = {
        id: newId,
        key: newId,
        label,
        // For custom sections, location is empty by default. Could be made
        // configurable later but custom sections are typically non-repeating.
        location: label,
        displayName: label,
        isCustom: true,
      };
      const next = [...cur, newSection];
      persistSectionList(next);
      return next;
    });
  }

  function handleReorderSections(newOrder: SectionInstance[]) {
    setSections(newOrder);
    persistSectionList(newOrder);
  }

  // Clear the CONTENT (all lines + section photos) of one or more sections
  // without deleting the sections themselves. Called by the Sections manager
  // when the user confirms staged "clear" actions by hitting Done.
  async function handleClearSections(sectionIds: string[]) {
    if (props.readOnly || sectionIds.length === 0) return;

    // Gather the saved records to archive + external ids to forget.
    const lineArchives: string[] = [];
    const clearedExternalIds: string[] = [];
    const photoArchives: string[] = [];
    for (const sectionId of sectionIds) {
      for (const line of (linesBySection[sectionId] || [])) {
        const recordId = recordIdsByExternalId[line.externalId];
        if (recordId) lineArchives.push(recordId);
        clearedExternalIds.push(line.externalId);
      }
      const photoRecordId = sectionPhotoRecordIds[sectionId];
      if (photoRecordId) photoArchives.push(photoRecordId);
    }

    // Local state: empty the lines + photos for those sections (keep the rooms).
    setLinesBySection((m) => {
      const next = { ...m };
      for (const id of sectionIds) next[id] = [];
      return next;
    });
    setPhotosBySection((m) => {
      const next = { ...m };
      for (const id of sectionIds) next[id] = [];
      return next;
    });

    if (!linesHydrated) return;

    // Network: archive the line records, then the section-photo records.
    if (lineArchives.length > 0) {
      saveInFlightRef.current++;
      setSaveStatus({ kind: 'saving' });
      try {
        const r = await fetch(`/api/inspections/${props.inspectionRecordId}/rate-card-lines`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ upserts: [], archives: lineArchives }),
        });
        if (!r.ok) { const t = await r.text(); throw new Error(`HTTP ${r.status}: ${t.slice(0, 400)}`); }
        setRecordIdsByExternalId((cur) => {
          const next = { ...cur };
          for (const ext of clearedExternalIds) delete next[ext];
          return next;
        });
        setSaveStatus({ kind: 'saved', at: Date.now() });
      } catch (e: any) {
        console.error('[RateCardForm] clear sections: line archive failed', e);
        setSaveStatus({ kind: 'error', message: String(e?.message || e) });
      } finally {
        saveInFlightRef.current--;
      }
    }

    if (photoArchives.length > 0) {
      saveInFlightRef.current++;
      setSaveStatus({ kind: 'saving' });
      try {
        const r = await fetch(`/api/inspections/${props.inspectionRecordId}/answers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ upserts: [], archives: photoArchives }),
        });
        if (!r.ok) { const t = await r.text(); throw new Error(`HTTP ${r.status}: ${t.slice(0, 400)}`); }
        setSectionPhotoRecordIds((cur) => {
          const next = { ...cur };
          for (const id of sectionIds) delete next[id];
          return next;
        });
        setSaveStatus({ kind: 'saved', at: Date.now() });
      } catch (e: any) {
        console.error('[RateCardForm] clear sections: photo archive failed', e);
        setSaveStatus({ kind: 'error', message: String(e?.message || e) });
      } finally {
        saveInFlightRef.current--;
      }
    }
  }

  // ----- Photo handlers ------------------------------------------------

  /**
   * Save the current photo URLs for a section to HubSpot immediately.
   * Replaces the autosave-based 'markPhotosDirty' flow.
   */
  async function savePhotosForSection(sectionId: string, urlsIn: string[]) {
    if (!linesHydrated || props.readOnly) return;
    const section = sections.find((s) => s.id === sectionId);
    if (!section) return;
    // Never persist offline draft URLs (local object URLs) to HubSpot — they're
    // device-local and meaningless server-side. They're replaced with the real
    // URL once the queued photo uploads, then this is called again.
    const urls = urlsIn.filter((u) => !u.startsWith('blob:'));
    const existingRecordId = sectionPhotoRecordIds[sectionId];
    // External ID must be globally unique across ALL inspection_answer records
    // in HubSpot (it's a unique-constraint property). Scoping by inspection
    // recordId prevents collisions when two different inspections both have a
    // section photo for the same section name (e.g., yard_exterior).
    const externalId = `SECTIONPHOTO-${props.inspectionRecordId}-${sectionId}`;

    saveInFlightRef.current++;
    setSaveStatus({ kind: 'saving' });
    // Serialize photo writes with line writes (same inspection record) so rapid
    // remove + camera-complete, or multi-room camera saves, don't race each
    // other at HubSpot and lose/duplicate the section_photo record.
    await enqueueSave(async () => {
      // Build the request body once: archive when no real photos remain, else
      // upsert the section_photo answer with the current real URLs.
      const isArchive = urls.length === 0;
      if (isArchive && !existingRecordId) {
        // Nothing persisted and nothing to persist.
        setSaveStatus({ kind: 'saved', at: Date.now() });
        saveInFlightRef.current--;
        return;
      }
      const body = isArchive
        ? { upserts: [], archives: [existingRecordId] }
        : {
            upserts: [{
              recordId: existingRecordId,
              answerProps: buildSectionPhotoAnswerProps({
                answerIdExternal: externalId,
                inspectionIdExternal: props.inspectionExternalId,
                section: section.label,
                summaryLabel: section.label,
                location: section.location,
                photoUrls: urls,
              }),
              questionHubspotRecordId: null,
            }],
            archives: [],
          };
      try {
        const r = await fetch(`/api/inspections/${props.inspectionRecordId}/answers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const text = await r.text();
          throw new Error(`HTTP ${r.status}: ${text.slice(0, 400)}`);
        }
        if (isArchive) {
          setSectionPhotoRecordIds((cur) => { const next = { ...cur }; delete next[sectionId]; return next; });
        } else {
          const data = await r.json();
          const newRecordId = data.results?.[0]?.recordId;
          if (newRecordId) setSectionPhotoRecordIds((cur) => ({ ...cur, [sectionId]: newRecordId }));
        }
        setSaveStatus({ kind: 'saved', at: Date.now() });
      } catch (e: any) {
        console.error('[RateCardForm] photo save failed:', e);
        // Offline: queue the section-photo record change (delete / list update)
        // so it persists when back online.
        if (isOfflineError(e)) {
          outboxEnqueue({
            inspectionRecordId: props.inspectionRecordId,
            endpoint: `/api/inspections/${props.inspectionRecordId}/answers`,
            method: 'POST',
            body,
            kind: 'sectionPhoto',
            meta: { sectionId },
          });
          setPendingSync(outboxCountFor(props.inspectionRecordId));
          setSaveStatus({ kind: 'saved', at: Date.now() });
        } else {
          setSaveStatus({ kind: 'error', message: String(e?.message || e) });
        }
      } finally {
        saveInFlightRef.current--;
      }
    });
  }

  async function handlePhotoFiles(sectionId: string, files: FileList | null) {
    if (!files || files.length === 0) return;
    const fileArr = Array.from(files);
    setUploadingSection({ sectionId, current: 0, total: fileArr.length });
    const newUrls: string[] = [];
    try {
      const { failed, errors } = await uploadFilesBatch(
        fileArr,
        (url) => {
          newUrls.push(url);
          setPhotosBySection((prev) => ({
            ...prev,
            [sectionId]: [...(prev[sectionId] || []), url],
          }));
        },
        (current, total) => setUploadingSection({ sectionId, current, total }),
        // Queue-aware uploader: offline captures are stored locally (as drafts)
        // and returned as a blob: URL for immediate display; they sync later.
        (file) => uploadPhotoOrQueue(file, props.inspectionRecordId, sectionId),
      );
      if (failed > 0) {
        const reason = errors[0] ? `\n\nReason: ${errors[0]}` : '';
        void dialog.alert(`${failed} of ${fileArr.length} photo${fileArr.length === 1 ? '' : 's'} failed to upload. Successful uploads were saved.${reason}`);
      }
      // Save with the resulting full list. Read the LIVE list (optimistic adds
      // already landed there) and union in newUrls so a photo added by another
      // path mid-upload isn't dropped from the persisted record. savePhotosForSection
      // filters out offline draft (blob:) URLs — those persist after they sync.
      const base = photosBySectionRef.current[sectionId] || [];
      const allUrls = Array.from(new Set([...base, ...newUrls]));
      await savePhotosForSection(sectionId, allUrls);
      refreshPending();
    } catch (e: any) {
      void dialog.alert(`Photo upload failed: ${e.message || e}`);
    } finally {
      setUploadingSection(null);
    }
  }

  function removePhoto(sectionId: string, idx: number) {
    if (props.readOnly) return;
    const current = photosBySection[sectionId] || [];
    const url = current[idx];
    const next = current.filter((_, i) => i !== idx);
    setPhotosBySection((m) => ({ ...m, [sectionId]: next }));
    savePhotosForSection(sectionId, next);
    // Keep line tags in sync: a deleted photo can't stay attached to a line.
    if (url) {
      for (const line of (linesBySection[sectionId] || [])) {
        if ((line.photoUrls || []).includes(url)) {
          handleSaveLineForSection(sectionId, { ...line, photoUrls: line.photoUrls.filter((u) => u !== url) });
        }
      }
    }
  }

  // Replace a section photo with an annotated version (from the lightbox):
  // upload the marked-up file, swap the URL in place, and persist.
  async function replaceSectionPhoto(sectionId: string, idx: number, file: File) {
    if (props.readOnly) return;
    const current = [...(photosBySection[sectionId] || [])];
    if (idx < 0 || idx >= current.length) return;
    const oldUrl = current[idx];
    try {
      // Queue-aware: offline, this returns a local-draft blob URL (the annotated
      // image queued with replacesUrl=oldUrl) and syncs later.
      const url = await uploadPhotoOrQueue(file, props.inspectionRecordId, sectionId, { replacesUrl: oldUrl });
      current[idx] = url;
      setPhotosBySection((m) => ({ ...m, [sectionId]: current }));
      const isDraft = url.startsWith('blob:');
      if (!isDraft) {
        await savePhotosForSection(sectionId, current);
        // Keep line tags in sync: swap the old URL for the marked-up one on any
        // line it was tagged to (otherwise the line keeps the un-marked photo).
        if (oldUrl && oldUrl !== url) {
          for (const line of (linesBySection[sectionId] || [])) {
            if ((line.photoUrls || []).includes(oldUrl)) {
              handleSaveLineForSection(sectionId, { ...line, photoUrls: line.photoUrls.map((u) => (u === oldUrl ? url : u)) });
            }
          }
        }
      } else {
        // Draft: don't persist yet (the blob would be filtered out, dropping the
        // photo). The flusher swaps draft->real + persists section AND lines on
        // reconnect. Lines keep the original URL until then.
        refreshPending();
      }
    } catch (e) {
      console.error('[RateCardForm] annotate replace failed:', e);
    }
  }

  // Short label for a line (catalog description), used in the tag picker + the
  // line-photo lightbox header.
  function lineLabel(line: RateCardLineInput): string {
    const item = catalogByCode.get(line.lineItemCode);
    return item?.laborShortDescription || line.lineItemCode;
  }

  // Tag a section photo to a line item — NON-DESTRUCTIVE: the photo stays in the
  // room's section strip unchanged AND is attached to the line. Reversible via
  // untagPhotoFromLine (no burned-in label to undo).
  function tagPhotoToLine(sectionId: string, index: number, externalId: string) {
    if (props.readOnly) return;
    const url = (photosBySection[sectionId] || [])[index];
    if (!url) return;
    const line = (linesBySection[sectionId] || []).find((l) => l.externalId === externalId);
    if (!line) return;
    if (!(line.photoUrls || []).includes(url)) {
      handleSaveLineForSection(sectionId, { ...line, photoUrls: [...(line.photoUrls || []), url] });
    }
  }

  // Remove a section photo's tag from a line — the photo stays in the room.
  function untagPhotoFromLine(sectionId: string, index: number, externalId: string) {
    if (props.readOnly) return;
    const url = (photosBySection[sectionId] || [])[index];
    if (!url) return;
    const line = (linesBySection[sectionId] || []).find((l) => l.externalId === externalId);
    if (!line) return;
    handleSaveLineForSection(sectionId, { ...line, photoUrls: (line.photoUrls || []).filter((u) => u !== url) });
  }

  // Which lines a given section photo is currently tagged to (for the dropdown).
  function currentTagsForSection(sectionId: string, index: number): { externalId: string; label: string }[] {
    const url = (photosBySection[sectionId] || [])[index];
    if (!url) return [];
    return (linesBySection[sectionId] || [])
      .filter((l) => (l.photoUrls || []).includes(url))
      .map((l) => ({ externalId: l.externalId, label: lineLabel(l) }));
  }

  // Tag a freshly-captured photo to a line FROM INSIDE THE CAMERA (non-destructive).
  async function tagCameraPhotoToLine(url: string, lineExternalId: string): Promise<string> {
    if (props.readOnly) return url;
    const sectionId = cameraSectionId;
    if (!sectionId) return url;
    const line = (linesBySection[sectionId] || []).find((l) => l.externalId === lineExternalId);
    if (!line) return url;
    if (!(line.photoUrls || []).includes(url)) {
      handleSaveLineForSection(sectionId, { ...line, photoUrls: [...(line.photoUrls || []), url] });
    }
    return url;
  }

  // Untag / delete a photo from a line item.
  function deleteLinePhoto(sectionId: string, externalId: string, index: number) {
    if (props.readOnly) return;
    const line = (linesBySection[sectionId] || []).find((l) => l.externalId === externalId);
    if (!line) return;
    const next = (line.photoUrls || []).filter((_, i) => i !== index);
    handleSaveLineForSection(sectionId, { ...line, photoUrls: next });
  }

  // Replace a line photo with an annotated version.
  async function replaceLinePhoto(sectionId: string, externalId: string, index: number, file: File) {
    if (props.readOnly) return;
    const line = (linesBySection[sectionId] || []).find((l) => l.externalId === externalId);
    if (!line) return;
    const arr = [...(line.photoUrls || [])];
    if (index < 0 || index >= arr.length) return;
    const oldUrl = arr[index];
    try {
      const url = await uploadPhotoOrQueue(file, props.inspectionRecordId, sectionId, { replacesUrl: oldUrl, lineExternalId: externalId });
      arr[index] = url;
      if (!url.startsWith('blob:')) {
        handleSaveLineForSection(sectionId, { ...line, photoUrls: arr });
      } else {
        // Draft: update the line locally only (don't persist a blob URL to the
        // server). The flusher persists the real URL on reconnect.
        setLinesBySection((m) => {
          const lines = m[sectionId] || [];
          return { ...m, [sectionId]: lines.map((l) => (l.externalId === externalId ? { ...l, photoUrls: arr } : l)) };
        });
        refreshPending();
      }
    } catch (e) {
      console.error('[RateCardForm] line photo replace failed:', e);
    }
  }

  // After-photo (Internal Resolution) delete/replace — mirrors the line-photo
  // handlers but on the line's afterPhotoUrls. Powers the after-photo lightbox.
  function deleteAfterPhoto(sectionId: string, externalId: string, index: number) {
    if (props.readOnly) return;
    const line = (linesBySection[sectionId] || []).find((l) => l.externalId === externalId);
    if (!line) return;
    const next = (line.afterPhotoUrls || []).filter((_, i) => i !== index);
    handleSaveLineForSection(sectionId, { ...line, afterPhotoUrls: next });
  }

  async function replaceAfterPhoto(sectionId: string, externalId: string, index: number, file: File) {
    if (props.readOnly) return;
    const line = (linesBySection[sectionId] || []).find((l) => l.externalId === externalId);
    if (!line) return;
    const arr = [...(line.afterPhotoUrls || [])];
    if (index < 0 || index >= arr.length) return;
    const oldUrl = arr[index];
    try {
      const url = await uploadPhotoOrQueue(file, props.inspectionRecordId, sectionId, { replacesUrl: oldUrl, lineExternalId: externalId });
      arr[index] = url;
      if (!url.startsWith('blob:')) {
        handleSaveLineForSection(sectionId, { ...line, afterPhotoUrls: arr });
      } else {
        setLinesBySection((m) => {
          const lines = m[sectionId] || [];
          return { ...m, [sectionId]: lines.map((l) => (l.externalId === externalId ? { ...l, afterPhotoUrls: arr } : l)) };
        });
        refreshPending();
      }
    } catch (e) {
      console.error('[RateCardForm] after photo replace failed:', e);
    }
  }

  function handleCameraComplete(hubspotUrls: string[]) {
    if (!cameraSectionId) return;
    if (hubspotUrls.length) {
      const current = photosBySectionRef.current[cameraSectionId] || [];
      const next = Array.from(new Set([...current, ...hubspotUrls]));
      setPhotosBySection((prev) => ({ ...prev, [cameraSectionId]: next }));
      savePhotosForSection(cameraSectionId, next);
      refreshPending();
    }
    setCameraSectionId(null);
  }

  // Multi-room camera: when the inspector switches rooms inside the camera,
  // push the just-captured photos to the room they were taken in, then move the
  // camera's active room. This lets them shoot the whole house in one session.
  function handleCameraRoomChange(leavingRoomId: string, capturedUrls: string[], enteringRoomId: string) {
    if (capturedUrls.length) {
      const current = photosBySectionRef.current[leavingRoomId] || [];
      const next = Array.from(new Set([...current, ...capturedUrls]));
      setPhotosBySection((prev) => ({ ...prev, [leavingRoomId]: next }));
      savePhotosForSection(leavingRoomId, next);
      refreshPending();
    }
    setCameraSectionId(enteringRoomId);
  }

  // ----- Math helpers --------------------------------------------------

  function totalsFor(line: RateCardLineInput) {
    const item = catalogByCode.get(line.lineItemCode);
    if (!item || regions.length === 0) return null;
    try {
      return calculateLine(item, inspectionRegion, regions, {
        quantity: line.quantity,
        tenantBillBackPercent: line.tenantBillBackPercent,
        customLaborRate: line.customLaborRate ?? null,
        customAdjustedMaterialCost: line.customAdjustedMaterialCost ?? null,
        customVendorCost: line.customVendorCost ?? null,
      });
    } catch {
      return null;
    }
  }

  const sectionTotals = useMemo(() => {
    const out: Record<string, { count: number; vendor: number; client: number; tenant: number }> = {};
    for (const s of sections) {
      const lines = linesBySection[s.id] || [];
      let v = 0, c = 0, t = 0;
      for (const line of lines) {
        const calc = totalsFor(line);
        // Round EACH line then sum (one consistent policy) so section/grand
        // totals match the per-line stored/displayed values to the cent.
        if (calc) { v += roundMoney(calc.vendorCost); c += roundMoney(calc.clientCost); t += roundMoney(calc.tenantCost); }
      }
      out[s.id] = { count: lines.length, vendor: v, client: c, tenant: t };
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections, linesBySection, catalog, regions, inspectionRegion]);

  // ----- Vendor filter (report-wide) -----------------------------------
  // Distinct vendors actually assigned on this rate card, ordered by the
  // canonical VENDORS list (then any extras). Drives the header filter dropdown.
  const assignedVendors = useMemo(() => {
    const present = new Set<string>();
    for (const arr of Object.values(linesBySection)) {
      for (const l of arr) { const v = (l.assignedTo || '').trim(); if (v) present.add(v); }
    }
    return [...VENDORS.filter((v) => present.has(v)), ...Array.from(present).filter((v) => !VENDORS.includes(v))];
  }, [linesBySection]);
  const [vendorFilter, setVendorFilter] = useState<string>('All');
  // Guard: if the selected vendor no longer has any lines, fall back to All.
  const activeVendorFilter = vendorFilter !== 'All' && assignedVendors.includes(vendorFilter) ? vendorFilter : 'All';

  const grandTotals = useMemo(() => {
    let v = 0, c = 0, t = 0, n = 0;
    for (const s of sections) {
      const st = sectionTotals[s.id];
      if (st) { v += st.vendor; c += st.client; t += st.tenant; n += st.count; }
    }
    return { count: n, vendor: v, client: c, tenant: t };
  }, [sections, sectionTotals]);

  // Total CLIENT $ billed across the whole inspection for lines assigned to the
  // Internal Resolution vendor (shown in the header so it's visible at a glance).
  const internalResolutionClient = useMemo(() => {
    let c = 0;
    for (const s of sections) {
      for (const line of (linesBySection[s.id] || [])) {
        if ((line.assignedTo || '').trim().toLowerCase() !== 'internal resolution') continue;
        const calc = totalsFor(line);
        if (calc) c += roundMoney(calc.clientCost);
      }
    }
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections, linesBySection, catalog, regions, inspectionRegion]);

  // Cross-section roll-up of every line by catalog category, each carrying its
  // own line items, so the totals header can drill down category → line item.
  type CatLine = { key: string; label: string; qty: string; section: string; vendor: number; client: number; tenant: number };
  type CatGroup = { category: string; count: number; vendor: number; client: number; tenant: number; lines: CatLine[] };
  const categoryBreakdown = useMemo<CatGroup[]>(() => {
    const map = new Map<string, CatGroup>();
    for (const s of sections) {
      for (const line of (linesBySection[s.id] || [])) {
        const item = catalogByCode.get(line.lineItemCode);
        const category = (item?.category || '').trim() || 'Uncategorized';
        const calc = totalsFor(line);
        const v = calc ? roundMoney(calc.vendorCost) : 0;
        const c = calc ? roundMoney(calc.clientCost) : 0;
        const t = calc ? roundMoney(calc.tenantCost) : 0;
        let g = map.get(category);
        if (!g) { g = { category, count: 0, vendor: 0, client: 0, tenant: 0, lines: [] }; map.set(category, g); }
        g.count++; g.vendor += v; g.client += c; g.tenant += t;
        g.lines.push({ key: `${s.id}:${line.externalId || line.lineItemCode}`, label: lineLabel(line), qty: friendlyQtyUnit(line.quantity, item?.laborMeas || ''), section: s.displayName, vendor: v, client: c, tenant: t });
      }
    }
    // Biggest client cost first — that's what the eye looks for in a scope review.
    return Array.from(map.values()).sort((a, b) => b.client - a.client);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections, linesBySection, catalog, regions, inspectionRegion]);

  const toggle = (id: string) => setExpanded((m) => ({ ...m, [id]: !m[id] }));

  // ----- AI scope review: hashing, gating, run, apply -----
  const isScopeTemplate = props.templateType === 'pm_scope_rate_card';
  // Fingerprint of the current priced scope; flips whenever a line changes.
  const currentScopeHash = useMemo(() => scopeHash(linesBySection), [linesBySection]);
  // Review is valid only while the scope it passed against is unchanged.
  const reviewValid = reviewedHash !== null && reviewedHash === currentScopeHash;
  // Final Checklist completeness — gates Submit (scope only) just like AI review.
  // The first unmet checklist item (descriptive), or null when complete. Single
  // source for both the gate and the submit tooltip/flash so they can't diverge.
  const fcGap = useMemo(
    () => finalChecklistGap(fcAnswers, {
      septicFee: props.propertySepticFee ?? null,
      airQtyPrefill: props.propertyAirFiltersTotal ?? null,
      filterOptionsAvailable: (props.filterSizeOptions?.length ?? 0) > 0,
      filterPrefills: [props.propertyAirFiltersType1 ?? null, props.propertyAirFiltersType2 ?? null, props.propertyAirFiltersType3 ?? null],
      lineExists: fcLineExists,
    }),
    [fcAnswers, props.propertySepticFee, props.propertyAirFiltersTotal, props.filterSizeOptions,
     props.propertyAirFiltersType1, props.propertyAirFiltersType2, props.propertyAirFiltersType3, linesBySection],
  );
  const finalChecklistComplete = fcGap === null;
  // The Final Checklist is EDITABLE + gates Submit only for scheduled/in-progress
  // (+ all future) scope inspections. It's shown READ-ONLY during pending approval
  // AND on completed inspections (so the checklist can still be reviewed after the
  // fact) — but only when the inspection actually has checklist data, so
  // inspections that predate the feature stay exempt. Cancelled hides it.
  const fcStatusLower = (props.inspectionStatus || '').toLowerCase();
  const fcEditable = isScopeTemplate
    && fcStatusLower !== 'pending_approval'
    && fcStatusLower !== 'completed' && fcStatusLower !== 'complete'
    && fcStatusLower !== 'cancelled';
  const fcHasData = Object.keys(fcAnswers).length > 0;
  const fcViewableStatus = fcStatusLower === 'pending_approval'
    || fcStatusLower === 'completed' || fcStatusLower === 'complete';
  const fcVisible = fcEditable || (isScopeTemplate && fcViewableStatus && fcHasData);
  // Load any persisted "passed" marker for this inspection on mount.
  useEffect(() => {
    setReviewedHash(getPassedReviewHash(props.inspectionRecordId));
  }, [props.inspectionRecordId]);

  // The scope hash a review ran against (so the cache is tagged to the right
  // scope), and one-time restore of a cached in-progress review.
  const reviewRunHashRef = useRef('');
  const aiRestoredRef = useRef(false);
  useEffect(() => {
    if (aiRestoredRef.current || !linesHydrated) return;
    aiRestoredRef.current = true;
    const cached = loadReviewCache(props.inspectionRecordId);
    if (cached && cached.hash === currentScopeHash) {
      reviewRunHashRef.current = cached.hash;
      setAiSummary(cached.summary || '');
      setAiAdjustments(Array.isArray(cached.adjustments) ? cached.adjustments : []);
      setAiDecisions(cached.decisions || {});
      if (cached.open) setAiModalOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linesHydrated, currentScopeHash, props.inspectionRecordId]);

  // Persist the in-progress / completed review so it survives backgrounding the
  // app, a reload, or a dead zone — tagged to the scope it ran against.
  useEffect(() => {
    if (aiLoading) return; // don't cache the empty starting state
    if (aiAdjustments.length > 0 || aiModalOpen || aiSummary) {
      saveReviewCache(props.inspectionRecordId, {
        hash: reviewRunHashRef.current || currentScopeHash,
        summary: aiSummary,
        adjustments: aiAdjustments,
        open: aiModalOpen,
        decisions: aiDecisions,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiAdjustments, aiSummary, aiModalOpen, aiDecisions, aiLoading]);

  const runAiReview = useCallback(async () => {
    // Guard: if regional pricing hasn't loaded (offline / weak signal), every
    // line prices to $0 and the review wrongly asks for a charge on all of them.
    // Bail with a clear fix instead of trapping the inspector in $0 prompts.
    if (regionsRef.current.length === 0) {
      void dialog.alert('Pricing data isn’t loaded yet — you may be offline or on a weak signal. Open the ⚙ menu and tap “Refresh Pricing,” then run the AI check again.');
      return;
    }
    reviewRunHashRef.current = scopeHash(linesBySectionRef.current);
    setAiModalOpen(true);
    setAiError(null);
    setAiLoading(true);
    setAiStreaming(false);
    setAiSummary('');
    setAiAdjustments([]);
    setAiDecisions({});
    setAiConnectivityFailed(false);

    // Flush pending edits once up front so the server reviews what's on screen.
    try { await commitAndWait(); } catch { /* proceed with client state */ }

    // Build the payload once — scope is flushed and unchanged between retries.
    const flatLines = sections.flatMap((s) =>
      (linesBySectionRef.current[s.id] || []).map((l) => ({
        sectionId: s.id,
        externalId: l.externalId,
        lineItemCode: l.lineItemCode,
        quantity: l.quantity,
        tenantBillBackPercent: l.tenantBillBackPercent,
        assignedTo: l.assignedTo,
        note: l.note,
        customVendorCost: l.customVendorCost ?? null,
        customLaborRate: l.customLaborRate ?? null,
        customAdjustedMaterialCost: l.customAdjustedMaterialCost ?? null,
      }))
    );
    const photosBySectionPayload: Record<string, string[]> = {};
    for (const s of sections) {
      const urls = (photosBySectionRef.current[s.id] || []).filter((u) => !u.startsWith('blob:'));
      if (urls.length) photosBySectionPayload[s.id] = urls;
    }
    const body = JSON.stringify({
      sections: sections.map((s) => ({ id: s.id, name: s.displayName || s.label, location: s.location })),
      lines: flatLines,
      photosBySection: photosBySectionPayload,
      // Lines the inspector chose to "Ignore" for photo evidence — the
      // review won't re-flag these for a photo.
      ignoredLineIds: getIgnoredPhotoLines(props.inspectionRecordId),
      // Items already reviewed (decided on) in a prior run — don't re-flag them.
      reviewedSignatures: getReviewedItems(props.inspectionRecordId),
      property: {
        bedrooms: props.bedrooms,
        bathrooms: props.bathrooms,
        squareFootage: props.squareFootage,
        // Real value when present; the endpoint defaults null/invalid to 12.
        tenantMonths: (typeof props.lastTenantMonths === 'number' && props.lastTenantMonths >= 0) ? props.lastTenantMonths : null,
      },
      region: inspectionRegion,
    });

    // One streaming attempt. Throws an AbortError if the stream stalls (weak
    // signal) so the caller can retry; throws a normal Error on HTTP failure.
    // A server-side SSE 'error' event is surfaced but NOT thrown (it's a content
    // error, not connectivity — retrying wouldn't help).
    const STALL_MS = 30000;
    const attempt = async (): Promise<void> => {
      setAiAdjustments([]); // fresh slate per attempt so a retry can't duplicate
      setAiSummary('');
      const ctrl = new AbortController();
      let stallTimer: ReturnType<typeof setTimeout> | null = null;
      const armStall = () => { if (stallTimer) clearTimeout(stallTimer); stallTimer = setTimeout(() => ctrl.abort(), STALL_MS); };
      try {
        armStall(); // start the watchdog as the request goes out
        const res = await fetch(`/api/inspections/${props.inspectionRecordId}/ai-review`, {
          method: 'POST',
          signal: ctrl.signal,
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        if (!res.ok || !res.body) {
          const txt = await res.text().catch(() => '');
          throw new Error(`Review failed (${res.status}). ${txt.slice(0, 160)}`);
        }
        // Stream the SSE response, appending each suggestion as it arrives.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let event = '';
        let streamErr: string | null = null;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          armStall(); // progress → re-arm the stall watchdog
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\n');
          buffer = parts.pop() || '';
          for (const raw of parts) {
            const line = raw.trim();
            if (line.startsWith('event:')) { event = line.slice(6).trim(); continue; }
            if (!line.startsWith('data:')) continue;
            let data: any;
            try { data = JSON.parse(line.slice(5).trim()); } catch { continue; }
            if (event === 'adjustment') {
              setAiLoading(false);
              setAiStreaming(true);
              setAiAdjustments((prev) => [...prev, data]);
            } else if (event === 'summary') {
              setAiLoading(false);
              setAiSummary(String(data.summary || ''));
            } else if (event === 'error') {
              streamErr = String(data.error || 'Review failed');
            }
          }
        }
        if (streamErr) setAiError(streamErr);
      } finally {
        if (stallTimer) clearTimeout(stallTimer);
      }
    };

    // Valiant effort: try, and auto-retry once on a connectivity abort before
    // giving up. Only a connectivity failure flips aiConnectivityFailed (which
    // unlocks the "submit without review" escape hatch at submit).
    const MAX_ATTEMPTS = 2;
    let lastErr: any = null;
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      try { await attempt(); lastErr = null; break; }
      catch (e: any) {
        lastErr = e;
        if (e?.name === 'AbortError' && i < MAX_ATTEMPTS) {
          setAiError(`Weak connection — retrying AI Review (attempt ${i + 1} of ${MAX_ATTEMPTS})…`);
          continue;
        }
        break;
      }
    }
    if (lastErr) {
      const aborted = lastErr?.name === 'AbortError';
      setAiConnectivityFailed(aborted);
      setAiError(
        aborted
          ? 'AI Review couldn’t complete after several attempts (weak connection). Retry when you have signal, or tap Submit — you’ll be offered the option to submit without it.'
          : String(lastErr?.message || lastErr)
      );
    }
    setAiLoading(false);
    setAiStreaming(false);
    // Deterministic safety checks (scope-wide): if there's NO paint and/or NO
    // cleaning line anywhere, append a validation item so the inspector confirms
    // none are needed (or adds them). Only when the review itself succeeded.
    if (!lastErr) {
      // Use the live catalog map (ref), not the closure copy. If the catalog
      // hasn't loaded we can't classify any line — skip the check entirely
      // rather than wrongly report every category as missing. The "Unit Turns
      // (Paint/Clean/Minor Repairs)" category satisfies BOTH paint and clean.
      const cat = catalogByCodeRef.current;
      if (cat.size > 0) {
        const hasCat = (re: RegExp) => Object.values(linesBySectionRef.current).some((arr) =>
          (arr || []).some((l) => {
            const it = cat.get(l.lineItemCode);
            if (!it) return false;
            return re.test(it.category || '') || re.test(it.subcategory || '');
          }));
        const extra: AiAdjustment[] = [];
        if (!hasCat(/paint/i)) extra.push(missingCategoryCheck('paint'));
        if (!hasCat(/clean/i)) extra.push(missingCategoryCheck('cleaning'));
        // Flag lines added with NO vendor charge ($0) — every line should have a
        // cost. CRITICAL guard against the field flood: only flag $0 lines when
        // OTHER lines ARE priced (> $0). That proves regional pricing is loaded
        // and working, so a $0 here is a genuine miss — not "pricing didn't load,
        // so everything is $0." If nothing is priced, we flag nothing.
        if (regionsRef.current.length > 0) {
          const priced: { sid: string; l: RateCardLineInput; item: RateCardLineItem; vc: number }[] = [];
          for (const [sid, arr] of Object.entries(linesBySectionRef.current)) {
            for (const l of (arr || [])) {
              const item = cat.get(l.lineItemCode);
              if (!item) continue; // unknown code → can't price → don't flag
              let vc: number | null = null;
              try {
                const c = calculateLine(item, inspectionRegion, regionsRef.current, {
                  quantity: l.quantity, tenantBillBackPercent: l.tenantBillBackPercent,
                  customLaborRate: l.customLaborRate ?? null, customAdjustedMaterialCost: l.customAdjustedMaterialCost ?? null,
                  customVendorCost: l.customVendorCost ?? null,
                });
                vc = roundMoney(c.vendorCost);
              } catch { vc = null; } // unpriceable → skip
              if (vc !== null) priced.push({ sid, l, item, vc });
            }
          }
          const anyPriced = priced.some((p) => p.vc > 0);
          if (anyPriced) {
            let flagged = 0;
            for (const p of priced) {
              if (flagged >= 30) break;
              if (p.vc <= 0) {
                const sec = sections.find((s) => s.id === p.sid);
                extra.push({
                  id: `novendor_${p.l.externalId}`,
                  type: 'edit',
                  sectionId: p.sid,
                  sectionName: sec?.displayName || sec?.label,
                  lineExternalId: p.l.externalId,
                  needsVendorCost: true,
                  title: `Add a vendor charge — ${p.item.laborShortDescription}`,
                  rationale: 'This line has no vendor charge ($0), but every line should have a cost. Enter the vendor cost, or confirm none is needed.',
                  severity: 'medium',
                  current: { description: p.item.laborShortDescription, vendorCost: 0, lineItemCode: p.l.lineItemCode, quantity: p.l.quantity, unit: p.item.laborMeas },
                });
                flagged++;
              }
            }
          }
        }
        if (extra.length) setAiAdjustments((prev) => {
          const have = new Set(prev.map((p) => p.id));
          return [...prev, ...extra.filter((e) => !have.has(e.id))];
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections, props.inspectionRecordId, props.bedrooms, props.bathrooms, props.squareFootage, props.lastTenantMonths, inspectionRegion]);

  // Live tenant-$ preview for the review popup as the inspector edits the
  // tenant % / quantity on a suggestion (uses the same authoritative math).
  const previewTenantDollars = useCallback((a: AiAdjustment, o: { tenantPct?: number; quantity?: number }): number | undefined => {
    const code = a.suggested?.lineItemCode || a.current?.lineItemCode;
    if (!code) return undefined;
    const item = catalogByCode.get(code);
    if (!item) return undefined;
    const existing = a.lineExternalId ? (linesBySectionRef.current[a.sectionId] || []).find((l) => l.externalId === a.lineExternalId) : undefined;
    const qty = o.quantity ?? a.suggested?.quantity ?? existing?.quantity ?? 1;
    const pct = o.tenantPct ?? a.suggested?.tenantBillBackPercent ?? existing?.tenantBillBackPercent ?? 100;
    const calc = totalsFor({
      externalId: existing?.externalId || 'preview',
      section: '', location: '',
      lineItemCode: code,
      quantity: qty,
      tenantBillBackPercent: pct,
      assignedTo: a.suggested?.assignedTo || existing?.assignedTo || 'Vendor 1',
      note: '',
      customVendorCost: a.suggested?.customVendorCost ?? existing?.customVendorCost ?? null,
      photoUrls: [],
    });
    return calc ? roundMoney(calc.tenantCost) : undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, regions, inspectionRegion]);

  // Apply the approved adjustments in ONE batched save (fast + fewer failure
  // points than a per-line round-trip), then mark the review passed for the
  // resulting scope (so submit unlocks). Declined items are left untouched.
  const applyApproved = useCallback(async (approved: AiAdjustment[]) => {
    setAiApplying(true);
    setSaveStatus({ kind: 'saving' });
    try {
      // Project the resulting scope deterministically, and collect a single
      // batch of upserts/archives for the rate-card-lines endpoint.
      const projected: Record<string, RateCardLineInput[]> = {};
      for (const [sid, arr] of Object.entries(linesBySectionRef.current)) projected[sid] = [...arr];
      const upserts: { recordId?: string; line: RateCardLineInput; sectionId: string }[] = [];
      const archives: string[] = [];

      for (const a of approved) {
        // missingCategory checks are acknowledgements only — no line change.
        if (a.missingCategory) continue;
        const sec = sections.find((s) => s.id === a.sectionId);
        // Wrong-room: MOVE the line to the chosen room (keep the same record).
        // No-op if the inspector left it in its current room.
        if (a.wrongRoom && a.lineExternalId) {
          const toSid = a.suggested?.moveToSectionId;
          const toSec = toSid ? sections.find((s) => s.id === toSid) : undefined;
          const line = (projected[a.sectionId] || []).find((l) => l.externalId === a.lineExternalId);
          if (toSec && line && toSec.id !== a.sectionId) {
            projected[a.sectionId] = (projected[a.sectionId] || []).filter((l) => l.externalId !== a.lineExternalId);
            const moved = { ...line, section: toSec.label, location: toSec.location || '' };
            projected[toSec.id] = [...(projected[toSec.id] || []), moved];
            upserts.push({ recordId: recordIdsByExternalIdRef.current[line.externalId], line: moved, sectionId: toSec.id });
          }
          continue;
        }
        // A needsPhoto item approved = "Remove line" regardless of the AI's type.
        const effType = a.needsPhoto ? 'remove' : a.type;
        if (effType === 'remove' && a.lineExternalId) {
          projected[a.sectionId] = (projected[a.sectionId] || []).filter((l) => l.externalId !== a.lineExternalId);
          const rid = recordIdsByExternalIdRef.current[a.lineExternalId];
          if (rid) archives.push(rid);
        } else if (effType === 'edit' && a.lineExternalId) {
          const existing = (projected[a.sectionId] || []).find((l) => l.externalId === a.lineExternalId);
          if (!existing) continue;
          const next: RateCardLineInput = {
            ...existing,
            lineItemCode: a.suggested?.lineItemCode || existing.lineItemCode,
            quantity: a.suggested?.quantity ?? existing.quantity,
            tenantBillBackPercent: a.suggested?.tenantBillBackPercent ?? existing.tenantBillBackPercent,
            assignedTo: a.suggested?.assignedTo || existing.assignedTo,
            customVendorCost: a.suggested?.customVendorCost ?? existing.customVendorCost,
            ...(sec ? { section: sec.label, location: sec.location || '' } : {}),
          };
          projected[a.sectionId] = (projected[a.sectionId] || []).map((l) => (l.externalId === a.lineExternalId ? next : l));
          upserts.push({ recordId: recordIdsByExternalIdRef.current[next.externalId], line: next, sectionId: a.sectionId });
        } else if (effType === 'add' && a.suggested?.lineItemCode && sec) {
          const line: RateCardLineInput = {
            externalId: `ai_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            section: sec.label,
            location: sec.location || '',
            lineItemCode: a.suggested.lineItemCode,
            quantity: a.suggested.quantity ?? 1,
            tenantBillBackPercent: a.suggested.tenantBillBackPercent ?? 100,
            assignedTo: defaultVendorForCode(a.suggested.lineItemCode) || a.suggested.assignedTo || 'Vendor 1',
            note: '',
            customVendorCost: a.suggested.customVendorCost ?? null,
            photoUrls: [],
          };
          projected[a.sectionId] = [...(projected[a.sectionId] || []), line];
          upserts.push({ line, sectionId: a.sectionId });
        }
      }

      // Optimistic UI: show the new scope immediately.
      setLinesBySection(projected);

      let partialFailures: string | null = null;
      if (upserts.length || archives.length) {
        // Direct, timeout-bounded save (NOT via the serial save chain) so a
        // wedged prior save can't leave the apply hanging on "Saving…" forever.
        const endpoint = `/api/inspections/${props.inspectionRecordId}/rate-card-lines`;
        const body = JSON.stringify({ upserts: upserts.map((u) => ({ recordId: u.recordId, line: u.line })), archives, bumpStatusToInProgress: true });
        try {
          let r: Response | null = null; let lastErr = '';
          for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0) await new Promise((res) => setTimeout(res, 600 * attempt));
            const ctrl = new AbortController();
            const to = setTimeout(() => ctrl.abort(), 30000); // never hang indefinitely
            try { r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: ctrl.signal }); }
            catch (ne: any) { lastErr = String(ne?.message || ne); r = null; clearTimeout(to); continue; }
            clearTimeout(to);
            if (r.ok) break;
            if (r.status >= 400 && r.status < 500 && r.status !== 429) { const t = await r.text(); throw new Error(`HTTP ${r.status}: ${t.slice(0, 200)}`); }
            { const t = await r.text().catch(() => ''); lastErr = `HTTP ${r.status}${t ? `: ${t.slice(0, 200)}` : ''}`; }
          }
          if (!r || !r.ok) throw new Error(lastErr || 'save failed after retries');
          const data = await r.json();
          for (const res of (data.results || [])) {
            if (res?.recordId && res?.answerIdExternal) setRecordIdsByExternalId((cur) => ({ ...cur, [res.answerIdExternal]: res.recordId }));
          }
          // Endpoint saved the good lines but reported per-item failures — keep
          // them visible (don't mark the review passed) and name what failed.
          if (Array.isArray(data.failures) && data.failures.length) {
            partialFailures = data.failures.map((f: any) => `• ${f.code}: ${f.error}`).join('\n');
          }
          setSaveStatus({ kind: 'saved', at: Date.now() });
        } catch (e: any) {
          // ONLY defer-save when the device is genuinely offline — then the
          // changes are queued and will sync, and we mark the review applied.
          // If we're online but the server errored (e.g. a 5xx after retries),
          // the changes did NOT persist — surface it as a real failure so the
          // inspector knows (and the approver isn't handed un-saved edits).
          const genuinelyOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
          if (genuinelyOffline) {
            for (const u of upserts) {
              outboxEnqueue({ inspectionRecordId: props.inspectionRecordId, endpoint, method: 'POST', body: { upserts: [{ recordId: u.recordId, line: u.line }], archives: [], bumpStatusToInProgress: true }, kind: 'line', meta: { sectionId: u.sectionId, line: u.line, externalId: u.line.externalId } });
            }
            for (const rid of archives) {
              outboxEnqueue({ inspectionRecordId: props.inspectionRecordId, endpoint, method: 'POST', body: { upserts: [], archives: [rid] }, kind: 'lineArchive' });
            }
            refreshPending();
            setSaveStatus({ kind: 'saved', at: Date.now() });
          } else {
            setSaveStatus({ kind: 'error', message: String(e?.message || e) });
            throw e;
          }
        }
      }

      // If some changes couldn't save, keep the review open and show exactly
      // which line + why — don't mark it passed (submit stays gated).
      if (partialFailures) {
        setAiError(`Some changes couldn’t save and were not applied:\n\n${partialFailures}\n\nFix or decline those, then apply again.`);
        refreshPending();
        return;
      }

      const newHash = scopeHash(projected);
      setReviewedHash(newHash);
      setPassedReviewHash(props.inspectionRecordId, newHash);
      clearReviewCache(props.inspectionRecordId); // review consumed
      setAiAdjustments([]);
      setAiSummary('');
      setAiDecisions({});
      refreshPending();
      setAiModalOpen(false);
      // Return to the inspection and scroll to the top so the inspector sees the
      // updated totals / submit.
      try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch { /* noop */ }
    } catch (e: any) {
      setAiError(`Could not apply all changes: ${e?.message || e}`);
    } finally {
      setAiApplying(false);
      // Never leave the header pinned on "Saving…" (which would also keep submit
      // disabled). If nothing resolved it, clear to saved.
      setSaveStatus((s) => (s.kind === 'saving' ? { kind: 'saved', at: Date.now() } : s));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections, props.inspectionRecordId, refreshPending]);

  // Photo evidence gap (needsPhoto suggestion): open the in-app camera (same as
  // the "Take" button) for that room, then attach the captured photo(s) to the
  // room AND tag them onto the flagged line. Returns true once a photo is added.
  const aiPhotoTargetRef = useRef<{ sectionId: string; lineExternalId?: string; resolve: (ok: boolean) => void } | null>(null);
  const [aiCameraTarget, setAiCameraTarget] = useState<{ sectionId: string; lineExternalId?: string } | null>(null);

  // AI review "Decline — Add Items": open the manual line-item editor (added to
  // Whole House). Resolves with the count added so the review item can mark
  // itself resolved and the inspector returns to the checklist.
  const [aiAddItemsOpen, setAiAddItemsOpen] = useState(false);
  const aiAddItemsResolveRef = useRef<((n: number) => void) | null>(null);
  const addLineItemsForReview = useCallback((_a: AiAdjustment): Promise<number> => {
    return new Promise<number>((resolve) => {
      aiAddItemsResolveRef.current = resolve;
      setAiAddItemsOpen(true);
    });
  }, []);
  function finishAiAddItems(count: number) {
    const resolve = aiAddItemsResolveRef.current;
    aiAddItemsResolveRef.current = null;
    setAiAddItemsOpen(false);
    resolve?.(count);
  }

  // In-app camera for capturing AFTER photos on an Internal Resolution line.
  // Opening it is triggered from the line card's After Photos "+"; on Done the
  // captured URLs are appended to that line's afterPhotoUrls and saved. Kept
  // separate from the section photo pool (these are line-level proof-of-work).
  const [afterCameraTarget, setAfterCameraTarget] = useState<{ sectionId: string; lineExternalId: string } | null>(null);
  async function handleAfterPhotoCapture(target: { sectionId: string; lineExternalId: string }, urls: string[]) {
    const real = (urls || []).filter((u) => !u.startsWith('blob:'));
    if (real.length === 0) return;
    const line = (linesBySectionRef.current[target.sectionId] || []).find((l) => l.externalId === target.lineExternalId);
    if (!line) return;
    const updated = { ...line, afterPhotoUrls: Array.from(new Set([...(line.afterPhotoUrls || []), ...real])) };
    setLinesBySection((m) => ({
      ...m,
      [target.sectionId]: (m[target.sectionId] || []).map((l) => (l.externalId === target.lineExternalId ? updated : l)),
    }));
    await handleSaveLineForSection(target.sectionId, updated);
  }
  const addPhotoForAdjustment = useCallback((a: AiAdjustment): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      aiPhotoTargetRef.current = { sectionId: a.sectionId, lineExternalId: a.lineExternalId, resolve };
      setAiCameraTarget({ sectionId: a.sectionId, lineExternalId: a.lineExternalId });
    });
  }, []);
  const handleAiCameraComplete = useCallback(async (urls: string[]) => {
    const target = aiPhotoTargetRef.current;
    aiPhotoTargetRef.current = null;
    setAiCameraTarget(null);
    if (!target) return;
    if (!urls || urls.length === 0) { target.resolve(false); return; }
    try {
      // Attach to the room's photo strip.
      const base = photosBySectionRef.current[target.sectionId] || [];
      const nextPhotos = Array.from(new Set([...base, ...urls]));
      setPhotosBySection((m) => ({ ...m, [target.sectionId]: nextPhotos }));
      await savePhotosForSection(target.sectionId, nextPhotos.filter((u) => !u.startsWith('blob:')));
      // Tag onto the flagged line.
      if (target.lineExternalId) {
        const line = (linesBySectionRef.current[target.sectionId] || []).find((l) => l.externalId === target.lineExternalId);
        if (line) {
          const updated = { ...line, photoUrls: Array.from(new Set([...(line.photoUrls || []), ...urls])) };
          setLinesBySection((m) => ({ ...m, [target.sectionId]: (m[target.sectionId] || []).map((l) => (l.externalId === target.lineExternalId ? updated : l)) }));
          await handleSaveLineForSection(target.sectionId, updated);
        }
      }
      refreshPending();
      target.resolve(true);
    } catch {
      target.resolve(false);
    }
  }, [refreshPending]);
  const handleAiCameraClose = useCallback(() => {
    const target = aiPhotoTargetRef.current;
    aiPhotoTargetRef.current = null;
    setAiCameraTarget(null);
    target?.resolve(false);
  }, []);

  // ----- Terminal action handlers (shared between inline + floating footers) ----
  // Extracted so the desktop floating footer and the mobile inline footer can
  // both call the same logic without duplicating ~80 lines of JSX.

  async function handleCancelInspectionClick() {
    if (!props.onCancelInspection) return;
    const confirmed = await dialog.confirm(
      'Cancel this inspection? It will be marked as Cancelled in HubSpot. ' +
      'Already-saved lines and photos will remain on the record but the ' +
      'inspection won\'t progress further. This cannot be undone.',
      { confirmLabel: 'Cancel Inspection', cancelLabel: 'Keep' }
    );
    if (!confirmed) return;
    try { await commitAndWait(); } catch {}
    props.onCancelInspection();
  }

  async function handleSaveAndClose() {
    // Commit any open inline edits AND flush any pending autosaves before
    // navigating. If the save fails, surface it so the user can retry —
    // silently dropping their work is worse than blocking.
    try {
      await commitAndWait();
    } catch (e: any) {
      const msg = e?.message || String(e);
      const proceed = await dialog.confirm(
        `Save failed: ${msg}\n\nLeave anyway? Your unsaved changes will be lost.`,
        { confirmLabel: 'Leave anyway', cancelLabel: 'Stay' }
      );
      if (!proceed) return;
    }
    props.onCancel();
  }

  // At finalize, permanently burn each tagged photo's line label onto the image
  // (bottom-right). Tagging is non-destructive while editing; this is the one
  // place the label is baked in, so the vendor PDF's section-photo grid shows
  // which line each photo belongs to — with no PDF changes. Idempotent.
  async function burnTaggedLabels() {
    for (const section of sections) {
      const lines = linesBySection[section.id] || [];
      if (lines.length === 0) continue;
      const secPhotos = [...(photosBySection[section.id] || [])];
      const swaps = new Map<string, string>();
      for (let i = 0; i < secPhotos.length; i++) {
        const url = secPhotos[i];
        if (isStamped(url)) continue; // already burned (e.g. re-finalize)
        const taggedLines = lines.filter((l) => (l.photoUrls || []).includes(url));
        if (taggedLines.length === 0) continue;
        const label = taggedLines.map((l) => lineLabel(l)).join(' · ');
        try {
          const stamped = await stampEntryWithLabel(url, label);
          if (stamped && stamped !== url) { secPhotos[i] = stamped; swaps.set(url, stamped); }
        } catch (e) { console.warn('[burnTaggedLabels] stamp failed:', e); }
      }
      if (swaps.size > 0) {
        setPhotosBySection((m) => ({ ...m, [section.id]: secPhotos }));
        await savePhotosForSection(section.id, secPhotos);
        for (const line of lines) {
          if (!(line.photoUrls || []).some((u) => swaps.has(u))) continue;
          await handleSaveLineForSection(section.id, { ...line, photoUrls: (line.photoUrls || []).map((u) => swaps.get(u) || u) });
        }
      }
    }
  }

  async function handleSubmitOrFinalize() {
    if (submitGuardRef.current) return; // a submit/finalize is already in flight
    // Don't submit/finalize until the AI-applied (and any other) changes have
    // actually synced to the server — otherwise approval would run on a stale
    // or partial scope. The Submit button is also disabled in this state.
    if (aiApplying || (pendingSync + pendingPhotos) > 0) {
      await dialog.alert(
        `Your latest changes are still saving (${pendingSync + pendingPhotos} pending). Please wait for "Synced" before submitting.\n\nIf it stays stuck, use Retry or Clear on the sync banner.`
      );
      return;
    }
    // Pre-flight: required section photos present?
    const missingSections: string[] = [];
    for (const s of sections) {
      const photos = photosBySection[s.id] || [];
      const required = !s.photoOptional && !sectionPhotoExempt(s.displayName || s.label);
      if (required && photos.length === 0) missingSections.push(s.displayName);
    }
    if (missingSections.length > 0) {
      await dialog.alert(
        'Section photos are still required for:\n\n' +
        missingSections.slice(0, 10).map((n) => `  • ${n}`).join('\n') +
        (missingSections.length > 10 ? `\n  ...and ${missingSections.length - 10} more` : '')
      );
      return;
    }
    // Pre-flight: every Internal Resolution line needs at least one AFTER photo
    // (proof the in-house work was done). Gated on afterPhotosEnabled so this
    // can't block before the migration that lets after-photos be saved.
    if (afterPhotosEnabled) {
      const missingAfter: string[] = [];
      for (const s of sections) {
        for (const line of (linesBySection[s.id] || [])) {
          // Only "Complete Now" Internal Resolution lines require after-photos.
          // "Complete Later" defers the work, so it's exempt at finalize.
          const timing = resolutionTimings[line.externalId] || 'now';
          if (isInternalResolution(line.assignedTo) && timing === 'now' && (line.afterPhotoUrls?.length ?? 0) === 0) {
            const desc = catalogByCode.get(line.lineItemCode)?.laborShortDescription || line.lineItemCode;
            missingAfter.push(`${s.displayName}: ${desc}`);
          }
        }
      }
      if (missingAfter.length > 0) {
        await dialog.alert(
          'After photos are required on every "Complete Now" Internal Resolution line before finalizing. Add an After Photo (or switch it to "Complete Later") for:\n\n' +
          missingAfter.slice(0, 10).map((n) => `  • ${n}`).join('\n') +
          (missingAfter.length > 10 ? `\n  ...and ${missingAfter.length - 10} more` : '')
        );
        return;
      }
    }
    // No lines at all? Probably a mistake.
    const totalLines = Object.values(linesBySection).reduce((s, arr) => s + arr.length, 0);
    if (totalLines === 0) {
      const ok = await dialog.confirm('No line items have been added. Submit anyway?', { confirmLabel: 'Submit' });
      if (!ok) return;
    }
    // AI Review gate at SUBMIT — a Scope rate card must pass AI Review for the
    // CURRENT scope before it can be submitted for approval. Any edit since the
    // last review invalidates it (see reviewValid), so this re-prompts after
    // changes.
    //
    // Low-service escape hatch: the review is normally REQUIRED, but if it's been
    // genuinely attempted (with auto-retry) and ultimately failed on connectivity
    // (aiConnectivityFailed), we offer a one-tap "submit without review". The
    // bypass is ONLY offered after that valiant effort — it can't be reached by
    // simply declining the review. A bypassed submit is still caught by the hard
    // AI-Review gate at finalize, so the check always happens before PDFs.
    // Final Checklist hard-gate (scope, first submit only): every required item
    // must be complete, and each line-item prompt accepted or declined.
    if (fcEditable && fcGap) {
      void dialog.alert(`Finish the Final Checklist before submitting:\n\n• ${fcGap}`);
      return;
    }
    if (props.templateType === 'pm_scope_rate_card' && props.inspectionStatus !== 'pending_approval' && !reviewValid) {
      if (aiConnectivityFailed) {
        const ok = await dialog.confirm(
          'AI Review couldn’t complete after several attempts (weak connection).\n\nSubmit for approval WITHOUT the AI Review? It will still be required before the inspection can be finalized.',
          { confirmLabel: 'Submit without review', cancelLabel: 'Try review again' }
        );
        if (!ok) { void runAiReview(); return; }
        // else: bypass granted (after a valiant effort) — fall through to submit.
      } else {
        const ok = await dialog.confirm(
          'AI Review must be completed before submitting for approval.\n\nIt checks the scope against the turn standard (depreciation, duplicates, tenant responsibility) and suggests adjustments to approve or decline.',
          { confirmLabel: 'Run AI Review', cancelLabel: 'Not now' }
        );
        if (ok) void runAiReview();
        return;
      }
    }
    // Flush pending edits to make sure HubSpot has everything before the submit.
    try {
      await commitAndWait();
    } catch (e: any) {
      await dialog.alert(`Could not finish saving before submit: ${e.message || e}\n\nPlease try again.`);
      return;
    }
    // Branch on status: pending_approval -> finalize flow, else submit flow.
    const isFinalizing = props.inspectionStatus === 'pending_approval';
    if (isFinalizing) {
      // Belt-and-suspenders: the button is disabled for the submitter, but guard
      // the handler too so a stray call can't slip a self-approval finalize past
      // the (also server-enforced) lock.
      if (selfApprovalLocked) {
        await dialog.alert(
          `You submitted this inspection for approval, so you can't finalize it yourself.\n\nA second reviewer needs to finalize it. Tap "Save & Close".`
        );
        return;
      }
      // AI Review gate at FINALIZE — HARD requirement, no bypass. This is the
      // backstop that guarantees AI Review always runs before PDFs are generated:
      // it catches any submit that used the low-service "submit without review"
      // escape hatch, and it's the approver's own QC pass (reviewValid is
      // per-device, so a second reviewer runs it fresh here). Any edit since the
      // last review invalidates it (see reviewValid), so this re-prompts too.
      if (props.templateType === 'pm_scope_rate_card' && !reviewValid) {
        const ok = await dialog.confirm(
          'AI Review must be completed before finalizing.\n\nIt checks the scope against the turn standard (depreciation, duplicates, tenant responsibility) and suggests adjustments to approve or decline.',
          { confirmLabel: 'Run AI Review', cancelLabel: 'Not now' }
        );
        if (ok) void runAiReview();
        return;
      }
      // Before finalizing, make sure Gmail is connected so the completion
      // email can actually send. If the server is configured for Gmail but
      // this user hasn't connected yet, bounce them through the OAuth flow —
      // the callback returns to this inspection with ?finalizeNow=1 which
      // auto-resumes finalize once connected. If Gmail isn't configured on
      // the server at all, we just proceed (email will be skipped server-side).
      try {
        const statusRes = await fetch('/api/auth/gmail/status');
        if (statusRes.ok) {
          const status = await statusRes.json();
          if (status.configured && !status.connected) {
            // Redirect to connect, carrying this inspection id so we can
            // auto-resume finalize after authorization.
            window.location.href =
              `/api/auth/gmail/connect?finalizeAfter=${encodeURIComponent(props.inspectionRecordId)}`;
            return;
          }
        }
      } catch {
        // Status check failed — don't block finalize on it; proceed and let
        // the server decide whether email sends.
      }

      // No confirmation prompt — clicking the button is itself the user's
      // intent to finalize. Spinner shows in the button label while the PDFs
      // generate (10-30s on Vercel lambda). The result modal still appears
      // afterward to surface the downloads.
      submitGuardRef.current = true;
      setFinalizing(true);
      try {
        // Burn line labels onto tagged photos before the server builds the PDF
        // (finalize reads photos from HubSpot, so these must be saved first).
        await burnTaggedLabels();
        const r = await fetch(`/api/inspections/${props.inspectionRecordId}/finalize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Send the timing map so same-device finalize honors "Complete Later"
          // even for inspections submitted before the map was persisted.
          body: JSON.stringify({ resolutionTimings }),
        });
        if (!r.ok) {
          // Surface the server's clean message (e.g. the self-approval lockout)
          // rather than a raw HTTP body.
          let msg = `HTTP ${r.status}`;
          try { const j = await r.json(); if (j?.error) msg = j.error; } catch { /* non-JSON */ }
          const err: any = new Error(msg); err.status = r.status;
          throw err;
        }
        const data = await r.json();
        setFinalizeResult(data as FinalizeResult);
        // If a maintenance ticket was created, push the scope PDFs into it in
        // the BACKGROUND (driving the HoneyBadger UI takes ~30-60s). This never
        // blocks the completion screen; a bottom flash toast reports the result
        // even after the user navigates away.
        const mt = (data as FinalizeResult).maintenanceTicket;
        if (mt && mt.ok && mt.ticketId) {
          flashApi.runTicketUpload(props.inspectionRecordId, mt.ticketId);
        }
      } catch (e: any) {
        // The self-approval lockout (423) is an expected workflow state, not a failure.
        if (e?.status === 423) await dialog.alert(e.message);
        else await dialog.alert(`Finalize failed: ${e?.message || e}\n\nThe inspection status was NOT changed. You can try again.`);
      } finally {
        setFinalizing(false);
        submitGuardRef.current = false;
      }
      return;
    }
    // First submit: flip status to pending_approval
    setSubmitting(true);
    submitGuardRef.current = true;
    try {
      const r = await fetch(`/api/inspections/${props.inspectionRecordId}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Persist the per-line "Complete Now/Later" choices so the approver (any
        // device) and the finalize gate honor them.
        body: JSON.stringify({ resolutionTimings }),
      });
      if (!r.ok) {
        const text = await r.text();
        throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
      }
      // Confirmation toast — it lives at the app root, so it stays visible after
      // onSubmit() routes back to the inspections home screen (app + desktop).
      flashApi.flash('Scope Submitted - Pending Approval ✔️', 'success', 8000);
      props.onSubmit();
    } catch (e: any) {
      await dialog.alert(`Submit failed: ${e.message || e}`);
    } finally {
      setSubmitting(false);
      submitGuardRef.current = false;
    }
  }

  // Keep the ref pointing at the latest handler so the OAuth auto-resume
  // effect always calls the current closure.
  finalizeHandlerRef.current = handleSubmitOrFinalize;

  // Human-friendly status label shown in the header. We map the HubSpot
  // internal value (snake_case) to title case + apply a color pill.
  const statusLabel = (() => {
    // While the catalog/answers are still loading on first open, show a
    // transient "Loading…" pill in place of the status — once everything is
    // ready it flips to the real inspection status. This covers BOTH the
    // catalog/region fetch (dataLoading) AND the saved-answers hydration
    // (linesHydrated), since the answers load is usually the slower one the
    // inspector feels. Avoids adding a separate spinner or button.
    const stillLoading = (!props.readOnly && !linesHydrated) || (dataLoading && !dataLoaded);
    if (stillLoading) {
      return { label: 'Loading…', color: 'bg-gray-100 text-gray-500 border-gray-200 animate-pulse' };
    }
    switch (liveStatus) {
      case 'scheduled': return { label: 'Scheduled', color: 'bg-blue-100 text-blue-800 border-blue-200' };
      case 'in_progress': return { label: 'In Progress', color: 'bg-amber-100 text-amber-800 border-amber-200' };
      case 'pending_approval': return { label: 'Pending Approval', color: 'bg-purple-100 text-purple-800 border-purple-200' };
      case 'completed': return { label: 'Completed', color: 'bg-emerald-100 text-emerald-800 border-emerald-200' };
      case 'cancelled': return { label: 'Cancelled', color: 'bg-gray-100 text-gray-700 border-gray-200' };
      default: return null;
    }
  })();

  // ---- Dual-approval lockout (mirrors the server) ----
  // The person who submitted for approval can NEVER finalize their own
  // submission — a second reviewer (any other signed-in user) must. This is a
  // permanent lock (not a 5-minute window), so it also stops the common
  // foot-gun: after submitting, the inspector reopens to add a line item and
  // then hits "Finalize & Generate PDFs" by reflex instead of "Save & Close".
  // While locked we GRAY OUT Finalize and animate Save & Close. A finalize admin
  // is exempt and may finalize their own work.
  const isSubmitter =
    !!props.currentUserEmail && !!props.submittedByEmail &&
    props.currentUserEmail.trim().toLowerCase() === props.submittedByEmail.trim().toLowerCase();
  const selfApprovalLocked =
    props.inspectionStatus === 'pending_approval' && isSubmitter && !props.isFinalizeAdmin;

  const submitLabel = finalizing
    ? 'Generating PDFs...'
    : submitting
      ? 'Submitting...'
      : props.inspectionStatus === 'pending_approval'
        ? 'Finalize & Generate PDFs'
        : 'Submit for Approval';
  // Compact label for the narrow mobile footer (keeps everything on one line).
  const submitLabelShort = finalizing
    ? 'Generating...'
    : submitting
      ? 'Submitting...'
      : props.inspectionStatus === 'pending_approval'
        ? 'Finalize'
        : 'Submit';

  // Collapse/expand-all: mirrors the per-section isOpen logic (undefined =
  // default-open when the section has content).
  const anySectionOpen = (fcVisible && fcOpen) || sections.some((s) => {
    const uc = expanded[s.id];
    return uc !== undefined
      ? uc
      : ((linesBySection[s.id]?.length || 0) > 0 || (photosBySection[s.id]?.length || 0) > 0);
  });
  // Global Expand/Collapse-all also drives the Final Checklist bubble.
  const setAllSections = (open: boolean) => {
    setExpanded(Object.fromEntries(sections.map((s) => [s.id, open])));
    if (fcVisible) setFcOpen(open);
  };

  // ----- Render --------------------------------------------------------

  return (
    <div className="max-w-7xl mx-auto px-5 sm:px-6 py-2.5">
      {/* Header */}
      <header className="mb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-x-2 gap-y-1 flex-wrap">
              <h1 className="text-lg sm:text-xl font-bold text-gray-900 leading-tight">{props.templateLabel}</h1>
              {statusLabel && (
                <span className={`inline-flex items-center shrink-0 px-2 py-0.5 rounded-full text-xs font-semibold border ${statusLabel.color}`}>
                  {statusLabel.label}
                </span>
              )}
            </div>
            <div className="text-xs text-gray-500 mt-0.5">
              Inspector: {props.inspectorName}
              {/* Only show "Submitted" while it's actually in a submitted state —
                  if it was reopened back to In Progress, drop the stamp. */}
              {(liveStatus === 'pending_approval' || liveStatus === 'completed') && fmtStamp(props.submittedAt) && (
                <span className="text-gray-400">{'  ·  '}{fmtStamp(props.submittedAt)} Submitted</span>
              )}
            </div>
            {props.approverName && (
              <div className="text-xs text-gray-500 mt-0.5">
                Approver: {props.approverName}
                {fmtStamp(props.approvedAt) && (
                  <span className="text-gray-400">{'  ·  '}{fmtStamp(props.approvedAt)} Approved</span>
                )}
              </div>
            )}
            {props.pdfUrl && (
              <a href={props.pdfUrl} target="_blank" rel="noopener noreferrer"
                 className="inline-block mt-2 text-sm text-brand underline">View PDF</a>
            )}
          </div>

          {/* Settings (gear) + Back, pinned upper-right. The gear houses the
              lower-frequency Manage Sections / Refresh Pricing actions to keep
              the body clean. */}
          <div className="flex-shrink-0 self-start flex items-center gap-2">
            {!props.readOnly && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowSettingsMenu((v) => !v)}
                  aria-label="Settings"
                  aria-expanded={showSettingsMenu}
                  title="Settings"
                  className="inline-flex items-center justify-center w-9 h-9 text-gray-600 hover:text-gray-900 border border-gray-300 hover:border-gray-400 rounded-lg bg-white transition-colors"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                </button>
                {showSettingsMenu && (
                  <>
                    {/* click-away backdrop */}
                    <button type="button" aria-hidden tabIndex={-1} className="fixed inset-0 z-40 cursor-default" onClick={() => setShowSettingsMenu(false)} />
                    <div className="absolute right-0 mt-1.5 z-50 w-52 rounded-xl border border-gray-200 bg-white shadow-lg ring-1 ring-black/5 overflow-hidden animate-[fadeIn_120ms_ease-out]">
                      <button
                        type="button"
                        onClick={() => { setShowSettingsMenu(false); setShowSectionsManager(true); }}
                        className="w-full text-left px-3.5 py-2.5 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2.5 transition-colors"
                      >
                        <span aria-hidden className="text-gray-400">⚙</span> Manage Sections
                      </button>
                      <button
                        type="button"
                        disabled={dataLoading}
                        onClick={async () => {
                          setShowSettingsMenu(false);
                          const ok = await dialog.confirm(
                            'Refresh rate card pricing from HubSpot?\n\n' +
                            'This will pull the latest line item costs and regional labor rates. ' +
                            'Already-saved lines keep their original pricing — only new lines will use the refreshed rates.',
                            { confirmLabel: 'Refresh' }
                          );
                          if (!ok) return;
                          await refreshCatalogFromHubSpot();
                        }}
                        className="w-full text-left px-3.5 py-2.5 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2.5 transition-colors disabled:opacity-50 border-t border-gray-100"
                        title="Force-refresh line item catalog and regional rates from HubSpot."
                      >
                        <span aria-hidden className="text-gray-400">⟳</span> {dataLoading ? 'Refreshing…' : 'Refresh Pricing'}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setShowSettingsMenu(false); setShowAuditTrail(true); }}
                        className="w-full text-left px-3.5 py-2.5 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2.5 transition-colors border-t border-gray-100"
                        title="Who submitted, approved, reopened or cancelled this inspection, and when."
                      >
                        <span aria-hidden className="text-gray-400">🕑</span> Audit Trail
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={handleSaveAndClose}
              className="inline-flex items-center gap-1 text-sm font-semibold text-gray-700 hover:text-gray-900 border border-gray-300 hover:border-gray-400 rounded-lg px-3 py-1.5 bg-white transition-colors"
              title="Save and go back"
            >
              <span aria-hidden>←</span> Back
            </button>
          </div>
        </div>
      </header>

      {/* Sticky header bar — the single home for address + property data
          (the top header no longer repeats it). Five centered boxes:
          Lines + Vendor / Client / Tenant / Net Turn. */}
      {/* Offline / pending-sync banner. Saves are queued locally and replay
          automatically when the connection returns, so work is never lost in a
          dead zone. */}
      {(() => {
        const totalPending = pendingSync + pendingPhotos;
        if (online && totalPending === 0) return null;
        const noun = totalPending === 1 ? 'change' : 'changes';
        if (!online) {
          return (
            <div className="-mx-4 px-4 py-1.5 mb-2 text-xs font-heading font-semibold flex items-center justify-center gap-2 bg-amber-100 text-amber-800">
              <span className="inline-block w-2 h-2 rounded-full bg-amber-500" />
              {totalPending > 0
                ? `Offline — ${totalPending} ${noun}${pendingPhotos > 0 ? ` (incl. ${pendingPhotos} photo/video)` : ''} saved here, will sync when you're back online`
                : `Offline — your changes are saved on this device and will sync automatically`}
            </div>
          );
        }
        // Online with a non-empty queue: actively syncing, or stuck (offer Retry/Clear).
        return (
          <div className={`-mx-4 px-4 py-1.5 mb-2 text-xs font-heading font-semibold flex items-center justify-center gap-2 ${flushing ? 'bg-blue-50 text-blue-700' : syncStuck ? 'bg-red-50 text-red-700' : 'bg-blue-50 text-blue-700'}`}>
            <span className={`inline-block w-2 h-2 rounded-full ${flushing ? 'bg-blue-500 animate-pulse' : syncStuck ? 'bg-red-500' : 'bg-blue-500 animate-pulse'}`} />
            <span>{flushing ? `Syncing ${totalPending} ${noun}…` : syncStuck ? `${totalPending} ${noun} haven’t synced` : `Syncing ${totalPending} ${noun}…`}</span>
            <button type="button" onClick={() => void runFlush()} disabled={flushing} className="inline-flex items-center gap-1 underline hover:no-underline disabled:opacity-60 disabled:no-underline">
              {flushing && <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />}
              {flushing ? 'Retrying…' : 'Retry'}
            </button>
            {syncStuck && !flushing && (
              <>
                <button
                  type="button"
                  onClick={() => void dialog.alert(`Last sync error:\n\n${lastSyncError || 'No error captured — the server may be slow. Tap Retry, or Clear to discard the stuck items.'}`)}
                  className="underline hover:no-underline"
                >
                  Details
                </button>
                <button type="button" onClick={() => void clearStuckQueue()} className="underline hover:no-underline">Clear</button>
              </>
            )}
          </div>
        );
      })()}

      {/* Device-storage warning. Photos/video sit in local storage until they
          sync; if the device fills up, new captures fail. Warn early. */}
      {storage.nearFull && (
        <div className={`-mx-4 px-4 py-1.5 mb-2 text-xs font-heading font-semibold flex items-center justify-center gap-2 ${storage.critical ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'}`}>
          <span className={`inline-block w-2 h-2 rounded-full ${storage.critical ? 'bg-red-500' : 'bg-amber-500'}`} />
          {storage.critical
            ? `Device storage almost full (${formatMB(storage.usageBytes)} of ${formatMB(storage.quotaBytes)}). Sync or free up space soon — new photos may fail to save.`
            : `Device storage is filling up (${Math.round(storage.pct * 100)}% used). Reconnect to sync photos/video and free up space.`}
        </div>
      )}

      <div id="sticky-totals-header" className="sticky top-0 z-30 -mx-4 px-4 py-2 mb-3 bg-gray-50 border-b border-gray-200 shadow-sm">
        <div className="sm:flex sm:items-center sm:justify-between sm:gap-4">
          <div className="flex items-center justify-center sm:justify-start gap-2 mb-2 sm:mb-0 min-w-0">
            {/* ResiWalk app icon — pink house + footprint on a white tile so the
                square blends into the light header (vs the white-on-pink tile
                used on the pink inspections-list header). Edge-to-edge. */}
            {/* Logo → save & return to the inspections list (flushes first).
                Transparent pink mark (no white tile) so it blends on the
                off-white header. */}
            <button type="button" onClick={handleSaveAndClose} aria-label="Back to inspections" title="Back to inspections" className="shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/favicon.svg" alt="ResiWalk" className="h-8 w-8 object-contain" />
            </button>
            <div className="text-center sm:text-left min-w-0">
            <div className="text-sm font-semibold text-gray-800 truncate">{props.propertyName}</div>
            <div className="text-[11px] text-gray-500 truncate">
              {props.bedrooms} bed / {props.bathrooms} bath
              {props.squareFootage != null && props.squareFootage > 0 && (
                <span> &middot; {props.squareFootage.toLocaleString()} sqft</span>
              )}
              {inspectionRegion && <span> &middot; {inspectionRegion}</span>}
              {!inspectionRegion && <span className="text-yellow-700"> &middot; fallback (GA: Atlanta)</span>}
              {saveStatus.kind === 'saving' && <span className="text-brand font-semibold"> &middot; Saving...</span>}
              {saveStatus.kind === 'saved' && <span className="text-emerald-700 font-semibold"> &middot; &#10003; Saved</span>}
              {saveStatus.kind === 'error' && (
                <button
                  type="button"
                  onClick={() => setShowSaveErrorDetail(true)}
                  className="text-red-700 font-semibold underline hover:text-red-900 ml-1"
                  title="Click for details"
                >
                  &middot; Save failed
                </button>
              )}
            </div>
            {/* Total client $ across lines assigned to Internal Resolution. */}
            <div className="text-[11px] text-gray-500 truncate">
              Internal Resolution: ${internalResolutionClient.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
            </div>
          </div>
          <div className="flex justify-center sm:justify-end shrink-0">
            <button
              type="button"
              onClick={() => setOverviewExpanded((v) => !v)}
              aria-expanded={overviewExpanded}
              title={overviewExpanded ? 'Hide breakdown' : 'Tap to see the breakdown by category'}
              className="flex items-stretch text-xs rounded-md bg-white border border-gray-200 overflow-hidden hover:border-gray-300 hover:shadow-sm transition-shadow"
            >
              <div className="text-center px-2 py-1 w-[58px] sm:w-[84px]">
                <div className="text-gray-400 text-[10px] uppercase tracking-wide">Lines</div>
                <div className="font-semibold text-gray-700 tabular-nums mt-0.5">{grandTotals.count}</div>
              </div>
              <div className="text-center px-2 py-1 w-[74px] sm:w-[104px] border-l border-gray-200/70">
                <div className="text-gray-400 text-[10px] uppercase tracking-wide">Vendor</div>
                <div className="font-semibold text-gray-700 tabular-nums mt-0.5">${formatMoney(roundMoney(grandTotals.vendor))}</div>
              </div>
              <div className="text-center px-2 py-1 w-[74px] sm:w-[104px] border-l border-gray-200/70">
                <div className="text-gray-400 text-[10px] uppercase tracking-wide">Client</div>
                <div className="font-semibold text-gray-700 tabular-nums mt-0.5">${formatMoney(roundMoney(grandTotals.client))}</div>
              </div>
              <div className="text-center px-2 py-1 w-[74px] sm:w-[104px] border-l border-gray-200/70">
                <div className="text-brand/70 text-[10px] uppercase tracking-wide">Tenant</div>
                <div className="font-semibold text-brand tabular-nums mt-0.5">${formatMoney(roundMoney(grandTotals.tenant))}</div>
              </div>
              <div className="text-center px-2 py-1 w-[74px] sm:w-[104px] border-l border-gray-200/70">
                <div className="text-emerald-600/70 text-[10px] uppercase tracking-wide">Net Turn</div>
                <div className="font-semibold text-emerald-700 tabular-nums mt-0.5">${formatMoney(roundMoney(grandTotals.client - grandTotals.tenant))}</div>
              </div>
              <div className="flex items-center px-1.5 border-l border-gray-200/70 text-gray-400">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                     className={`transition-transform ${overviewExpanded ? 'rotate-180' : ''}`}>
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </div>
            </button>
          </div>
        </div>
      </div>

      {/* Totals drill-down: category roll-up → line items, same $ columns. */}
      {overviewExpanded && (
        <div className="mb-3 rounded-lg border border-gray-200 bg-white overflow-hidden">
          {/* Expand all / collapse all every category (and its line items). */}
          {categoryBreakdown.length > 0 && (() => {
            const anyOpen = categoryBreakdown.some((g) => expandedCats[g.category]);
            return (
              <div className="flex justify-end px-2.5 pt-1.5">
                <button
                  type="button"
                  onClick={() => setExpandedCats(anyOpen ? {} : Object.fromEntries(categoryBreakdown.map((g) => [g.category, true])))}
                  className="inline-flex items-center gap-1 text-[11px] font-heading font-semibold text-gray-500 hover:text-brand"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${anyOpen ? '' : 'rotate-180'}`}>
                    <polyline points="18 15 12 9 6 15" />
                  </svg>
                  {anyOpen ? 'Collapse all' : 'Expand all'}
                </button>
              </div>
            );
          })()}
          {/* Column header */}
          <div className="flex items-end gap-1 px-2.5 py-1.5 bg-gray-50 border-b border-gray-200 text-[9px] sm:text-[10px] uppercase tracking-wide text-gray-400">
            <div className="flex-1 min-w-0">Category</div>
            <div className="w-[52px] sm:w-[68px] text-right">Vendor</div>
            <div className="w-[52px] sm:w-[68px] text-right">Client</div>
            <div className="w-[52px] sm:w-[68px] text-right">Tenant</div>
            <div className="w-[52px] sm:w-[68px] text-right">Net</div>
          </div>

          {categoryBreakdown.length === 0 && (
            <div className="px-3 py-4 text-center text-sm text-gray-400">No line items yet.</div>
          )}

          {categoryBreakdown.map((g) => {
            const open = !!expandedCats[g.category];
            return (
              <div key={g.category} className="border-b border-gray-100 last:border-b-0">
                <button
                  type="button"
                  onClick={() => setExpandedCats((m) => ({ ...m, [g.category]: !m[g.category] }))}
                  aria-expanded={open}
                  className="w-full flex items-center gap-1 px-2.5 py-2 text-left bg-gray-100 hover:bg-gray-200/70 border-b border-gray-200"
                >
                  <div className="flex-1 min-w-0 flex items-start gap-1.5">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                         className={`shrink-0 mt-0.5 text-gray-400 transition-transform ${open ? 'rotate-90' : ''}`}>
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                    <span className="text-[13px] font-medium text-gray-800 leading-tight break-words">{g.category} <span className="text-[10px] font-normal text-gray-400 tabular-nums">({g.count})</span></span>
                  </div>
                  <div className="w-[52px] sm:w-[68px] text-right text-[11px] sm:text-[13px] tabular-nums whitespace-nowrap text-gray-700">${formatMoney(roundMoney(g.vendor))}</div>
                  <div className="w-[52px] sm:w-[68px] text-right text-[11px] sm:text-[13px] tabular-nums whitespace-nowrap text-gray-700">${formatMoney(roundMoney(g.client))}</div>
                  <div className="w-[52px] sm:w-[68px] text-right text-[11px] sm:text-[13px] tabular-nums whitespace-nowrap text-brand">${formatMoney(roundMoney(g.tenant))}</div>
                  <div className="w-[52px] sm:w-[68px] text-right text-[11px] sm:text-[13px] tabular-nums whitespace-nowrap text-emerald-700">${formatMoney(roundMoney(g.client - g.tenant))}</div>
                </button>

                {open && (
                  <div className="bg-gray-50/60">
                    {g.lines.map((ln) => (
                      <div key={ln.key} className="flex items-start gap-1 pl-6 pr-2.5 py-1.5 border-t border-gray-100">
                        <div className="flex-1 min-w-0">
                          <div className="text-[12px] text-gray-700 leading-snug break-words">{ln.label}{ln.qty ? <span className="text-gray-400"> ({ln.qty})</span> : null}</div>
                          <div className="text-[10px] text-gray-400 break-words">{ln.section}</div>
                        </div>
                        <div className="w-[52px] sm:w-[68px] text-right text-[11px] sm:text-[12px] tabular-nums whitespace-nowrap text-gray-600">${formatMoney(ln.vendor)}</div>
                        <div className="w-[52px] sm:w-[68px] text-right text-[11px] sm:text-[12px] tabular-nums whitespace-nowrap text-gray-600">${formatMoney(ln.client)}</div>
                        <div className="w-[52px] sm:w-[68px] text-right text-[11px] sm:text-[12px] tabular-nums whitespace-nowrap text-brand/90">${formatMoney(ln.tenant)}</div>
                        <div className="w-[52px] sm:w-[68px] text-right text-[11px] sm:text-[12px] tabular-nums whitespace-nowrap text-emerald-700/90">${formatMoney(roundMoney(ln.client - ln.tenant))}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {/* Grand-total footer row — mirrors the header pill. */}
          {categoryBreakdown.length > 0 && (
            <div className="flex items-center gap-1 px-2.5 py-2 bg-gray-50 border-t border-gray-200">
              <div className="flex-1 min-w-0 text-[13px] font-semibold text-gray-800">Total ({grandTotals.count})</div>
              <div className="w-[52px] sm:w-[68px] text-right text-[11px] sm:text-[13px] font-semibold tabular-nums whitespace-nowrap text-gray-800">${formatMoney(roundMoney(grandTotals.vendor))}</div>
              <div className="w-[52px] sm:w-[68px] text-right text-[11px] sm:text-[13px] font-semibold tabular-nums whitespace-nowrap text-gray-800">${formatMoney(roundMoney(grandTotals.client))}</div>
              <div className="w-[52px] sm:w-[68px] text-right text-[11px] sm:text-[13px] font-semibold tabular-nums whitespace-nowrap text-brand">${formatMoney(roundMoney(grandTotals.tenant))}</div>
              <div className="w-[52px] sm:w-[68px] text-right text-[11px] sm:text-[13px] font-semibold tabular-nums whitespace-nowrap text-emerald-700">${formatMoney(roundMoney(grandTotals.client - grandTotals.tenant))}</div>
            </div>
          )}
        </div>
      )}

      {dataError && (
        <div className="mb-3 p-3 bg-red-50 border border-red-300 rounded text-sm text-red-800">
          Error loading rate card data: {dataError}
        </div>
      )}

      {/* Vendor filter (left) + Collapse/expand all (right) */}
      {(assignedVendors.length > 0 || sections.length > 1) && (
        <div className="flex items-center justify-between gap-2 mb-2">
          {assignedVendors.length > 0 ? (
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-xs font-heading text-gray-500 shrink-0">Vendor:</span>
              <ListPicker
                value={activeVendorFilter}
                options={[{ value: 'All', label: 'All Vendors' }, ...assignedVendors.map((v) => ({ value: v, label: v }))]}
                onChange={setVendorFilter}
                ariaLabel="Filter by Assigned Vendor"
                className="text-xs font-heading text-gray-800 flex items-center gap-0.5 hover:text-brand"
              />
              {activeVendorFilter !== 'All' && (
                <button
                  type="button"
                  onClick={() => setVendorFilter('All')}
                  className="text-xs text-brand underline font-heading font-semibold shrink-0"
                >
                  Clear
                </button>
              )}
            </div>
          ) : <span />}
          {sections.length > 1 ? (
            <button
              type="button"
              onClick={() => setAllSections(!anySectionOpen)}
              className="inline-flex items-center gap-1 text-xs font-heading text-gray-500 hover:text-gray-800 transition-colors shrink-0"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                   className={`transition-transform ${anySectionOpen ? '' : 'rotate-180'}`}>
                <polyline points="18 15 12 9 6 15" />
              </svg>
              {anySectionOpen ? 'Collapse all' : 'Expand all'}
            </button>
          ) : <span />}
        </div>
      )}

      {/* Sections */}
      <div className="space-y-3">
        {sections.map((s) => {
          const allLines = linesBySection[s.id] || [];
          // Vendor filter: show only the selected vendor's lines, and hide
          // sections that have none of them (unless a new row is being added here).
          const lines = activeVendorFilter === 'All'
            ? allLines
            : allLines.filter((l) => (l.assignedTo || '').trim() === activeVendorFilter);
          if (activeVendorFilter !== 'All' && lines.length === 0 && !pendingNewBySection[s.id]) return null;
          const photos = photosBySection[s.id] || [];
          // Photos tagged to a line are shown UNDER that line's card and hidden
          // from the room strip (a visual "move"); the data stays in the section
          // so the PDF still shows it (with the burned label after finalize).
          const taggedSet = new Set<string>();
          for (const l of lines) for (const u of (l.photoUrls || [])) taggedSet.add(u);
          // Sections default to open when they have line items or photos
          // (so the inspector sees their work) but the user can collapse
          // them at any time via the chevron. The `expanded` state is now a
          // tri-state via undefined/true/false: undefined = use default,
          // true = forced open, false = forced closed. This lets us preserve
          // the default behaviour without "stickying" old user choices.
          const hasContent = lines.length > 0 || photos.length > 0;
          const userChoice = expanded[s.id];
          const isOpen = userChoice === undefined ? hasContent : userChoice;
          const heading = s.displayName;
          // Header totals reflect the active vendor filter (recompute from the
          // visible lines) so the report's numbers match what's shown.
          let t = sectionTotals[s.id] || { count: 0, vendor: 0, client: 0, tenant: 0 };
          if (activeVendorFilter !== 'All') {
            let v = 0, c = 0, tn = 0;
            for (const line of lines) {
              const calc = totalsFor(line);
              if (calc) { v += roundMoney(calc.vendorCost); c += roundMoney(calc.clientCost); tn += roundMoney(calc.tenantCost); }
            }
            t = { count: lines.length, vendor: v, client: c, tenant: tn };
          }
          const photosRequired = !s.photoOptional && !sectionPhotoExempt(heading || s.label);
          const photosMissing = photosRequired && photos.length === 0;
          const isUploadingHere = uploadingSection?.sectionId === s.id;
          return (
            <section
              key={s.id}
              ref={(el) => { sectionRefs.current[s.id] = el; }}
              className={`bg-white rounded-xl border overflow-hidden transition-shadow duration-200 ${currentSectionId === s.id ? 'border-brand ring-1 ring-brand/30 shadow-md' : 'border-gray-200 shadow-sm hover:shadow-md'}`}
            >
              <SectionHeader
                section={s}
                heading={heading}
                isOpen={isOpen}
                forceExpanded={false}
                lineCount={t.count}
                vendorTotal={t.vendor}
                clientTotal={t.client}
                tenantTotal={t.tenant}
                photosCount={photos.length}
                photosMissing={photosMissing}
                onToggle={() => setExpanded((m) => ({ ...m, [s.id]: !isOpen }))}
                onRename={(label) => handleRenameSection(s.id, label)}
                onDelete={() => handleDeleteSection(s.id)}
                readOnly={!!props.readOnly}
              />
              {isOpen && (
                <div className="border-t border-gray-100">
                  {/* Section photos — compact single-row layout (Take/Upload on
                      the right on every state, like the "added" state). */}
                  <div className={`px-3 py-1.5 ${photosMissing ? 'bg-amber-50' : 'bg-gray-50'} border-b border-gray-100`}>
                    <div className="flex items-center justify-between gap-2">
                      {/* Whole left area is the collapse toggle — clicking the
                          empty white space (up to the Take button) toggles too. */}
                      <button
                        type="button"
                        onClick={() => setPhotosCollapsed((c) => ({ ...c, [s.id]: !c[s.id] }))}
                        aria-expanded={!photosCollapsed[s.id]}
                        className="flex-1 flex items-baseline gap-2 min-w-0 text-left py-0.5"
                      >
                        <span className="flex items-baseline gap-1.5 min-w-0">
                          <span className={`text-gray-400 text-[10px] self-center transition-transform ${photosCollapsed[s.id] ? '' : 'rotate-90'}`}>&#9654;</span>
                          <span className="text-xs font-semibold text-gray-700 uppercase tracking-wide whitespace-nowrap">
                            Photos
                            {photosRequired
                              ? <span className="text-brand ml-1">*</span>
                              : <span className="text-gray-400 normal-case font-normal ml-1">(Optional)</span>}
                          </span>
                        </span>
                        {photosMissing && !isUploadingHere && (
                          <span className="text-xs text-amber-800 font-semibold whitespace-nowrap">&ge;1 Required</span>
                        )}
                        {isUploadingHere && (
                          <span className="text-xs text-brand font-semibold whitespace-nowrap">
                            {uploadingSection!.current}/{uploadingSection!.total}…
                          </span>
                        )}
                        {photos.length > 0 && !photosMissing && !isUploadingHere && (
                          <span className="text-xs text-gray-500 whitespace-nowrap">{photos.length} added</span>
                        )}
                      </button>
                      {!props.readOnly && (
                        <div className="flex gap-2 items-center shrink-0">
                          {/* Single capture entry. Opens IMMEDIATELY — never gated
                              on warm-up or connectivity (the camera + shutter work
                              cold/offline; offline shots cache and sync later, and
                              the AI layer degrades gracefully). Progressive UI: it
                              starts as a plain "Take" + camera icon, then once
                              warm-up finishes in the BACKGROUND the border flashes
                              once and it morphs into the AI camera+spark hybrid. */}
                          <button
                            type="button"
                            onClick={() => { setAiCameraMode(true); setCameraSectionId(s.id); }}
                            disabled={isUploadingHere}
                            className={`inline-flex items-center gap-1 text-xs text-white font-semibold py-1 px-2.5 rounded disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors duration-300 ${aiCamWarmed ? 'bg-violet-600 hover:bg-violet-700' : 'bg-brand hover:bg-brand-dark'} ${warmFlash ? 'animate-borderFlash' : ''}`}
                            title={aiCamWarmed ? 'Take — AI camera with live call-outs as you talk and pan' : 'Take — opens now; AI call-outs switch on in a moment'}
                          >
                            {aiCamWarmed ? (
                              // Camera + AI spark hybrid — AI call-outs are ready.
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3l2-3h5l1.2 1.8" />
                                <circle cx="11" cy="13.5" r="3.2" />
                                <path d="M19 2.5l.85 2.15L22 5.5l-2.15.85L19 8.5l-.85-2.15L16 5.5l2.15-.85z" fill="currentColor" stroke="none" />
                              </svg>
                            ) : (
                              // Plain camera — AI still warming in the background.
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                                <circle cx="12" cy="13" r="4" />
                              </svg>
                            )}
                            Take
                          </button>
                        </div>
                      )}
                    </div>
                    {photos.length > 0 && !photosCollapsed[s.id] && (
                      <div className="flex gap-1.5 overflow-x-auto pb-1 mt-2 -mx-0.5 px-0.5">
                        {photos.map((url, idx) => (
                          // Tagged photos live on their line card, not the room strip.
                          taggedSet.has(url) ? null : (
                          <div key={url} className="relative shrink-0">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={displayImageSrc(url)}
                              alt=""
                              onClick={() => setLightbox({ kind: 'section', sectionId: s.id, index: idx })}
                              className="w-16 h-16 object-cover rounded border border-gray-200 cursor-pointer"
                              title={isVideoEntry(url) ? 'Tap to play, tag, or delete' : 'Tap to view, mark up, or delete'}
                            />
                            {isVideoEntry(url) && (
                              <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                <span className="w-6 h-6 rounded-full bg-black/55 flex items-center justify-center">
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z" /></svg>
                                </span>
                              </span>
                            )}
                            {url.startsWith('blob:') && (
                              <span
                                className="absolute bottom-0 inset-x-0 bg-amber-500/95 text-white text-[8px] font-heading font-bold text-center leading-tight py-0.5 rounded-b pointer-events-none"
                                title="Saved Offline · Will Sync When Online"
                              >Saved Offline</span>
                            )}
                            {!props.readOnly && (
                              <button
                                type="button"
                                onClick={() => removePhoto(s.id, idx)}
                                className="absolute -top-1 -right-1 bg-ink text-white text-xs w-4 h-4 rounded-full leading-none flex items-center justify-center hover:bg-brand"
                              >&times;</button>
                            )}
                          </div>
                          )
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Lines table */}
                  {(lines.length > 0 || pendingNewBySection[s.id]) ? (
                    <div className={isMobile ? '' : 'overflow-x-auto'}>
                      <table className={`w-full text-sm ${isMobile ? 'table-fixed' : ''}`}>
                        <thead className={`bg-gray-50 border-b border-gray-200 ${isMobile ? 'hidden' : ''}`}>
                          <tr className="text-xs text-gray-600 uppercase tracking-wide">
                            <th className="text-center px-3 py-2 whitespace-nowrap">Category</th>
                            <th className="text-center px-3 py-2 whitespace-nowrap">Sub</th>
                            <th className="text-left px-3 py-2">Line Item</th>
                            <th className="text-center px-3 py-2 whitespace-nowrap">Qty</th>
                            <th className="text-center px-3 py-2 whitespace-nowrap">Unit</th>
                            <th className="text-center px-3 py-2 whitespace-nowrap">Vendor</th>
                            <th className="text-right px-3 py-2 whitespace-nowrap">Vendor $</th>
                            <th className="text-right px-3 py-2 whitespace-nowrap">Client $</th>
                            <th className="text-center px-3 py-2 whitespace-nowrap">Ten %</th>
                            <th className="text-right px-3 py-2 whitespace-nowrap">Tenant $</th>
                            <th className="px-2 py-2"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {lines.map((line) => (
                            <EditableLineRow
                              key={line.externalId}
                              line={line}
                              catalog={catalog}
                              catalogByCode={catalogByCode}
                              regions={regions}
                              inspectionRegion={inspectionRegion}
                              section={s.label}
                              location={s.location}
                              readOnly={props.readOnly}
                              mobile={isMobile}
                              tenantMonths={typeof props.lastTenantMonths === 'number' ? props.lastTenantMonths : 12}
                              afterPhotosEnabled={afterPhotosEnabled}
                              onCaptureAfterPhotos={() => setAfterCameraTarget({ sectionId: s.id, lineExternalId: line.externalId })}
                              onOpenAfterPhoto={(index) => setLightbox({ kind: 'after', sectionId: s.id, externalId: line.externalId, index })}
                              resolutionTiming={resolutionTimings[line.externalId]}
                              onSetResolutionTiming={setLineTiming}
                              onSave={(updated) => handleSaveLineForSection(s.id, updated)}
                              onDelete={() => handleDeleteLine(s.id, line.externalId)}
                              onOpenPhoto={(index) => {
                                // Open the unified SECTION viewer (all the room's
                                // photos, room selector on top, tag/untag on the
                                // bottom) positioned on the clicked line photo.
                                const url = (line.photoUrls || [])[index];
                                const secIdx = (photosBySection[s.id] || []).indexOf(url);
                                setLightbox(secIdx >= 0
                                  ? { kind: 'section', sectionId: s.id, index: secIdx }
                                  : { kind: 'line', sectionId: s.id, externalId: line.externalId, index });
                              }}
                              onEditingChange={(o) => setEditorOpen(`${s.id}:${line.externalId}`, o)}
                            />
                          ))}
                          {pendingNewBySection[s.id] && (
                            <EditableLineRow
                              key={`__new__${s.id}_${newRowNonce[s.id] || 0}`}
                              line={null}
                              catalog={catalog}
                              catalogByCode={catalogByCode}
                              regions={regions}
                              inspectionRegion={inspectionRegion}
                              section={s.label}
                              location={s.location}
                              readOnly={props.readOnly}
                              mobile={isMobile}
                              startInEditMode
                              autoSfQuantity={/whole\s*house/i.test(s.label) && props.squareFootage ? props.squareFootage : null}
                              tenantMonths={typeof props.lastTenantMonths === 'number' ? props.lastTenantMonths : 12}
                              afterPhotosEnabled={afterPhotosEnabled}
                              onSetResolutionTiming={setLineTiming}
                              onSave={(created) => handleSaveLineForSection(s.id, created)}
                              onDelete={() => handleDiscardNew(s.id)}  /* unused for new rows (no view-mode), kept for typing */
                              onDiscardNew={() => handleDiscardNew(s.id)}
                              onEditingChange={(o) => setEditorOpen(`${s.id}:new`, o)}
                            />
                          )}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="px-4 py-6 text-sm text-gray-500 text-center">No line items yet.</div>
                  )}
                  {!props.readOnly && (
                    <div className="px-4 py-3 border-t border-gray-100 bg-gray-50">
                      <button
                        type="button"
                        onClick={() => handleAddLine(s)}
                        disabled={dataLoading}
                        className="px-3 py-1.5 text-sm bg-brand text-white rounded hover:bg-brand-dark disabled:bg-gray-300"
                      >
                        {dataLoading ? 'Loading...' : '+ Add Line Item'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </section>
          );
        })}

        {/* Final Checklist — another room-style bubble at the very end of the
            scope form. Editable whenever the form is (readOnly = props.readOnly,
            i.e. NOT completed/cancelled) — so during pending_approval the FC stays
            editable like the room photos/lines (you can fix/delete FC photos and
            answers in review). Only completed/cancelled lock it. `fcEditable`
            still gates the pre-submit completeness requirement, not editability. */}
        {fcVisible && (
          <FinalChecklist
            answers={fcAnswers}
            onPatch={handleFcPatch}
            uploadPhoto={(file, fieldKey) => uploadPhotoOrQueue(file, props.inspectionRecordId, FC_PHOTO_SECTION, { lineExternalId: fieldKey })}
            propertyName={props.propertyName}
            propertyRecordId={props.propertyRecordId}
            propertyValues={fcPropertyValues}
            filterSizeOptions={props.filterSizeOptions}
            lineExists={fcLineExists}
            onAddLine={handleFcAddLine}
            onUndoLine={(externalId) => handleFcUndoLine(externalId)}
            onRemoveLineByCode={handleFcRemoveByCode}
            onCameraOverlayChange={setCameraOverlayOpen}
            open={fcOpen}
            onToggleOpen={() => setFcOpen((o) => !o)}
            readOnly={!!props.readOnly}
          />
        )}
      </div>

      {/* Spacer below the last section. Small by default (footer height + a
          cushion) so there's no wasted white space; grows to ~a viewport only
          while we're scrolling to the last section, so a line added there can
          still rise to the top. Collapses back when we navigate elsewhere. */}
      <div style={{ height: expandTailSpace ? '85vh' : footerH + 16 }} />

      {/* Floating footer — visible on all screen sizes, pinned to the bottom of
          the viewport so the inspector can save/submit/cancel from anywhere.
          The voice assistant lives in the CENTER of this footer: a mic icon that
          expands upward into the conversation panel when pressed. */}
      <div ref={footerRef} className="fixed bottom-0 inset-x-0 bg-white border-t-2 border-gray-200 shadow-[0_-4px_10px_rgba(0,0,0,0.05)] z-30">
        <div ref={actionRowRef} className="max-w-7xl mx-auto px-3 sm:px-4 py-2.5 sm:py-3 flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <TerminalActions
              readOnly={!!props.readOnly}
              showCancelInspection={!!props.onCancelInspection}
              submitLabel={submitLabel}
              submitLabelShort={submitLabelShort}
              submitDisabled={!!props.readOnly || saveStatus.kind === "saving" || finalizing || submitting || aiApplying || (pendingSync + pendingPhotos) > 0 || selfApprovalLocked || (fcEditable && !finalChecklistComplete)}
              submitTitle={
                props.readOnly ? undefined
                : saveStatus.kind === 'saving' ? 'Saving — wait a moment, then submit.'
                : finalizing ? 'Finalizing…'
                : aiApplying ? 'Applying AI review…'
                : (pendingSync + pendingPhotos) > 0 ? 'Waiting for offline changes to finish syncing.'
                : (fcEditable && fcGap) ? `Finish the Final Checklist — ${fcGap}`
                : (isScopeTemplate && props.inspectionStatus !== 'pending_approval' && !reviewValid) ? 'Run the AI Review before submitting.'
                : undefined
              }
              onBlockedSubmit={(reason) => flashApi.flash(reason, 'info', 6000)}
              selfApprovalLocked={selfApprovalLocked}
              onCancelInspection={handleCancelInspectionClick}
              onSaveAndClose={handleSaveAndClose}
              onSubmit={handleSubmitOrFinalize}
              aiSlot={isScopeTemplate && !props.readOnly ? (
                <button
                  type="button"
                  onClick={() => { if (aiAdjustments.length > 0 && !aiModalOpen) setAiModalOpen(true); else void runAiReview(); }}
                  disabled={aiLoading}
                  title={reviewValid ? 'AI Review complete — tap to re-run' : aiAdjustments.length > 0 ? 'AI Review in progress — tap to resume' : 'Run AI Review (required before submit)'}
                  aria-label="AI Review"
                  className={`relative shrink-0 w-10 h-10 rounded-full flex items-center justify-center border-2 transition disabled:opacity-50 ${reviewValid ? 'border-emerald-400 text-emerald-600 bg-emerald-50' : 'border-brand text-brand bg-brand/5 hover:bg-brand/10'}`}
                >
                  <span className="text-base leading-none" aria-hidden>✦</span>
                  {/* Kicker: green check when reviewed for the current scope; amber pulse when pending. */}
                  <span className={`absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full flex items-center justify-center ring-2 ring-white ${reviewValid ? 'bg-emerald-500 text-white' : 'bg-amber-500'}`}>
                    {reviewValid
                      ? <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                      : <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />}
                  </span>
                </button>
              ) : undefined}
            />
          </div>
        </div>
      </div>

      <AiReviewModal
        open={aiModalOpen}
        loading={aiLoading}
        streaming={aiStreaming}
        applying={aiApplying}
        error={aiError}
        summary={aiSummary}
        adjustments={aiAdjustments}
        onClose={() => setAiModalOpen(false)}
        onRetry={() => runAiReview()}
        onApply={(approved) => {
          // Remember every item the user decided on (approve OR decline) so a
          // later re-review of this inspection doesn't re-flag the same call-outs.
          try {
            const sigs = aiAdjustments.filter((a) => aiDecisions[a.id]).map((a) => reviewSignature(a));
            addReviewedItems(props.inspectionRecordId, sigs);
          } catch { /* non-fatal */ }
          applyApproved(approved);
        }}
        previewTenantDollars={previewTenantDollars}
        onAddPhoto={addPhotoForAdjustment}
        onAddLineItems={addLineItemsForReview}
        onIgnore={(a) => { if (a.lineExternalId) addIgnoredPhotoLine(props.inspectionRecordId, a.lineExternalId); }}
        initialDecisions={aiDecisions}
        onDecisionsChange={setAiDecisions}
        inspectionId={props.inspectionRecordId}
        rooms={sections.map((s) => ({ id: s.id, name: s.displayName || s.label }))}
        cameraOpen={!!aiCameraTarget || aiAddItemsOpen}
      />
      <InspectionAuditTrail
        open={showAuditTrail}
        onClose={() => setShowAuditTrail(false)}
        inspectionId={props.inspectionRecordId}
      />
      {/* AI review "Decline — Add Items": the manual Add Line Item editor, added
          to Whole House. The review modal hides while it's open (cameraOpen). */}
      {aiAddItemsOpen && (() => {
        const wh = fcWholeHouseSection() || sections[0];
        if (!wh) { finishAiAddItems(0); return null; }
        return (
          <table className="absolute w-0 h-0 overflow-hidden">
            <tbody>
              <EditableLineRow
                mobile
                startInEditMode
                line={null}
                catalog={catalog}
                catalogByCode={catalogByCode}
                regions={regions}
                inspectionRegion={inspectionRegion}
                section={wh.label}
                location={wh.location || ''}
                tenantMonths={typeof props.lastTenantMonths === 'number' ? props.lastTenantMonths : 12}
                autoSfQuantity={/whole\s*house/i.test(wh.label) && props.squareFootage ? props.squareFootage : null}
                onSave={(line) => { void handleSaveLineForSection(wh.id, line); finishAiAddItems(1); }}
                onDelete={() => finishAiAddItems(0)}
                onDiscardNew={() => finishAiAddItems(0)}
              />
            </tbody>
          </table>
        );
      })()}
      {/* In-app camera for the review popup's "Add photo" (same as the Take
          button): single room, captured photo auto-attaches to the room + tags
          the flagged line. The review modal hides while this is open. */}
      {aiCameraTarget && (
        <CameraCapture
          isOpen
          addressSnapshot={props.propertyName}
          propertyRecordId={props.propertyRecordId}
          onComplete={(urls) => { void handleAiCameraComplete(urls); }}
          onClose={handleAiCameraClose}
          uploadPhoto={(file) => uploadPhotoOrQueue(file, props.inspectionRecordId, aiCameraTarget.sectionId)}
          uploadVideoEntry={(videoFile, posterFile) => uploadVideoEntryOrQueue(videoFile, posterFile, props.inspectionRecordId, aiCameraTarget.sectionId)}
          rooms={(() => { const s = sections.find((x) => x.id === aiCameraTarget.sectionId); return [{ id: aiCameraTarget.sectionId, name: s?.displayName || s?.label || 'Room', photoCount: (photosBySection[aiCameraTarget.sectionId] || []).length, needsPhotos: false }]; })()}
          currentRoomId={aiCameraTarget.sectionId}
        />
      )}
      {/* In-app camera for an Internal Resolution line's After Photos. Online
          uploader (real URLs only); captures append to the line's afterPhotoUrls
          and save. Not added to the section photo pool. */}
      {afterCameraTarget && (
        <CameraCapture
          isOpen
          addressSnapshot={props.propertyName}
          propertyRecordId={props.propertyRecordId}
          onComplete={(urls) => { const t = afterCameraTarget; setAfterCameraTarget(null); void handleAfterPhotoCapture(t, urls); }}
          uploadVideoEntry={(videoFile, posterFile) => uploadVideoEntryOrQueue(videoFile, posterFile, props.inspectionRecordId, afterCameraTarget.sectionId)}
          onClose={() => setAfterCameraTarget(null)}
          // Use the offline-aware, fail-fast uploader (12s × 2 + offline cache)
          // instead of the raw uploader (3 × 20s) so after-photos don't hang on a
          // weak signal. Tagged with the line so a queued draft attaches on sync.
          uploadPhoto={(file) => uploadPhotoOrQueue(file, props.inspectionRecordId, afterCameraTarget.sectionId, { lineExternalId: afterCameraTarget.lineExternalId })}
          rooms={(() => { const s = sections.find((x) => x.id === afterCameraTarget.sectionId); return [{ id: afterCameraTarget.sectionId, name: `${s?.displayName || s?.label || 'Room'} — After`, photoCount: 0, needsPhotos: false }]; })()}
          currentRoomId={afterCameraTarget.sectionId}
        />
      )}

      {cameraSectionId !== null && (
        <CameraCapture
          isOpen={true}
          addressSnapshot={props.propertyName}
          propertyRecordId={props.propertyRecordId}
          onComplete={handleCameraComplete}
          onClose={() => { setCameraSectionId(null); setAiCameraMode(false); }}
          // All-in-one AI camera (Beta): when opened via the Beta button, layer
          // always-listening voice + real-time call-out chips onto the full
          // camera. The Take button leaves this off → unchanged camera.
          aiAssist={aiCameraMode}
          aiRegion={inspectionRegion}
          aiCatalog={catalog}
          aiRegions={regions}
          aiTenantMonths={typeof props.lastTenantMonths === 'number' ? props.lastTenantMonths : 12}
          onAiAddLine={(sid, line) => { const p = handleSaveLineForSection(sid, line); revealSection(sid, line.externalId); return p; }}
          onAiStill={(sid, url) => {
            if (!url || url.startsWith('blob:')) return;
            const base = photosBySectionRef.current[sid] || [];
            const next = Array.from(new Set([...base, url]));
            setPhotosBySection((m) => ({ ...m, [sid]: next }));
            void savePhotosForSection(sid, next);
          }}
          // Queue-aware: offline captures become local drafts and sync later.
          // Targets the camera's active room so a queued blob is attributed right.
          uploadPhoto={(file) => uploadPhotoOrQueue(file, props.inspectionRecordId, cameraSectionId || currentSectionId)}
          uploadVideoEntry={(videoFile, posterFile) => uploadVideoEntryOrQueue(videoFile, posterFile, props.inspectionRecordId, cameraSectionId || currentSectionId)}
          rooms={sections.map((s) => {
            const count = (photosBySection[s.id] || []).length;
            return {
              id: s.id,
              name: s.displayName || s.label,
              photoCount: count,
              needsPhotos: !s.photoOptional && !sectionPhotoExempt(s.displayName || s.label) && count === 0,
            };
          })}
          currentRoomId={cameraSectionId}
          onRoomChange={handleCameraRoomChange}
          tagLines={cameraSectionId
            ? (linesBySection[cameraSectionId] || []).map((l) => ({ externalId: l.externalId, label: lineLabel(l) }))
            : []}
          onTagPhotoToLine={tagCameraPhotoToLine}
          onOverlayChange={setCameraOverlayOpen}
          onRenameRoom={(roomId, newName) => handleRenameSection(roomId, newName)}
          onAddRoom={(name) => handleAddSection(name)}
          onDeleteRoom={async (roomId) => {
            const idx = sections.findIndex((s) => s.id === roomId);
            const neighbor = sections[idx + 1] || sections[idx - 1];
            const deleted = await handleDeleteSection(roomId);
            // If the deleted room was the camera's active room, move to a
            // neighbor (or close the camera if it was the only room).
            if (deleted && roomId === cameraSectionId) {
              setCameraSectionId(neighbor ? neighbor.id : null);
            }
          }}
        />
      )}

      {/* Voice assistant — ONE persistent instance so a conversation started in
          the camera keeps going after Done (and vice-versa). It floats above
          everything (z over the camera); the mic sits bottom-right while the
          camera is open and bottom-center otherwise. Targets the camera's active
          room when open, else the focused section. */}
      {(() => {
        const voiceSectionId = cameraSectionId ?? currentSectionId;
        if (props.readOnly || props.templateType !== 'pm_scope_rate_card' || !voiceSectionId) return null;
        const cameraOpen = cameraSectionId !== null;
        // The mic lives only on the bare form + the bare camera. Over ANY other
        // overlay (form modals, the in-camera photo viewer/markup editor) it
        // hides — UNLESS a conversation is actively engaged. Kept MOUNTED via
        // display:none so an in-progress conversation is never lost.
        const overlayOpen = lightbox !== null
          || showSectionsManager
          || finalizeResult !== null
          || showSaveErrorDetail
          || openEditors.size > 0
          || cameraOverlayOpen
          || aiModalOpen          // AI review popup
          || aiCameraTarget !== null // AI review's in-app camera
          || aiAddItemsOpen          // AI review's "Add Items" line editor
          || afterCameraTarget !== null // Internal Resolution after-photo camera
          || (cameraOpen && aiCameraMode); // All-in-one AI camera owns its own always-listening mic
        const hidden = overlayOpen && !voiceEngaged;
        return (
          <div
            className="fixed inset-x-0 z-[60] pointer-events-none"
            style={{
              // In the form, center the 44px mic on the footer button row; in the
              // camera, sit ON the shutter-control line at the bottom-LEFT.
              bottom: cameraOpen ? 34 : Math.max(6, Math.round(actionRowH / 2 - 22)),
              display: hidden ? 'none' : undefined,
            }}
          >
            <div
              className="relative max-w-7xl mx-auto px-4 flex pointer-events-none"
              style={{ justifyContent: cameraOpen ? 'flex-start' : 'center' }}
            >
              <span className="pointer-events-auto">
                <VoiceLineAssistant
                  sections={sections.map((s) => ({ id: s.id, label: s.label, location: s.location, displayName: s.displayName }))}
                  currentSectionId={voiceSectionId}
                  inspectionId={props.inspectionRecordId}
                  onNavigate={(id) => { if (cameraOpen) setCameraSectionId(id); else navigateToSection(id); }}
                  region={inspectionRegion}
                  disabled={dataLoading}
                  currentLines={linesBySection[voiceSectionId] || []}
                  catalog={catalog}
                  tenantMonths={typeof props.lastTenantMonths === 'number' ? props.lastTenantMonths : 12}
                  squareFootage={props.squareFootage}
                  onAddLine={(line) => { const p = handleSaveLineForSection(voiceSectionId, line); if (!cameraOpen) revealSection(voiceSectionId, line.externalId); return p; }}
                  onRemoveLine={(externalId) => handleDeleteLine(voiceSectionId, externalId)}
                  onAddLineTo={(sectionId, line) => { const p = handleSaveLineForSection(sectionId, line); if (!cameraOpen) revealSection(sectionId, line.externalId); return p; }}
                  onRemoveLineFrom={(sectionId, externalId) => handleDeleteLine(sectionId, externalId)}
                  onMoveLine={(fromSectionId, toSectionId, line) => handleMoveLineToSection(fromSectionId, toSectionId, line)}
                  linesBySection={linesBySection}
                  onEngagedChange={setVoiceEngaged}
                />
              </span>
            </div>
          </div>
        );
      })()}

      {showSectionsManager && (
        <SectionsManager
          sections={sections}
          lineCounts={Object.fromEntries(sections.map((s) => [s.id, (linesBySection[s.id] || []).length]))}
          photoCounts={Object.fromEntries(sections.map((s) => [s.id, (photosBySection[s.id] || []).length]))}
          onClose={() => setShowSectionsManager(false)}
          onRename={handleRenameSection}
          onDelete={(id) => handleDeleteSection(id)}
          onAdd={handleAddSection}
          onReorder={handleReorderSections}
          onClearSections={handleClearSections}
        />
      )}

      {lightbox && lightbox.kind === 'section' && (
        <PhotoLightbox
          groups={sections.map((s) => ({ id: s.id, name: s.displayName || s.label }))}
          photosByGroup={photosBySection}
          initialGroupId={lightbox.sectionId}
          initialIndex={lightbox.index}
          readOnly={!!props.readOnly}
          onClose={() => setLightbox(null)}
          onDelete={(sectionId, index) => removePhoto(sectionId, index)}
          onReplace={(sectionId, index, file) => replaceSectionPhoto(sectionId, index, file)}
          tagLinesByGroup={Object.fromEntries(
            sections.map((s) => [s.id, (linesBySection[s.id] || []).map((l) => ({ externalId: l.externalId, label: lineLabel(l) }))])
          )}
          onTagToLine={(sectionId, index, externalId) => tagPhotoToLine(sectionId, index, externalId)}
          onUntagFromLine={(sectionId, index, externalId) => untagPhotoFromLine(sectionId, index, externalId)}
          currentTagsFor={(sectionId, index) => currentTagsForSection(sectionId, index)}
        />
      )}
      {lightbox && lightbox.kind === 'line' && (() => {
        const line = (linesBySection[lightbox.sectionId] || []).find((l) => l.externalId === lightbox.externalId);
        return (
          <PhotoLightbox
            groups={[{ id: lightbox.externalId, name: line ? lineLabel(line) : 'Line photos' }]}
            photosByGroup={{ [lightbox.externalId]: line?.photoUrls || [] }}
            initialGroupId={lightbox.externalId}
            initialIndex={lightbox.index}
            readOnly={!!props.readOnly}
            onClose={() => setLightbox(null)}
            onDelete={(_g, index) => deleteLinePhoto(lightbox.sectionId, lightbox.externalId, index)}
            onReplace={(_g, index, file) => replaceLinePhoto(lightbox.sectionId, lightbox.externalId, index, file)}
          />
        );
      })()}
      {lightbox && lightbox.kind === 'after' && (() => {
        const line = (linesBySection[lightbox.sectionId] || []).find((l) => l.externalId === lightbox.externalId);
        return (
          <PhotoLightbox
            groups={[{ id: lightbox.externalId, name: line ? `${lineLabel(line)} — After Photos` : 'After photos' }]}
            photosByGroup={{ [lightbox.externalId]: line?.afterPhotoUrls || [] }}
            initialGroupId={lightbox.externalId}
            initialIndex={lightbox.index}
            readOnly={!!props.readOnly}
            onClose={() => setLightbox(null)}
            onDelete={(_g, index) => deleteAfterPhoto(lightbox.sectionId, lightbox.externalId, index)}
            onReplace={(_g, index, file) => replaceAfterPhoto(lightbox.sectionId, lightbox.externalId, index, file)}
          />
        );
      })()}

      {/* Save-error detail modal. Triggered by clicking the "Save failed"
          badge in the sticky header. Shows the raw error message returned
          by the API so the inspector can report it (or fix it) instead of
          just seeing "Save failed". */}
      {showSaveErrorDetail && saveStatus.kind === 'error' && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full">
            <div className="px-5 py-4 border-b border-gray-200">
              <div className="text-base font-bold text-red-700">Save failed</div>
              <div className="text-xs text-gray-500 mt-0.5">
                The last save attempt to HubSpot didn&apos;t complete.
              </div>
            </div>
            <div className="px-5 py-4 space-y-3">
              <div>
                <div className="text-xs uppercase tracking-wider font-semibold text-gray-500 mb-1">
                  Error message
                </div>
                <div className="text-sm text-gray-800 bg-gray-50 border border-gray-200 rounded p-2 font-mono whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
                  {saveStatus.message || '(no message captured)'}
                </div>
              </div>
              <div className="text-xs text-gray-600">
                What to try:
                <ul className="list-disc pl-5 mt-1 space-y-0.5">
                  <li>Try the same edit again — transient errors often resolve themselves.</li>
                  <li>If a specific line keeps failing, delete and re-add it.</li>
                  <li>If it&apos;s persistent, copy the message above and send it to Hayden.</li>
                </ul>
              </div>
            </div>
            <div className="px-5 py-4 border-t border-gray-200 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  if (saveStatus.kind === 'error' && saveStatus.message) {
                    navigator.clipboard?.writeText(saveStatus.message).catch(() => {});
                  }
                }}
                className="px-3 py-1.5 text-xs border border-gray-300 rounded text-gray-700 hover:bg-gray-50"
              >
                Copy error
              </button>
              <button
                type="button"
                onClick={() => setShowSaveErrorDetail(false)}
                className="px-4 py-2 text-sm bg-brand text-white font-semibold rounded hover:bg-brand-dark"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Generating overlay: blocks the form while finalize is running.
          The render itself can take 15-40 seconds for inspections with lots
          of photos so we want a clear "don't do anything" indicator. */}
      {finalizing && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 max-w-md mx-4 text-center">
            <div className="text-brand text-base font-semibold mb-2">Generating PDFs...</div>
            <div className="text-sm text-gray-700">
              This may take 15-30 seconds depending on how many photos are attached.
              Please don&apos;t close this tab.
            </div>
            <div className="mt-4 h-1 bg-gray-200 rounded overflow-hidden">
              <div className="h-full bg-brand animate-pulse" style={{ width: '60%' }} />
            </div>
          </div>
        </div>
      )}

      {/* Result modal: shown after finalize succeeds. Lists all generated
          PDFs with download buttons. The inspector can also dismiss it,
          which navigates back to the list (the inspection is now Completed). */}
      {finalizeResult && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
            <div className="px-5 py-4 border-b border-gray-200">
              <div className="text-lg font-bold text-emerald-700 flex items-center gap-2">
                <span>✓ Inspection Finalized</span>
              </div>
              <div className="text-xs text-gray-500 mt-0.5">
                {finalizeResult.totals.lineCount} {finalizeResult.totals.lineCount === 1 ? 'line item' : 'line items'} ·
                Tenant Total: <span className="text-brand font-semibold">${finalizeResult.totals.tenant.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              </div>
            </div>

            {/* Email status banner — shown right under the header. Three states:
                  sent (emerald)     — the notification email went out
                  not_connected (amber) — Gmail not connected yet, click to connect
                  send_failed (red)  — Gmail accepted us but the message bounced */}
            {finalizeResult.email && (
              <div className={`px-5 py-3 border-b ${
                finalizeResult.email.sent
                  ? 'bg-emerald-50 border-emerald-200'
                  : finalizeResult.email.reason === 'gmail_not_configured' || finalizeResult.email.reason === 'gmail_not_connected'
                    ? 'bg-amber-50 border-amber-200'
                    : 'bg-red-50 border-red-200'
              }`}>
                {finalizeResult.email.sent ? (
                  <>
                    <div className="text-xs font-bold text-emerald-700 uppercase tracking-wider">Email Sent</div>
                    {finalizeResult.email.recipients && (
                      <div className="text-xs text-emerald-900 mt-1">
                        To: <span className="font-mono">{finalizeResult.email.recipients.to.join(', ')}</span>
                        {finalizeResult.email.recipients.cc.length > 0 && (
                          <> · CC: <span className="font-mono">{finalizeResult.email.recipients.cc.join(', ')}</span></>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="text-xs font-bold text-amber-800 uppercase tracking-wider">
                      Email Not Sent
                    </div>
                    <div className="text-xs text-amber-900 mt-1">
                      {finalizeResult.email.message || 'Reason unknown.'}
                    </div>
                    {finalizeResult.email.recipients && (
                      <div className="text-xs text-amber-900 mt-1 opacity-80">
                        Would have gone to: <span className="font-mono">{finalizeResult.email.recipients.to.join(', ')}</span>
                        {finalizeResult.email.recipients.cc.length > 0 && (
                          <>, <span className="font-mono">{finalizeResult.email.recipients.cc.join(', ')}</span></>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Maintenance ticket banner — only when the integration is
                configured. Shows the created ticket # with a direct link, or
                the failure reason. */}
            {finalizeResult.maintenanceTicket && finalizeResult.maintenanceTicket.configured && (
              <div className={`px-5 py-3 border-b ${finalizeResult.maintenanceTicket.ok ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
                {finalizeResult.maintenanceTicket.ok ? (
                  <>
                    <div className="text-xs font-bold text-emerald-700 uppercase tracking-wider">
                      Maintenance Ticket Created{finalizeResult.maintenanceTicket.ticketId ? ` #${finalizeResult.maintenanceTicket.ticketId}` : ''}
                    </div>
                    {finalizeResult.maintenanceTicket.url && (
                      <a
                        href={finalizeResult.maintenanceTicket.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-brand underline font-semibold mt-1 inline-block"
                      >
                        View ticket in HoneyBadger →
                      </a>
                    )}
                  </>
                ) : (
                  <>
                    <div className="text-xs font-bold text-red-700 uppercase tracking-wider">Maintenance Ticket Not Created</div>
                    <div className="text-xs text-red-900 mt-1">{finalizeResult.maintenanceTicket.error || 'Reason unknown.'}</div>
                  </>
                )}
              </div>
            )}
            <div className="px-5 py-3 space-y-2">
              <div className="flex items-center justify-between mb-1">
                <div className="text-xs uppercase tracking-wider font-semibold text-gray-500">Downloads</div>
                <button
                  type="button"
                  onClick={async () => {
                    // Build the list once
                    const items: Array<{ name: string; url: string }> = [];
                    items.push(finalizeResult.pdfs.master);
                    if (finalizeResult.pdfs.chargeback) items.push(finalizeResult.pdfs.chargeback);
                    for (const v of finalizeResult.pdfs.vendors) items.push({ name: v.name, url: v.url });
                    // xlsx import file listed LAST.
                    if (finalizeResult.pdfs.chargebackXlsx) items.push(finalizeResult.pdfs.chargebackXlsx);
                    // Sequential awaits — each download finishes before the
                    // next starts. Avoids browser rate limiting / "too many
                    // downloads" blocks that fire when we trigger them all
                    // in parallel via setTimeout.
                    for (const item of items) {
                      await triggerDownload(item.url, item.name);
                      // Tiny delay so the browser registers each as a
                      // separate download event (helps Chrome counter UI)
                      await new Promise((r) => setTimeout(r, 250));
                    }
                  }}
                  className="text-xs px-3 py-1 bg-emerald-600 text-white font-semibold rounded hover:bg-emerald-700"
                  title="Download every PDF at once"
                >
                  ↓ Download All
                </button>
              </div>
              <DownloadLink label="Master Report" filename={finalizeResult.pdfs.master.name} url={finalizeResult.pdfs.master.url} primary />
              {finalizeResult.pdfs.chargeback && (
                <DownloadLink label="Tenant Chargeback (PDF)" filename={finalizeResult.pdfs.chargeback.name} url={finalizeResult.pdfs.chargeback.url} />
              )}
              {finalizeResult.pdfs.vendors.map((v) => (
                <DownloadLink
                  key={v.vendor}
                  label={`Vendor — ${v.vendor}`}
                  filename={v.name}
                  url={v.url}
                />
              ))}
              {/* xlsx import file listed LAST. */}
              {finalizeResult.pdfs.chargebackXlsx && (
                <DownloadLink label="Tenant Chargeback Import (xlsx)" filename={finalizeResult.pdfs.chargebackXlsx.name} url={finalizeResult.pdfs.chargebackXlsx.url} />
              )}
            </div>
            <div className="px-5 py-4 border-t border-gray-200 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setFinalizeResult(null);
                  props.onSubmit();
                }}
                className="px-4 py-2 text-sm bg-brand text-white font-semibold rounded hover:bg-brand-dark"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Single download row in the Finalize result modal. */
/**
 * The three terminal action buttons (Cancel Inspection / Save & Close /
 * Submit-or-Finalize). Used in both the mobile inline footer and the desktop
 * floating footer so behavior stays identical across the two.
 *
 * The parent owns all the click logic — this is purely presentational.
 */
function TerminalActions(props: {
  readOnly: boolean;
  showCancelInspection: boolean;
  submitLabel: string;
  submitLabelShort?: string;
  submitDisabled: boolean;
  /** Hover tooltip explaining WHY submit is disabled (the unmet gate). */
  submitTitle?: string;
  /** Tapping the greyed submit (mobile has no hover) flashes the reason. */
  onBlockedSubmit?: (reason: string) => void;
  /** When the submitter is viewing their own pending-approval submission:
   *  animate Save & Close (the only valid move) and explain why Finalize is
   *  greyed. The lock is permanent — a second reviewer must finalize. */
  selfApprovalLocked?: boolean;
  onCancelInspection: () => void;
  onSaveAndClose: () => void;
  onSubmit: () => void;
  voiceSlot?: React.ReactNode;
  aiSlot?: React.ReactNode;
}) {
  const locked = !!props.selfApprovalLocked;
  return (
    <div className="flex flex-col gap-1.5">
      {/* When the submitter is locked out, a one-line nudge spans the row so the
          intent is unmistakable: this is pending approval — just Save & Close. */}
      {locked && (
        <div className="text-[11px] sm:text-xs text-emerald-700 font-medium text-center animate-[fadeIn_160ms_ease-out]">
          You submitted this — a second reviewer must finalize it. Tap <span className="font-bold">Save &amp; Close</span>.
        </div>
      )}
      <div className="flex items-center gap-2">
        {/* Left: Save & Close — pulsed when locked so it reads as THE button. */}
        <div className="flex-1 flex justify-start min-w-0">
          <button
            type="button"
            onClick={props.onSaveAndClose}
            className={`px-3.5 sm:px-5 py-2.5 text-sm rounded-lg font-semibold transition-colors whitespace-nowrap ${
              locked
                ? 'bg-emerald-600 text-white border border-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 animate-[saveNudge_1.4s_ease-in-out_infinite] motion-reduce:animate-none ring-2 ring-emerald-300'
                : 'border border-emerald-300 text-emerald-700 hover:bg-emerald-600 hover:text-white hover:border-emerald-600 active:bg-emerald-700 active:border-emerald-700'
            }`}
          >
            Save &amp; Close
          </button>
        </div>
        {/* Center: voice assistant mic — dead center because the left and right
            flex containers are equal-weight. */}
        <div className="shrink-0 flex justify-center">{props.voiceSlot}</div>
        {/* Right: AI Review icon (with status kicker) + Submit / Finalize */}
        <div className="flex-1 flex justify-end items-center gap-2 min-w-0">
          {props.aiSlot}
          {/* Submit. When blocked we DON'T use the native `disabled` attribute —
              we keep it tappable so a tap (mobile has no hover) flashes the gate
              message; desktop still gets the hover tooltip via the wrapping span. */}
          {(() => {
            const blockedMsg = locked
              ? `You submitted this for approval, so you can't approve it yourself — a second reviewer must finalize it. Use Save & Close.`
              : (props.submitTitle || 'Finish the required steps before you can submit.');
            const blocked = props.submitDisabled;
            return (
              <span className="inline-flex" title={blocked ? blockedMsg : undefined}>
                <button
                  type="button"
                  aria-disabled={blocked}
                  onClick={() => { if (blocked) { props.onBlockedSubmit?.(blockedMsg); return; } props.onSubmit(); }}
                  className={`px-4 sm:px-6 py-2.5 text-sm font-semibold rounded-lg transition-colors whitespace-nowrap ${
                    blocked
                      ? 'bg-gray-100 text-gray-400 border border-gray-200 cursor-not-allowed'
                      : 'bg-white border border-brand text-brand hover:bg-brand hover:text-white active:bg-brand-dark active:border-brand-dark active:text-white'
                  }`}
                >
                  <span className="sm:hidden">{props.submitLabelShort || props.submitLabel}</span>
                  <span className="hidden sm:inline">{props.submitLabel}</span>
                </button>
              </span>
            );
          })()}
        </div>
      </div>
    </div>
  );
}

/**
 * Trigger a single file download.
 *
 * For cross-origin URLs (HubSpot Files), the `<a download>` attribute is
 * routinely ignored by browsers — they navigate to the URL instead. To
 * reliably DOWNLOAD instead of NAVIGATE we fetch the file as a blob first,
 * then create a blob: URL (which IS same-origin from the browser's
 * perspective) and trigger an `<a download>` against that.
 *
 * Returns a promise so callers awaiting it can stagger correctly.
 */
async function triggerDownload(url: string, filename: string): Promise<void> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke after a tick so the click() has time to consume it
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } catch (e) {
    console.error('[triggerDownload] blob path failed, falling back to navigation:', e);
    // Last-ditch fallback: open in a new tab and let the user save from there
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

function DownloadLink(props: { label: string; filename: string; url: string; primary?: boolean; accent?: boolean }) {
  return (
    <a
      href={props.url}
      target="_blank"
      rel="noopener noreferrer"
      download={props.filename}
      className={
        'flex items-center justify-between px-3 py-2 rounded border text-sm hover:bg-gray-50 ' +
        (props.primary
          ? 'border-brand bg-brand/5 text-brand font-semibold'
          : props.accent
            ? 'border-emerald-300 bg-emerald-50 text-emerald-800 font-semibold'
            : 'border-gray-200 text-gray-700')
      }
    >
      <span className="truncate">{props.label}</span>
      <span className="ml-2 text-xs opacity-70 whitespace-nowrap">↓ Download</span>
    </a>
  );
}

// ---------------------------------------------------------------------------
// SectionHeader — collapsible header with inline rename + delete
// ---------------------------------------------------------------------------
interface SectionHeaderProps {
  section: SectionInstance;
  heading: string;
  isOpen: boolean;
  /** When true, the section can't be collapsed (e.g., it has line items). */
  forceExpanded: boolean;
  lineCount: number;
  vendorTotal: number;
  clientTotal: number;
  tenantTotal: number;
  photosCount: number;
  photosMissing: boolean;
  onToggle: () => void;
  onRename: (newLabel: string) => void;
  onDelete: () => void;
  readOnly: boolean;
}

function SectionHeader(p: SectionHeaderProps) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [draft, setDraft] = useState(p.section.label);
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit(e: React.MouseEvent) {
    e.stopPropagation();
    setDraft(p.section.label);
    setEditingTitle(true);
    setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 0);
  }
  function commit() {
    const cleaned = titleCaseSectionName(draft);
    if (cleaned && cleaned !== p.section.label) p.onRename(cleaned);
    setEditingTitle(false);
  }
  function cancel() { setEditingTitle(false); setDraft(p.section.label); }

  return (
    <div
      onClick={editingTitle || p.forceExpanded ? undefined : p.onToggle}
      className={`w-full px-4 py-3 bg-brand/5 border-b border-gray-200 ${
        editingTitle || p.forceExpanded ? '' : 'hover:bg-brand/10 cursor-pointer'
      }`}
    >
      {/* One responsive row. Desktop: room name + photo status on the left,
          totals pill pushed to the right — all on a single line (no wasted
          height). Mobile: the totals pill wraps below, and the room name
          TRUNCATES rather than wrapping so the line stays clean. */}
      <div className="flex items-center gap-2 min-w-0 flex-wrap">
        {/* Left group: name + photo status + edit/delete + chevron. Takes the
            remaining width; the name truncates inside it. */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {editingTitle ? (
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { e.preventDefault(); cancel(); }
                else if (e.key === 'Enter') { e.preventDefault(); commit(); }
              }}
              onClick={(e) => e.stopPropagation()}
              className="font-semibold text-gray-900 border border-brand rounded px-2 py-1 text-sm bg-white flex-1 min-w-0"
            />
          ) : (
            <div className="font-semibold text-gray-900 min-w-0 truncate text-sm sm:text-base">{p.heading}</div>
          )}
          {/* Photo status inline next to the room name. */}
          {!editingTitle && p.photosMissing && (
            <span title="Section photo required" className="text-amber-600 font-semibold text-xs whitespace-nowrap shrink-0">📷 Photos Needed</span>
          )}
          {!editingTitle && p.photosCount > 0 && (
            <span className="text-gray-500 text-xs whitespace-nowrap shrink-0">📷 {p.photosCount}</span>
          )}
          {/* Edit / delete / collapse controls — right-aligned to the edge of
              the name row (the X and chevron sit flush right). */}
          <div className="flex items-center gap-2 ml-auto shrink-0">
            {!p.readOnly && !editingTitle && (
              <>
                <button
                  type="button"
                  onClick={startEdit}
                  className="text-gray-400 hover:text-brand p-0.5 flex-shrink-0"
                  title="Rename section"
                  aria-label="Rename section"
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 1.5l3.5 3.5L5 14.5H1.5V11L11 1.5z" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); p.onDelete(); }}
                  className="text-gray-400 hover:text-red-600 p-0.5 flex-shrink-0 text-base leading-none"
                  title="Delete section"
                  aria-label="Delete section"
                >
                  ×
                </button>
              </>
            )}
            {!p.forceExpanded && (
              <span className="text-gray-400 flex-shrink-0">{p.isOpen ? '▾' : '▸'}</span>
            )}
          </div>
        </div>
        {/* Totals pill — centered on mobile (its own wrapped row), pushed to
            the right (with a little edge gap) on desktop. */}
        {p.lineCount > 0 && (
          <div className="w-full sm:w-auto sm:ml-auto sm:mr-1 flex justify-center sm:justify-end">
            <div className="flex items-stretch text-xs rounded-md bg-white border border-gray-200 overflow-hidden shrink-0">
            <div className="text-center px-2 py-1 w-[58px] sm:w-[84px]">
              <div className="text-gray-400 text-[10px] uppercase tracking-wide">Lines</div>
              <div className="font-semibold text-gray-700 tabular-nums mt-0.5">{p.lineCount}</div>
            </div>
            <div className="text-center px-2 py-1 w-[74px] sm:w-[96px] border-l border-gray-200/70">
              <div className="text-gray-400 text-[10px] uppercase tracking-wide">Vendor</div>
              <div className="font-semibold text-gray-700 tabular-nums mt-0.5">${formatMoney(roundMoney(p.vendorTotal))}</div>
            </div>
            <div className="text-center px-2 py-1 w-[74px] sm:w-[96px] border-l border-gray-200/70">
              <div className="text-gray-400 text-[10px] uppercase tracking-wide">Client</div>
              <div className="font-semibold text-gray-700 tabular-nums mt-0.5">${formatMoney(roundMoney(p.clientTotal))}</div>
            </div>
            <div className="text-center px-2 py-1 w-[74px] sm:w-[96px] border-l border-gray-200/70">
              <div className="text-brand/70 text-[10px] uppercase tracking-wide">Tenant</div>
              <div className="font-semibold text-brand tabular-nums mt-0.5">${formatMoney(roundMoney(p.tenantTotal))}</div>
            </div>
            <div className="text-center px-2 py-1 w-[74px] sm:w-[96px] border-l border-gray-200/70">
              <div className="text-emerald-600/70 text-[10px] uppercase tracking-wide">Net Turn</div>
              <div className="font-semibold text-emerald-700 tabular-nums mt-0.5">${formatMoney(roundMoney(p.clientTotal - p.tenantTotal))}</div>
            </div>
          </div>
          </div>
        )}
      </div>
    </div>
  );
}
