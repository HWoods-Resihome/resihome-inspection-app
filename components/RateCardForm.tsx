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
import { buildSectionPhotoAnswerProps } from '@/lib/answerProps';
import { VoiceLineAssistant } from '@/components/VoiceLineAssistant';
import { CameraCapture } from '@/components/CameraCapture';
import { calculateLine, roundMoney } from '@/lib/rateCardMath';
import { uploadFilesBatch, uploadPhoto, formatMoney } from '@/lib/photoUpload';
import { useAppDialog } from '@/components/AppDialog';
import {
  type SectionInstance,
  resolveSections,
  serializeSectionList,
  titleCaseSectionName,
  makeCustomSectionId,
} from '@/lib/sections';
import { SectionsManager } from '@/components/SectionsManager';

interface RateCardFormProps {
  templateType: TemplateType;
  templateLabel: string;
  inspectorName: string;
  propertyName: string;
  bedrooms: number;
  bathrooms: number;
  /** Property's square footage (from `square_footage` on the property object).
   *  Optional — shown in the header next to bed/bath if present. */
  squareFootage?: number | null;
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

export function RateCardForm(props: RateCardFormProps) {
  const dialog = useAppDialog();
  // Sections are now stateful — they may be customized (renamed, deleted,
  // reordered, or have additions). The initial value is taken from the prop
  // `sectionListJson` if set, else derived from bedrooms+bathrooms.
  const [sections, setSections] = useState<SectionInstance[]>(
    () => resolveSections(props.sectionListJson, props.bedrooms, props.bathrooms)
  );
  // Manage Sections modal open state
  const [showSectionsManager, setShowSectionsManager] = useState(false);

  // ----- Catalog + regions ---------------------------------------------
  const [catalog, setCatalog] = useState<RateCardLineItem[]>([]);
  const [regions, setRegions] = useState<RegionRate[]>([]);
  const inspectionRegion = props.inspectionRegion || '';
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const [dataLoaded, setDataLoaded] = useState(false);

  // ----- Lines + photos in state ---------------------------------------
  const [linesBySection, setLinesBySection] = useState<Record<string, RateCardLineInput[]>>({});
  const [photosBySection, setPhotosBySection] = useState<Record<string, string[]>>({});

  // HubSpot record IDs for upsert tracking. Updated after each successful save.
  // externalId -> HubSpot inspection_answer record id
  const [recordIdsByExternalId, setRecordIdsByExternalId] = useState<Record<string, string>>({});
  // sectionId -> HubSpot inspection_answer record id (for section_photo records)
  const [sectionPhotoRecordIds, setSectionPhotoRecordIds] = useState<Record<string, string>>({});

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
  /** When true, show the error-detail modal with the last save failure text.
   *  Click "⚠ Save failed — click for details" in the sticky header to open. */
  const [showSaveErrorDetail, setShowSaveErrorDetail] = useState(false);

  // When set, the section has a "pending new" row at the bottom that's currently
  // in edit mode (waiting to be filled out + saved). Only one pending new row
  // per section at a time; clicking + Add again while one is pending is a no-op.
  const [pendingNewBySection, setPendingNewBySection] = useState<Record<string, true>>({});

  // Mobile detection — drives the full-screen stacked line editor instead of
  // the inline table row, which is unusable on a phone.
  const [isMobile, setIsMobile] = useState(false);
  // Per-section collapse of the photo strip.
  const [photosCollapsed, setPhotosCollapsed] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  // Camera modal (for in-app capture). When non-null, captures append to this section.
  const [cameraSectionId, setCameraSectionId] = useState<string | null>(null);
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
    totals: { vendor: number; client: number; tenant: number; lineCount: number };
  };
  const [finalizing, setFinalizing] = useState(false);
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

  // The room the floating voice assistant is currently working on. Changing it
  // (manually or by voice) expands + scrolls to that section.
  const [currentSectionId, setCurrentSectionId] = useState<string>('');
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

  // Switch the assistant's working room: expand it and scroll it into view.
  const navigateToSection = useCallback((sectionId: string) => {
    setCurrentSectionId(sectionId);
    setExpanded((e) => ({ ...e, [sectionId]: true }));
    // Defer so the expand has applied before we measure/scroll.
    setTimeout(() => {
      const el = sectionRefs.current[sectionId];
      if (!el) return;
      // Scroll so the section sits just BELOW the sticky totals header (so its
      // top isn't tucked behind it). Manual offset scroll rather than
      // scrollIntoView, which would hide the top under the sticky bar.
      const STICKY_OFFSET = 64; // sticky totals header height + a little air
      const rect = el.getBoundingClientRect();
      const top = window.scrollY + rect.top - STICKY_OFFSET;
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }, 60);
  }, []);

  // After a voice add/edit, make sure the affected section is on-screen. Unlike
  // navigateToSection (top-align), this only scrolls if the section's content is
  // hidden behind the footer/dialogue at the bottom, so it doesn't yank the view
  // when the inspector is already looking at it. The tall bottom spacer makes
  // room for even the last section to scroll up.
  const revealSection = useCallback((sectionId: string) => {
    setExpanded((e) => ({ ...e, [sectionId]: true }));
    setTimeout(() => {
      const el = sectionRefs.current[sectionId];
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // Footer (~64px) + open assistant panel can cover the bottom ~340px.
      const bottomObstruction = 340;
      const viewportH = window.innerHeight;
      const STICKY_OFFSET = 64;
      // If the section's bottom is hidden behind the panel/footer, or its top is
      // under the sticky header, scroll it to just below the sticky header.
      if (rect.bottom > viewportH - bottomObstruction || rect.top < STICKY_OFFSET) {
        const top = window.scrollY + rect.top - STICKY_OFFSET;
        window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      }
    }, 80);
  }, []);
  // form mounts, so the FIRST "add line item" click is instant instead of
  // waiting on the (large) catalog fetch. Fire-and-forget; ensureDataLoaded
  // guards against double-loading, and the hydration effect below will reuse
  // whatever this has loaded. Skipped in read-only (completed) inspections.
  useEffect(() => {
    if (props.readOnly) return;
    void ensureDataLoaded();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function ensureDataLoaded(): Promise<boolean> {
    if (dataLoaded || dataLoading) return dataLoaded;
    setDataLoading(true);
    setDataError(null);
    try {
      const [catRes, regRes] = await Promise.all([
        fetch('/api/rate-card/catalog'),
        fetch('/api/rate-card/regions'),
      ]);
      const catData = await catRes.json();
      const regData = await regRes.json();
      if (!catRes.ok) throw new Error(catData.error || `Catalog HTTP ${catRes.status}`);
      if (!regRes.ok) throw new Error(regData.error || `Regions HTTP ${regRes.status}`);
      setCatalog(catData.items || []);
      setRegions(regData.regions || []);
      setDataLoaded(true);
      return true;
    } catch (e: any) {
      setDataError(String(e?.message || e));
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
      const [catRes, regRes] = await Promise.all([
        fetch('/api/rate-card/catalog?refresh=1'),
        fetch('/api/rate-card/regions?refresh=1'),
      ]);
      const catData = await catRes.json();
      const regData = await regRes.json();
      if (!catRes.ok) throw new Error(catData.error || `Catalog HTTP ${catRes.status}`);
      if (!regRes.ok) throw new Error(regData.error || `Regions HTTP ${regRes.status}`);
      setCatalog(catData.items || []);
      setRegions(regData.regions || []);
      setDataLoaded(true);
      void dialog.alert(`Rate card refreshed: ${catData.items?.length || 0} line items, ${regData.regions?.length || 0} regions loaded from HubSpot.`);
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

        const answers = data.answers || [];

        // Build a lookup: "label||location" -> sectionId
        const sectionLookup: Record<string, string> = {};
        for (const s of sections) {
          // Saved answers use `location` for repeating rooms (e.g., "Bedroom 1")
          // and "" for non-repeating. The corresponding sectionId is unique.
          const key = `${s.label}||${s.location}`;
          sectionLookup[key] = s.id;
        }

        const linesAcc: Record<string, RateCardLineInput[]> = {};
        const photosAcc: Record<string, string[]> = {};
        const lineRecordIds: Record<string, string> = {};
        const photoRecordIds: Record<string, string> = {};

        for (const ans of answers) {
          if (ans.answerType === 'rate_card_line' && ans.rateCardLine) {
            const rc = ans.rateCardLine;
            const sectionId = sectionLookup[`${ans.section}||${ans.location}`] || ans.section;
            // rc.customLaborFullDescription is whatever was stored in answer_value
            // — the catalog subtext/short description (default) or an inspector
            // override. Treat it as an override only if it differs from BOTH the
            // short description and the preferred catalog description (subtext).
            const catalogItem = catalog.find((c) => c.lineItemCode === rc.lineItemCode);
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
            };
            if (!linesAcc[sectionId]) linesAcc[sectionId] = [];
            linesAcc[sectionId].push(line);
            lineRecordIds[line.externalId] = ans.recordId;
          } else if (ans.answerType === 'section_photo') {
            const sectionId = sectionLookup[`${ans.section}||${ans.location}`] || ans.section;
            photosAcc[sectionId] = ans.photoUrls || [];
            photoRecordIds[sectionId] = ans.recordId;
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
  async function handleSaveLineForSection(sectionId: string, line: RateCardLineInput) {
    // Stamp the line's section/location from the TARGET section. Voice proposals
    // may have been generated for a different room earlier in the same turn
    // (e.g. "go to the kitchen and add a microwave"); routing is by sectionId, so
    // the section/location written to the record must match that section — not
    // whatever the proposal happened to carry.
    const targetSection = sections.find((s) => s.id === sectionId);
    if (targetSection) {
      line = { ...line, section: targetSection.label, location: targetSection.location };
    }
    // Whole House + SF unit: default the quantity to the property's square
    // footage. Only when the quantity is still the default (1) so an explicitly
    // entered quantity is respected.
    if (
      targetSection &&
      /whole\s*house/i.test(targetSection.label) &&
      props.squareFootage != null &&
      props.squareFootage > 0 &&
      (line.quantity == null || line.quantity === 1)
    ) {
      const item = catalog.find((c) => c.lineItemCode === line.lineItemCode);
      if (item && /^sf$/i.test((item.laborMeas || '').trim())) {
        line = { ...line, quantity: props.squareFootage };
      }
    }
    // Optimistic update — push into local state immediately so the UI reflects
    // the change even before the network round-trip.
    setLinesBySection((m) => {
      const existing = m[sectionId] || [];
      const found = existing.findIndex((l) => l.externalId === line.externalId);
      const next = [...existing];
      if (found >= 0) next[found] = line;
      else next.push(line);
      return { ...m, [sectionId]: next };
    });
    setPendingNewBySection((p) => {
      if (!p[sectionId]) return p;
      const next = { ...p };
      delete next[sectionId];
      return next;
    });

    // Skip the network call if we're not yet ready to save (still hydrating).
    // The line is now in linesBySection; once linesHydrated flips true the
    // useEffect below will catch up any pending dirty lines.
    if (!linesHydrated || props.readOnly) return;

    saveInFlightRef.current++;
    setSaveStatus({ kind: 'saving' });
    try {
      const recordId = recordIdsByExternalId[line.externalId];
      const r = await fetch(`/api/inspections/${props.inspectionRecordId}/rate-card-lines`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          upserts: [{ recordId, line }],
          archives: [],
          bumpStatusToInProgress: true,
        }),
      });
      if (!r.ok) {
        const text = await r.text();
        throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
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
    } catch (e: any) {
      console.error('[RateCardForm] line save failed:', e);
      setSaveStatus({ kind: 'error', message: String(e?.message || e) });
    } finally {
      saveInFlightRef.current--;
    }
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
    setLinesBySection((m) => {
      const existing = m[sectionId] || [];
      return { ...m, [sectionId]: existing.filter((l) => l.externalId !== externalId) };
    });
    const recordId = recordIdsByExternalId[externalId];
    if (!recordId || !linesHydrated || props.readOnly) return;
    saveInFlightRef.current++;
    setSaveStatus({ kind: 'saving' });
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
      setSaveStatus({ kind: 'error', message: String(e?.message || e) });
    } finally {
      saveInFlightRef.current--;
    }
  }

  // ----- Section list mutators ----------------------------------------
  // All section edits go through these so the persistence path is consistent.
  // Each one updates local state, then PATCHes the new JSON to HubSpot. We
  // also handle cascading deletes (archive line/photo records when a section
  // with content is removed).

  async function persistSectionList(next: SectionInstance[]): Promise<void> {
    const json = serializeSectionList(next);
    try {
      await fetch(`/api/inspections/${props.inspectionRecordId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section_list_json: json }),
      });
    } catch (e) {
      console.error('[RateCardForm] section_list_json save failed:', e);
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

  async function handleDeleteSection(sectionId: string, skipConfirm = false) {
    void skipConfirm; // kept for call-site compatibility; deletion is now immediate (no confirm)
    const section = sections.find((s) => s.id === sectionId);
    if (!section) return;

    // Cascade: archive every saved line + section photo for this section.
    const lines = linesBySection[sectionId] || [];
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

  // ----- Photo handlers ------------------------------------------------

  /**
   * Save the current photo URLs for a section to HubSpot immediately.
   * Replaces the autosave-based 'markPhotosDirty' flow.
   */
  async function savePhotosForSection(sectionId: string, urls: string[]) {
    if (!linesHydrated || props.readOnly) return;
    const section = sections.find((s) => s.id === sectionId);
    if (!section) return;
    const existingRecordId = sectionPhotoRecordIds[sectionId];
    // External ID must be globally unique across ALL inspection_answer records
    // in HubSpot (it's a unique-constraint property). Scoping by inspection
    // recordId prevents collisions when two different inspections both have a
    // section photo for the same section name (e.g., yard_exterior).
    const externalId = `SECTIONPHOTO-${props.inspectionRecordId}-${sectionId}`;

    saveInFlightRef.current++;
    setSaveStatus({ kind: 'saving' });
    try {
      if (urls.length === 0) {
        // No photos and no existing record: nothing to do.
        if (!existingRecordId) {
          setSaveStatus({ kind: 'saved', at: Date.now() });
          return;
        }
        // Archive the photo record
        const ar = await fetch(`/api/inspections/${props.inspectionRecordId}/answers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ upserts: [], archives: [existingRecordId] }),
        });
        if (!ar.ok) {
          const text = await ar.text();
          throw new Error(`HTTP ${ar.status}: ${text.slice(0, 400)}`);
        }
        setSectionPhotoRecordIds((cur) => {
          const next = { ...cur };
          delete next[sectionId];
          return next;
        });
      } else {
        // Upsert the photo record
        const r = await fetch(`/api/inspections/${props.inspectionRecordId}/answers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
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
          }),
        });
        if (!r.ok) {
          const text = await r.text();
          throw new Error(`HTTP ${r.status}: ${text.slice(0, 400)}`);
        }
        const data = await r.json();
        const newRecordId = data.results?.[0]?.recordId;
        if (newRecordId) {
          setSectionPhotoRecordIds((cur) => ({ ...cur, [sectionId]: newRecordId }));
        }
      }
      setSaveStatus({ kind: 'saved', at: Date.now() });
    } catch (e: any) {
      console.error('[RateCardForm] photo save failed:', e);
      setSaveStatus({ kind: 'error', message: String(e?.message || e) });
    } finally {
      saveInFlightRef.current--;
    }
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
        (current, total) => setUploadingSection({ sectionId, current, total })
      );
      if (failed > 0) {
        const reason = errors[0] ? `\n\nReason: ${errors[0]}` : '';
        void dialog.alert(`${failed} of ${fileArr.length} photo${fileArr.length === 1 ? '' : 's'} failed to upload. Successful uploads were saved.${reason}`);
      }
      // Save with the resulting full list (existing + new)
      const allUrls = [...(photosBySection[sectionId] || []), ...newUrls];
      await savePhotosForSection(sectionId, allUrls);
    } catch (e: any) {
      void dialog.alert(`Photo upload failed: ${e.message || e}`);
    } finally {
      setUploadingSection(null);
    }
  }

  function removePhoto(sectionId: string, idx: number) {
    if (props.readOnly) return;
    const current = photosBySection[sectionId] || [];
    const next = current.filter((_, i) => i !== idx);
    setPhotosBySection((m) => ({ ...m, [sectionId]: next }));
    savePhotosForSection(sectionId, next);
  }

  function handleCameraComplete(hubspotUrls: string[]) {
    if (!cameraSectionId) return;
    const current = photosBySection[cameraSectionId] || [];
    const next = [...current, ...hubspotUrls];
    setPhotosBySection((prev) => ({ ...prev, [cameraSectionId]: next }));
    savePhotosForSection(cameraSectionId, next);
    setCameraSectionId(null);
  }

  // ----- Math helpers --------------------------------------------------

  function totalsFor(line: RateCardLineInput) {
    const item = catalog.find((c) => c.lineItemCode === line.lineItemCode);
    if (!item || regions.length === 0) return null;
    try {
      return calculateLine(item, inspectionRegion, regions, {
        quantity: line.quantity,
        tenantBillBackPercent: line.tenantBillBackPercent,
        customLaborRate: line.customLaborRate ?? null,
        customAdjustedMaterialCost: line.customAdjustedMaterialCost ?? null,
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
        if (calc) { v += calc.vendorCost; c += calc.clientCost; t += calc.tenantCost; }
      }
      out[s.id] = { count: lines.length, vendor: v, client: c, tenant: t };
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections, linesBySection, catalog, regions, inspectionRegion]);

  const grandTotals = useMemo(() => {
    let v = 0, c = 0, t = 0, n = 0;
    for (const s of sections) {
      const st = sectionTotals[s.id];
      if (st) { v += st.vendor; c += st.client; t += st.tenant; n += st.count; }
    }
    return { count: n, vendor: v, client: c, tenant: t };
  }, [sections, sectionTotals]);

  const toggle = (id: string) => setExpanded((m) => ({ ...m, [id]: !m[id] }));

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

  async function handleSubmitOrFinalize() {
    // Pre-flight: required section photos present?
    const missingSections: string[] = [];
    for (const s of sections) {
      const photos = photosBySection[s.id] || [];
      const required = !s.photoOptional;
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
    // No lines at all? Probably a mistake.
    const totalLines = Object.values(linesBySection).reduce((s, arr) => s + arr.length, 0);
    if (totalLines === 0) {
      const ok = await dialog.confirm('No line items have been added. Submit anyway?', { confirmLabel: 'Submit' });
      if (!ok) return;
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
      setFinalizing(true);
      try {
        const r = await fetch(`/api/inspections/${props.inspectionRecordId}/finalize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (!r.ok) {
          const text = await r.text();
          throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`);
        }
        const data = await r.json();
        setFinalizeResult(data as FinalizeResult);
      } catch (e: any) {
        await dialog.alert(`Finalize failed: ${e?.message || e}\n\nThe inspection status was NOT changed. You can try again.`);
      } finally {
        setFinalizing(false);
      }
      return;
    }
    // First submit: flip status to pending_approval
    try {
      const r = await fetch(`/api/inspections/${props.inspectionRecordId}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!r.ok) {
        const text = await r.text();
        throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
      }
      props.onSubmit();
    } catch (e: any) {
      await dialog.alert(`Submit failed: ${e.message || e}`);
    }
  }

  // Keep the ref pointing at the latest handler so the OAuth auto-resume
  // effect always calls the current closure.
  finalizeHandlerRef.current = handleSubmitOrFinalize;

  // Human-friendly status label shown in the header. We map the HubSpot
  // internal value (snake_case) to title case + apply a color pill.
  const statusLabel = (() => {
    switch (props.inspectionStatus) {
      case 'scheduled': return { label: 'Scheduled', color: 'bg-blue-100 text-blue-800 border-blue-200' };
      case 'in_progress': return { label: 'In Progress', color: 'bg-amber-100 text-amber-800 border-amber-200' };
      case 'pending_approval': return { label: 'Pending Approval', color: 'bg-purple-100 text-purple-800 border-purple-200' };
      case 'completed': return { label: 'Completed', color: 'bg-emerald-100 text-emerald-800 border-emerald-200' };
      case 'cancelled': return { label: 'Cancelled', color: 'bg-gray-100 text-gray-700 border-gray-200' };
      default: return null;
    }
  })();

  const submitLabel = finalizing
    ? 'Generating PDFs...'
    : props.inspectionStatus === 'pending_approval'
      ? 'Finalize & Generate PDFs'
      : 'Submit for Approval';
  // Compact label for the narrow mobile footer (keeps everything on one line).
  const submitLabelShort = finalizing
    ? 'Generating...'
    : props.inspectionStatus === 'pending_approval'
      ? 'Finalize'
      : 'Submit';

  // ----- Render --------------------------------------------------------

  return (
    <div className="max-w-7xl mx-auto px-5 sm:px-6 py-4">
      {/* Header */}
      <header className="mb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-col sm:flex-row sm:items-baseline sm:gap-x-3 min-w-0">
              <h1 className="text-lg sm:text-xl font-bold text-gray-900 whitespace-nowrap">{props.templateLabel}</h1>
              <span className="text-sm text-gray-700 font-semibold truncate min-w-0">{props.propertyName}</span>
            </div>
            <div className="text-xs text-gray-500 mt-1">
              Inspector: {props.inspectorName} · {props.bedrooms} bed / {props.bathrooms} bath
              {props.squareFootage != null && props.squareFootage > 0 && (
                <span> · {props.squareFootage.toLocaleString()} sqft</span>
              )}
              {inspectionRegion && <span> · {inspectionRegion}</span>}
              {!inspectionRegion && <span className="text-yellow-700"> · fallback (GA: Atlanta)</span>}
              {statusLabel && (
                <>
                  {' · '}
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${statusLabel.color}`}>
                    {statusLabel.label}
                  </span>
                </>
              )}
            </div>
            {props.pdfUrl && (
              <a href={props.pdfUrl} target="_blank" rel="noopener noreferrer"
                 className="inline-block mt-2 text-sm text-brand underline">View PDF</a>
            )}
          </div>

          {/* Back button — saves any open/pending edits then exits, exactly
              like Save & Close. Pinned to the upper-right with edge padding. */}
          <button
            type="button"
            onClick={handleSaveAndClose}
            className="flex-shrink-0 self-start inline-flex items-center gap-1 text-sm font-semibold text-gray-700 hover:text-gray-900 border border-gray-300 hover:border-gray-400 rounded-lg px-3 py-1.5 bg-white"
            title="Save and go back"
          >
            <span aria-hidden>←</span> Back
          </button>
        </div>
      </header>

      {/* Sticky grand-total bar. The 3 money totals on the right use the
          same fixed column widths as the section row totals below, so all
          Vendor / Client / Tenant figures stack into visual columns from
          the top of the page down through each section header. */}
      <div className="sticky top-0 z-10 -mx-4 px-4 py-2 mb-3 bg-white border-b border-gray-200 shadow-sm">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="text-sm font-semibold text-gray-700">
              {grandTotals.count} {grandTotals.count === 1 ? 'line' : 'lines'}
            </div>
            {/* Save status: visible while the inspector is making edits so they
                get immediate feedback that work is being persisted. The
                'error' state is a button: clicking it opens a modal with the
                actual HubSpot error text so issues can be reported. */}
            <div className="text-xs flex items-center min-h-[1rem]">
              {saveStatus.kind === 'saving' && <span className="text-brand font-semibold">Saving...</span>}
              {saveStatus.kind === 'saved' && <span className="text-emerald-700 font-semibold">✓ Saved</span>}
              {saveStatus.kind === 'error' && (
                <button
                  type="button"
                  onClick={() => setShowSaveErrorDetail(true)}
                  className="text-red-700 font-semibold underline hover:text-red-900"
                  title="Click for details"
                >
                  ⚠ Save failed — click for details
                </button>
              )}
            </div>
          </div>
          <div className="flex items-stretch text-xs rounded-md bg-white border border-gray-200 overflow-hidden">
            <div className="text-center px-2.5 py-1 w-[78px] sm:w-[96px]">
              <div className="text-gray-400 text-[10px] uppercase tracking-wide">Vendor</div>
              <div className="font-semibold text-gray-700 tabular-nums mt-0.5">${formatMoney(roundMoney(grandTotals.vendor))}</div>
            </div>
            <div className="text-center px-2.5 py-1 w-[78px] sm:w-[96px] border-l border-gray-200/70">
              <div className="text-gray-400 text-[10px] uppercase tracking-wide">Client</div>
              <div className="font-semibold text-gray-700 tabular-nums mt-0.5">${formatMoney(roundMoney(grandTotals.client))}</div>
            </div>
            <div className="text-center px-2.5 py-1 w-[78px] sm:w-[96px] border-l border-gray-200/70">
              <div className="text-brand/70 text-[10px] uppercase tracking-wide">Tenant</div>
              <div className="font-semibold text-brand tabular-nums mt-0.5">${formatMoney(roundMoney(grandTotals.tenant))}</div>
            </div>
            <div className="text-center px-2.5 py-1 w-[78px] sm:w-[96px] border-l border-gray-200/70">
              <div className="text-emerald-600/70 text-[10px] uppercase tracking-wide">Net</div>
              <div className="font-semibold text-emerald-700 tabular-nums mt-0.5">${formatMoney(roundMoney(grandTotals.client - grandTotals.tenant))}</div>
            </div>
          </div>
        </div>
      </div>

      {dataError && (
        <div className="mb-3 p-3 bg-red-50 border border-red-300 rounded text-sm text-red-800">
          Error loading rate card data: {dataError}
        </div>
      )}

      {!props.readOnly && (
        <div className="mb-3 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={async () => {
              const ok = await dialog.confirm(
                'Refresh rate card pricing from HubSpot?\n\n' +
                'This will pull the latest line item costs and regional labor rates. ' +
                'Already-saved lines keep their original pricing — only new lines will use the refreshed rates.',
                { confirmLabel: 'Refresh' }
              );
              if (!ok) return;
              await refreshCatalogFromHubSpot();
            }}
            disabled={dataLoading}
            className="text-xs px-3 py-1.5 border border-gray-300 rounded bg-white hover:bg-gray-50 text-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
            title="Force-refresh line item catalog and regional rates from HubSpot. Use after editing pricing in the HubSpot sandbox."
          >
            {dataLoading ? '⟳ Refreshing...' : '⟳ Refresh Pricing'}
          </button>
          <button
            type="button"
            onClick={() => setShowSectionsManager(true)}
            className="text-xs px-3 py-1.5 border border-gray-300 rounded bg-white hover:bg-gray-50 text-gray-700"
            title="Add, remove, rename, or reorder sections"
          >
            ⚙ Manage Sections
          </button>
        </div>
      )}

      {/* Sections */}
      <div className="space-y-3">
        {sections.map((s) => {
          const lines = linesBySection[s.id] || [];
          const photos = photosBySection[s.id] || [];
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
          const t = sectionTotals[s.id] || { count: 0, vendor: 0, client: 0, tenant: 0 };
          const photosRequired = !s.photoOptional;
          const photosMissing = photosRequired && photos.length === 0;
          const isUploadingHere = uploadingSection?.sectionId === s.id;
          return (
            <section
              key={s.id}
              ref={(el) => { sectionRefs.current[s.id] = el; }}
              className={`bg-white rounded-lg shadow-md border overflow-hidden ${currentSectionId === s.id ? 'border-brand ring-1 ring-brand/30' : 'border-gray-200'}`}
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
                  {/* Section photos — compact single-row layout */}
                  <div className={`px-3 py-2 ${photosMissing ? 'bg-amber-50' : 'bg-gray-50'} border-b border-gray-100`}>
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div className="flex items-baseline gap-2 min-w-0">
                        <button
                          type="button"
                          onClick={() => setPhotosCollapsed((c) => ({ ...c, [s.id]: !c[s.id] }))}
                          className="flex items-baseline gap-1.5 min-w-0"
                        >
                          <span className={`text-gray-400 text-[10px] self-center transition-transform ${photosCollapsed[s.id] ? '' : 'rotate-90'}`}>&#9654;</span>
                          <span className="text-xs font-semibold text-gray-700 uppercase tracking-wide whitespace-nowrap">
                            Section Photos
                            {photosRequired
                              ? <span className="text-brand ml-1">*</span>
                              : <span className="text-gray-400 normal-case font-normal ml-1">(optional)</span>}
                          </span>
                        </button>
                        {photosMissing && !isUploadingHere && (
                          <span className="text-xs text-amber-800 font-semibold">at least 1 required</span>
                        )}
                        {isUploadingHere && (
                          <span className="text-xs text-brand font-semibold">
                            Uploading {uploadingSection!.current} of {uploadingSection!.total}...
                          </span>
                        )}
                        {photos.length > 0 && !photosMissing && !isUploadingHere && (
                          <span className="text-xs text-gray-500">{photos.length} added</span>
                        )}
                      </div>
                      {!props.readOnly && (
                        <div className="flex gap-2 items-center">
                          <button
                            type="button"
                            onClick={() => setCameraSectionId(s.id)}
                            disabled={isUploadingHere || !hasMediaDevices}
                            className="inline-flex items-center gap-1 text-xs bg-brand text-white font-semibold py-1 px-2 rounded hover:bg-brand-dark disabled:bg-gray-300 disabled:cursor-not-allowed"
                            title={hasMediaDevices ? 'In-app camera' : 'Camera not supported in this browser'}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                              <circle cx="12" cy="13" r="4" />
                            </svg>
                            Take
                          </button>
                          <label className={`inline-flex items-center gap-1 text-xs bg-brand/10 text-brand font-semibold py-1 px-2 rounded hover:bg-brand/20 ${
                            isUploadingHere ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
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
                              onChange={(e) => handlePhotoFiles(s.id, e.target.files)}
                              disabled={isUploadingHere}
                              className="hidden"
                            />
                          </label>
                        </div>
                      )}
                    </div>
                    {photos.length > 0 && !photosCollapsed[s.id] && (
                      <div className="flex gap-1.5 overflow-x-auto pb-1 mt-2 -mx-0.5 px-0.5">
                        {photos.map((url, idx) => (
                          <div key={idx} className="relative shrink-0">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <a href={url} target="_blank" rel="noopener noreferrer">
                              <img src={url} alt="" className="w-16 h-16 object-cover rounded border border-gray-200" />
                            </a>
                            {!props.readOnly && (
                              <button
                                type="button"
                                onClick={() => removePhoto(s.id, idx)}
                                className="absolute -top-1 -right-1 bg-ink text-white text-xs w-4 h-4 rounded-full leading-none flex items-center justify-center hover:bg-brand"
                              >&times;</button>
                            )}
                          </div>
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
                              regions={regions}
                              inspectionRegion={inspectionRegion}
                              section={s.label}
                              location={s.location}
                              readOnly={props.readOnly}
                              mobile={isMobile}
                              onSave={(updated) => handleSaveLineForSection(s.id, updated)}
                              onDelete={() => handleDeleteLine(s.id, line.externalId)}
                            />
                          ))}
                          {pendingNewBySection[s.id] && (
                            <EditableLineRow
                              key={`__new__${s.id}`}
                              line={null}
                              catalog={catalog}
                              regions={regions}
                              inspectionRegion={inspectionRegion}
                              section={s.label}
                              location={s.location}
                              readOnly={props.readOnly}
                              mobile={isMobile}
                              startInEditMode
                              onSave={(created) => handleSaveLineForSection(s.id, created)}
                              onDelete={() => handleDiscardNew(s.id)}  /* unused for new rows (no view-mode), kept for typing */
                              onDiscardNew={() => handleDiscardNew(s.id)}
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
                        disabled={dataLoading || pendingNewBySection[s.id]}
                        className="px-3 py-1.5 text-sm bg-brand text-white rounded hover:bg-brand-dark disabled:bg-gray-300"
                      >
                        {dataLoading ? 'Loading...' : pendingNewBySection[s.id] ? 'Finish current row first' : '+ Add Line Item'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>

      {/* Spacer so the floating footer doesn't cover the last section AND so
          the last section can always scroll up to the top of the viewport when
          the assistant auto-navigates to it (otherwise a line added to the very
          bottom section stays pinned near the footer). Roughly a viewport tall. */}
      <div className="h-[85vh]" />

      {/* Floating footer — visible on all screen sizes, pinned to the bottom of
          the viewport so the inspector can save/submit/cancel from anywhere.
          The voice assistant lives in the CENTER of this footer: a mic icon that
          expands upward into the conversation panel when pressed. */}
      <div className="fixed bottom-0 inset-x-0 bg-white border-t-2 border-gray-200 shadow-[0_-4px_10px_rgba(0,0,0,0.05)] z-30">
        <div className="max-w-7xl mx-auto px-3 sm:px-4 py-2.5 sm:py-3 flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <TerminalActions
              readOnly={!!props.readOnly}
              showCancelInspection={!!props.onCancelInspection}
              submitLabel={submitLabel}
              submitLabelShort={submitLabelShort}
              submitDisabled={!!props.readOnly || saveStatus.kind === "saving" || finalizing}
              onCancelInspection={handleCancelInspectionClick}
              onSaveAndClose={handleSaveAndClose}
              onSubmit={handleSubmitOrFinalize}
              voiceSlot={
                !props.readOnly && props.templateType === 'pm_scope_rate_card' && currentSectionId ? (
                  <VoiceLineAssistant
                    sections={sections.map((s) => ({
                      id: s.id,
                      label: s.label,
                      location: s.location,
                      displayName: s.displayName,
                    }))}
                    currentSectionId={currentSectionId}
                    onNavigate={navigateToSection}
                    region={inspectionRegion}
                    disabled={dataLoading}
                    currentLines={linesBySection[currentSectionId] || []}
                    catalog={catalog}
                    onAddLine={(line) => { handleSaveLineForSection(currentSectionId, line); revealSection(currentSectionId); }}
                    onRemoveLine={(externalId) => handleDeleteLine(currentSectionId, externalId)}
                    onAddLineTo={(sectionId, line) => { handleSaveLineForSection(sectionId, line); revealSection(sectionId); }}
                    onRemoveLineFrom={(sectionId, externalId) => handleDeleteLine(sectionId, externalId)}
                    linesBySection={linesBySection}
                  />
                ) : null
              }
            />
          </div>
        </div>
      </div>

      {cameraSectionId !== null && (
        <CameraCapture
          isOpen={true}
          onComplete={handleCameraComplete}
          onClose={() => setCameraSectionId(null)}
          uploadPhoto={uploadPhoto}
        />
      )}

      {showSectionsManager && (
        <SectionsManager
          sections={sections}
          lineCounts={Object.fromEntries(sections.map((s) => [s.id, (linesBySection[s.id] || []).length]))}
          photoCounts={Object.fromEntries(sections.map((s) => [s.id, (photosBySection[s.id] || []).length]))}
          onClose={() => setShowSectionsManager(false)}
          onRename={handleRenameSection}
          onDelete={(id) => handleDeleteSection(id, true)}
          onAdd={handleAddSection}
          onReorder={handleReorderSections}
        />
      )}

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
                    if (finalizeResult.pdfs.chargebackXlsx) items.push(finalizeResult.pdfs.chargebackXlsx);
                    for (const v of finalizeResult.pdfs.vendors) items.push({ name: v.name, url: v.url });
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
              {finalizeResult.pdfs.chargebackXlsx && (
                <DownloadLink label="Tenant Chargeback Import (xlsx)" filename={finalizeResult.pdfs.chargebackXlsx.name} url={finalizeResult.pdfs.chargebackXlsx.url} />
              )}
              {finalizeResult.pdfs.vendors.map((v) => (
                <DownloadLink
                  key={v.vendor}
                  label={`Vendor — ${v.vendor}`}
                  filename={v.name}
                  url={v.url}
                />
              ))}
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
  onCancelInspection: () => void;
  onSaveAndClose: () => void;
  onSubmit: () => void;
  voiceSlot?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      {/* Left: Save & Close */}
      <div className="flex-1 flex justify-start min-w-0">
        <button
          type="button"
          onClick={props.onSaveAndClose}
          className="px-2.5 sm:px-4 py-2 text-xs sm:text-sm border border-emerald-300 text-emerald-700 rounded hover:bg-emerald-600 hover:text-white hover:border-emerald-600 active:bg-emerald-700 active:border-emerald-700 transition-colors whitespace-nowrap"
        >
          Save &amp; Close
        </button>
      </div>
      {/* Center: voice assistant mic — dead center because the left and right
          flex containers are equal-weight. */}
      <div className="shrink-0 flex justify-center">{props.voiceSlot}</div>
      {/* Right: Submit / Finalize */}
      <div className="flex-1 flex justify-end min-w-0">
        <button
          type="button"
          onClick={props.onSubmit}
          disabled={props.submitDisabled}
          className="px-3 sm:px-5 py-2 text-xs sm:text-sm bg-brand text-white font-semibold rounded hover:bg-brand-dark disabled:bg-gray-300 disabled:cursor-not-allowed whitespace-nowrap"
        >
          <span className="sm:hidden">{props.submitLabelShort || props.submitLabel}</span>
          <span className="hidden sm:inline">{props.submitLabel}</span>
        </button>
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
      {/* Row 1: Title + inline edit/delete controls. The title gets the full
          row width on mobile so it doesn't truncate behind the totals. */}
      <div className="flex items-center gap-2 min-w-0">
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
          <div className="font-semibold text-gray-900 flex-1 min-w-0 break-words">{p.heading}</div>
        )}
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
      {/* Row 2: photo badges + line count on the LEFT, money totals on the
          RIGHT, with each total in a fixed-width column so that Vendor /
          Client / Tenant totals visually line up with the corresponding
          columns in the table below. */}
      <div className="flex items-center justify-between gap-2 mt-1 flex-wrap">
        <div className="flex items-baseline gap-x-3 gap-y-1 flex-wrap text-xs">
          {p.photosMissing && (
            <span title="Section photo required" className="text-amber-600 font-semibold">📷 Photos Needed</span>
          )}
          {p.photosCount > 0 && (
            <span className="text-gray-500">📷 {p.photosCount}</span>
          )}
          <span className={p.lineCount > 0 ? 'font-semibold text-gray-700' : 'text-gray-500'}>
            {p.lineCount} {p.lineCount === 1 ? 'line' : 'lines'}
          </span>
        </div>
        {p.lineCount > 0 && (
          <div className="flex items-stretch text-xs rounded-md bg-white border border-gray-200 overflow-hidden">
            <div className="text-center px-2.5 py-1 w-[78px] sm:w-[96px]">
              <div className="text-gray-400 text-[10px] uppercase tracking-wide">Vendor</div>
              <div className="font-semibold text-gray-700 tabular-nums mt-0.5">${formatMoney(roundMoney(p.vendorTotal))}</div>
            </div>
            <div className="text-center px-2.5 py-1 w-[78px] sm:w-[96px] border-l border-gray-200/70">
              <div className="text-gray-400 text-[10px] uppercase tracking-wide">Client</div>
              <div className="font-semibold text-gray-700 tabular-nums mt-0.5">${formatMoney(roundMoney(p.clientTotal))}</div>
            </div>
            <div className="text-center px-2.5 py-1 w-[78px] sm:w-[96px] border-l border-gray-200/70">
              <div className="text-brand/70 text-[10px] uppercase tracking-wide">Tenant</div>
              <div className="font-semibold text-brand tabular-nums mt-0.5">${formatMoney(roundMoney(p.tenantTotal))}</div>
            </div>
            <div className="text-center px-2.5 py-1 w-[78px] sm:w-[96px] border-l border-gray-200/70">
              <div className="text-emerald-600/70 text-[10px] uppercase tracking-wide">Net</div>
              <div className="font-semibold text-emerald-700 tabular-nums mt-0.5">${formatMoney(roundMoney(p.clientTotal - p.tenantTotal))}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
