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
import { CameraCapture } from '@/components/CameraCapture';
import { calculateLine, roundMoney } from '@/lib/rateCardMath';
import { uploadFilesBatch, uploadPhoto, formatMoney } from '@/lib/photoUpload';
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

  // When set, the section has a "pending new" row at the bottom that's currently
  // in edit mode (waiting to be filled out + saved). Only one pending new row
  // per section at a time; clicking + Add again while one is pending is a no-op.
  const [pendingNewBySection, setPendingNewBySection] = useState<Record<string, true>>({});

  // Camera modal (for in-app capture). When non-null, captures append to this section.
  const [cameraSectionId, setCameraSectionId] = useState<string | null>(null);
  // Upload progress (per section)
  const [uploadingSection, setUploadingSection] = useState<{
    sectionId: string;
    current: number;
    total: number;
  } | null>(null);
  // Browser supports in-app camera?
  const hasMediaDevices = typeof window !== 'undefined' &&
    !!window.navigator?.mediaDevices?.getUserMedia;

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

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
            // — it's either the catalog short description (default) or an
            // inspector override. We compare against the catalog to decide.
            const catalogItem = catalog.find((c) => c.lineItemCode === rc.lineItemCode);
            const storedDesc = rc.customLaborFullDescription || '';
            const catalogShort = catalogItem?.laborShortDescription || '';
            const customDesc = storedDesc && storedDesc !== catalogShort ? storedDesc : undefined;
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
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
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

  async function handleDeleteSection(sectionId: string) {
    const section = sections.find((s) => s.id === sectionId);
    if (!section) return;
    const lineCount = (linesBySection[sectionId] || []).length;
    const photoCount = (photosBySection[sectionId] || []).length;
    const msg = lineCount + photoCount > 0
      ? `Delete "${section.displayName}"? This will also remove ${lineCount} saved line${lineCount === 1 ? '' : 's'}${lineCount && photoCount ? ' and ' : ''}${photoCount ? `${photoCount} section photo${photoCount === 1 ? '' : 's'}` : ''}.`
      : `Delete "${section.displayName}"?`;
    if (!window.confirm(msg)) return;

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
    const externalId = `SECTIONPHOTO-${sectionId}`;

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
        await fetch(`/api/inspections/${props.inspectionRecordId}/answers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ upserts: [], archives: [existingRecordId] }),
        });
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
              answerProps: {
                answer_id_external: externalId,
                answer_type: 'section_photo',
                section: section.label,
                location: section.location,
                photo_urls: urls.join(','),
                answer_summary: `${section.label} / Section Photo (${urls.length})`,
              },
              questionHubspotRecordId: null,
            }],
            archives: [],
          }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
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
        alert(`${failed} of ${fileArr.length} photo${fileArr.length === 1 ? '' : 's'} failed to upload. Successful uploads were saved.${reason}`);
      }
      // Save with the resulting full list (existing + new)
      const allUrls = [...(photosBySection[sectionId] || []), ...newUrls];
      await savePhotosForSection(sectionId, allUrls);
    } catch (e: any) {
      alert(`Photo upload failed: ${e.message || e}`);
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

  // ----- Render --------------------------------------------------------

  return (
    <div className="max-w-7xl mx-auto p-4">
      {/* Header */}
      <header className="mb-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-xl font-bold text-gray-900">{props.templateLabel}</h1>
          <span className="text-sm text-gray-500">— {props.propertyName}</span>
        </div>
        <div className="text-xs text-gray-500 mt-1">
          Inspector: {props.inspectorName} · {props.bedrooms} bed / {props.bathrooms} bath
          {inspectionRegion && <span className="ml-2">· Region: <span className="font-semibold">{inspectionRegion}</span></span>}
          {!inspectionRegion && <span className="ml-2 text-yellow-700">· Region: <span className="font-semibold">fallback (GA: Atlanta)</span></span>}
        </div>
        {props.pdfUrl && (
          <a href={props.pdfUrl} target="_blank" rel="noopener noreferrer"
             className="inline-block mt-2 text-sm text-brand underline">View PDF</a>
        )}
      </header>

      {/* Sticky grand-total bar */}
      <div className="sticky top-0 z-10 -mx-4 px-4 py-2 mb-3 bg-white border-b border-gray-200 shadow-sm">
        <div className="flex items-baseline justify-between flex-wrap gap-2">
          <div className="text-sm font-semibold text-gray-700">
            {grandTotals.count} {grandTotals.count === 1 ? 'line' : 'lines'} ·
            Tenant Total: <span className="text-brand">${formatMoney(roundMoney(grandTotals.tenant))}</span>
          </div>
          {/* Save status: visible while the inspector is making edits so they
              get immediate feedback that work is being persisted. */}
          <div className="text-xs italic flex items-center gap-2 min-h-[1rem]">
            {saveStatus.kind === 'saving' && <span className="text-brand font-semibold not-italic">Saving...</span>}
            {saveStatus.kind === 'saved' && <span className="text-emerald-700 font-semibold not-italic">✓ Saved</span>}
            {saveStatus.kind === 'error' && (
              <span className="text-red-700 font-semibold not-italic" title={saveStatus.message}>
                ⚠ Save failed
              </span>
            )}
          </div>
          <div className="text-xs text-gray-500">
            Vendor ${formatMoney(roundMoney(grandTotals.vendor))} · Client ${formatMoney(roundMoney(grandTotals.client))}
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
          // Sections with line items stay expanded regardless of the toggle
          // state — they hold work the user needs to see at a glance. Empty
          // sections collapse normally via the toggle.
          const hasLines = lines.length > 0;
          const isOpen = hasLines || expanded[s.id] === true;
          const heading = s.displayName;
          const t = sectionTotals[s.id] || { count: 0, vendor: 0, client: 0, tenant: 0 };
          const photosRequired = !s.photoOptional;
          const photosMissing = photosRequired && photos.length === 0;
          const isUploadingHere = uploadingSection?.sectionId === s.id;
          return (
            <section key={s.id} className="bg-white rounded shadow-sm border border-gray-200 overflow-hidden">
              <SectionHeader
                section={s}
                heading={heading}
                isOpen={isOpen}
                forceExpanded={hasLines}
                lineCount={t.count}
                clientTotal={t.client}
                tenantTotal={t.tenant}
                photosCount={photos.length}
                photosMissing={photosMissing}
                onToggle={() => { if (!hasLines) toggle(s.id); }}
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
                        <span className="text-xs font-semibold text-gray-700 uppercase tracking-wide whitespace-nowrap">
                          Section Photos
                          {photosRequired
                            ? <span className="text-brand ml-1">*</span>
                            : <span className="text-gray-400 normal-case font-normal ml-1">(optional)</span>}
                        </span>
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
                    {photos.length > 0 && (
                      <div className="grid grid-cols-6 sm:grid-cols-8 gap-1 mt-2">
                        {photos.map((url, idx) => (
                          <div key={idx} className="relative">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={url} alt="" className="w-full h-12 object-cover rounded" />
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
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50 border-b border-gray-200">
                          <tr className="text-xs text-gray-600 uppercase tracking-wide">
                            <th className="text-center px-3 py-2 whitespace-nowrap">Category</th>
                            <th className="text-center px-3 py-2 whitespace-nowrap">Sub</th>
                            <th className="text-left px-3 py-2">Line Item</th>
                            <th className="text-center px-3 py-2 whitespace-nowrap">Unit</th>
                            <th className="text-center px-3 py-2 whitespace-nowrap">Qty</th>
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

      {/* Submit row.
          Layout: Cancel Inspection (destructive, danger zone) anchored on the
          LEFT so it's never accidentally tapped near the primary actions on
          the right. Save & Close + Submit for Approval are grouped on the
          right, Submit (primary) outermost since it's the most common
          terminal action. Save & Close turns green on hover/active so it's
          visually obvious it's saving work, not discarding it. */}
      <div className="mt-6 flex items-center justify-between border-t border-gray-200 pt-4 flex-wrap gap-3">
        <div>
          {!props.readOnly && props.onCancelInspection && (
            <button
              type="button"
              onClick={async () => {
                const confirmed = window.confirm(
                  'Cancel this inspection? It will be marked as Cancelled in HubSpot. ' +
                  'Already-saved lines and photos will remain on the record but the ' +
                  'inspection won\'t progress further. This cannot be undone.'
                );
                if (!confirmed) return;
                try { await commitAndWait(); } catch {}
                props.onCancelInspection!();
              }}
              className="px-4 py-2 text-sm border border-red-300 text-red-700 rounded hover:bg-red-50"
            >
              Cancel Inspection
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={async () => {
              // Commit any open inline edits AND flush any pending autosaves
              // before navigating. If the save fails, surface it so the user
              // can retry — silently dropping their work is worse than blocking.
              try {
                await commitAndWait();
              } catch (e: any) {
                const msg = e?.message || String(e);
                const proceed = window.confirm(
                  `Save failed: ${msg}\n\nLeave anyway? Your unsaved changes will be lost.`
                );
                if (!proceed) return;
              }
              props.onCancel();
            }}
            className="px-4 py-2 text-sm border border-emerald-300 text-emerald-700 rounded hover:bg-emerald-600 hover:text-white hover:border-emerald-600 active:bg-emerald-700 active:border-emerald-700 transition-colors"
          >
            Save & Close
          </button>
        <button
          type="button"
          onClick={async () => {
            // Check requirements first
            const missingSections: string[] = [];
            for (const s of sections) {
              const photos = photosBySection[s.id] || [];
              const required = !s.photoOptional;
              if (required && photos.length === 0) missingSections.push(s.displayName);
            }
            if (missingSections.length > 0) {
              alert(
                'Section photos are still required for:\n\n' +
                missingSections.slice(0, 10).map((n) => `  • ${n}`).join('\n') +
                (missingSections.length > 10 ? `\n  ...and ${missingSections.length - 10} more` : '')
              );
              return;
            }
            // No lines at all? Probably a mistake.
            const totalLines = Object.values(linesBySection).reduce((s, arr) => s + arr.length, 0);
            if (totalLines === 0) {
              const ok = window.confirm('No line items have been added. Submit anyway?');
              if (!ok) return;
            }
            // Flush pending edits to make sure HubSpot has everything before the submit.
            try {
              await commitAndWait();
            } catch (e: any) {
              alert(`Could not finish saving before submit: ${e.message || e}\n\nPlease try again.`);
              return;
            }
            // Submit endpoint flips status to pending_approval for rate card inspections.
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
              alert(`Submit failed: ${e.message || e}`);
            }
          }}
          disabled={props.readOnly || saveStatus.kind === "saving"}
          className="px-5 py-2 text-sm bg-brand text-white font-semibold rounded hover:bg-brand-dark disabled:bg-gray-300 disabled:cursor-not-allowed"
        >
          Submit for Approval
        </button>
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
          onDelete={handleDeleteSection}
          onAdd={handleAddSection}
          onReorder={handleReorderSections}
        />
      )}
    </div>
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
      className={`w-full px-4 py-3 ${
        editingTitle || p.forceExpanded ? '' : 'hover:bg-gray-50 cursor-pointer'
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
      {/* Row 2: photo badges + line count + totals. Wraps onto its own line on
          mobile so the section title is never truncated. */}
      <div className="flex items-baseline gap-x-3 gap-y-1 flex-wrap text-xs mt-1">
        {p.photosMissing && (
          <span title="Section photo required" className="text-amber-600 font-semibold">📷 Photos Needed</span>
        )}
        {p.photosCount > 0 && (
          <span className="text-gray-500">📷 {p.photosCount}</span>
        )}
        <span className={p.lineCount > 0 ? 'font-semibold text-gray-700' : 'text-gray-500'}>
          {p.lineCount} {p.lineCount === 1 ? 'line' : 'lines'}
        </span>
        {p.lineCount > 0 && (
          <>
            <span className="text-gray-700">
              Client <span className="font-semibold">${formatMoney(roundMoney(p.clientTotal))}</span>
            </span>
            <span className="text-brand font-semibold">
              Tenant ${formatMoney(roundMoney(p.tenantTotal))}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
