/**
 * QcReinspectForm — the (PM) Turn Re-Inspect QC inspection form.
 *
 * Validates that a vendor completed the work dispatched on a Scope Rate Card.
 * Visually mirrors the Scope Rate Card read-only view: collapsible sections,
 * the full column set (Category / Sub / Line Item / Qty / Unit / Vendor /
 * Vendor $), the same section-photo layout — plus two QC additions:
 *   - a Result column with Pass (check) / Fail (x) chips per line
 *   - an "After Photos" capture block (highlighted teal) alongside the
 *     source's "Before" photos
 *
 * Lines are snapshotted from the source at create time and loaded (enriched
 * with catalog category/sub/unit) via /api/inspections/[id]/qc-data.
 *
 * Submit (no approval step) -> /api/inspections/[id]/qc-finalize which renders
 * the PDF, stores verdict + counts, flips to completed (like the 1099 flow).
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatMoney, formatQty } from '@/lib/photoUpload';
import { uploadPhotoOrQueue, uploadVideoEntryOrQueue, rehydrateQueuedPhotos, flushQueuedPhotos } from '@/lib/offlinePhotoStore';
import { loadCachedQcData, saveCachedQcData } from '@/lib/offlineCache';
import { useAnyCameraOpen } from '@/lib/cameraOpenState';
import { CameraCapture } from '@/components/CameraCapture';
import { PhotoLightbox } from '@/components/PhotoLightbox';
import { vendorPillStyle, VENDORS } from '@/lib/vendors';
import { ListPicker } from '@/components/ListPicker';
import { PhotoStrip } from '@/components/PhotoStrip';
import { useAppDialog } from '@/components/AppDialog';
import { buildSectionPhotoAnswerProps, joinPhotoUrls } from '@/lib/answerProps';
import { stampEntryWithLabel, isStamped } from '@/lib/photoStamp';
import { UnlockButton } from '@/components/UnlockButton';

interface QcLine {
  recordId: string;
  section: string;
  location: string;
  lineItemCode: string;
  category: string;
  subcategory: string;
  unit: string;
  description: string;
  subtext?: string;
  quantity: number | null;
  vendor: string;
  vendorCost: number | null;
  passFail: 'pass' | 'fail' | '';
  photoUrls: string[];
  // Read-only comment carried over from the source Scope line (what to look for).
  scopeNote?: string;
  // The QC reviewer's explanation when this line is failed (required on fail).
  qcFailureNote?: string;
}

interface Props {
  inspectionRecordId: string;
  templateLabel: string;
  inspectorName: string;
  propertyName: string;
  /** Property record id — used to validate camera GPS against the property. */
  propertyRecordId?: string;
  bedrooms: number;
  bathrooms: number;
  squareFootage: number | null;
  inspectionStatus: string;
  readOnly: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  // Cancel the whole inspection (sets status to cancelled). Absent when readOnly.
  onCancelInspection?: () => void;
}

interface SectionGroup {
  key: string;
  displayName: string;
  location: string;
  section: string;
  lines: QcLine[];
  beforePhotos: string[];
}

function sectionKey(section: string, location: string) {
  return `${section || ''}||${location || ''}`;
}

export function QcReinspectForm(props: Props) {
  const dialog = useAppDialog();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lines, setLines] = useState<QcLine[]>([]);
  const [beforeMap, setBeforeMap] = useState<Record<string, string[]>>({});
  const [afterPhotos, setAfterPhotos] = useState<Record<string, string[]>>({});
  const [afterPhotoRecordIds, setAfterPhotoRecordIds] = useState<Record<string, string>>({});
  const [sourceName, setSourceName] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<'pass' | 'fail' | ''>('');
  // Overall failure comment — REQUIRED when the verdict is Fail; carried onto the
  // QC PDF so the vendor/MC see why the re-inspect failed overall.
  const [overallNote, setOverallNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Synchronous re-entry guard: `disabled={submitting}` only blocks taps AFTER
  // the next render, so a fast double-tap could fire two qc-finalize POSTs in
  // the same frame. The ref blocks the second call immediately.
  const submittingRef = useRef(false);
  const [result, setResult] = useState<null | { verdict: string; passCount: number; failCount: number; pdf: { name: string; url: string }; resultSync?: { verdictSynced: boolean; inspectionResultSynced: boolean; fields: string[] } }>(null);
  const [cameraKey, setCameraKey] = useState<string | null>(null);
  // While a camera overlay is open, don't render before/after thumbnails — keeps
  // them from sitting decoded in memory under the camera (the iOS WebKit crash).
  const cameraOpenAnywhere = useAnyCameraOpen();
  // Photo viewer (swipe / markup / delete / tag-to-line / video). `phase`
  // distinguishes the read-only source "before" photos from editable "after".
  const [qcLightbox, setQcLightbox] = useState<{ phase: 'before' | 'after'; key: string; index: number } | null>(null);
  // Per-section photo collapse — Before + After share one state so collapsing
  // either folds both.
  const [photosCollapsed, setPhotosCollapsed] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Real-time save status indicator (mirrors the Scope Rate Card).
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Audit: log ONE "Edited" event per editing session (first successful save),
  // re-armed after the app is re-entered following an absence. Best-effort.
  const editAuditLoggedRef = useRef(false);
  function logEditOnce() {
    if (editAuditLoggedRef.current) return;
    editAuditLoggedRef.current = true;
    try {
      void fetch(`/api/inspections/${props.inspectionRecordId}/audit-edit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', keepalive: true,
      }).catch(() => { /* best-effort — never blocks editing */ });
    } catch { /* ignore */ }
  }

  function markSaving() { setSaveStatus('saving'); }
  function markSaved() {
    logEditOnce(); // first save of the session → record an "Edited" audit event
    setSaveStatus('saved');
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    savedTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000);
  }
  function markSaveError() { setSaveStatus('error'); }
  useEffect(() => () => { if (savedTimerRef.current) clearTimeout(savedTimerRef.current); }, []);
  // Re-arm the once-per-session edit log when the app is re-entered after >60s away.
  useEffect(() => {
    let hiddenAt = 0;
    const onVis = () => {
      if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
      if (hiddenAt && Date.now() - hiddenAt > 60_000) editAuditLoggedRef.current = false;
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      // Apply a qc-data payload (live or cached) to state.
      const apply = (d: any) => {
        const loadedLines: QcLine[] = d.lines || [];
        setLines(loadedLines);
        setBeforeMap(d.beforePhotos || {});
        const after: Record<string, string[]> = {};
        const afterIds: Record<string, string> = {};
        for (const [key, v] of Object.entries(d.afterPhotos || {})) {
          const val = v as { recordId: string; urls: string[] };
          after[key] = val.urls || [];
          afterIds[key] = val.recordId;
        }
        setAfterPhotos(after);
        setAfterPhotoRecordIds(afterIds);
        setSourceName(d.sourceRateCardName || null);
        if (d.qcVerdict === 'pass' || d.qcVerdict === 'fail') setVerdict(d.qcVerdict);

        // Default: all sections expanded so the reviewer can see every line
        // item at a glance. (They can still collapse individually.)
        setCollapsed(new Set());
      };
      try {
        const r = await fetch(`/api/inspections/${props.inspectionRecordId}/qc-data`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        if (cancelled) return;
        apply(d);
        saveCachedQcData(props.inspectionRecordId, d); // warm offline cache
      } catch (e: any) {
        // Offline / fetch failed → fall back to the cached qc-data so the
        // re-inspect still opens; Pass/Fail + after-photos queue and sync later.
        const cached = loadCachedQcData(props.inspectionRecordId);
        if (cached && !cancelled) { apply(cached); }
        else if (!cancelled) { setLoadError(String(e?.message || e)); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [props.inspectionRecordId]);

  const sections: SectionGroup[] = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, SectionGroup>();
    for (const ln of lines) {
      const key = sectionKey(ln.section, ln.location);
      if (!map.has(key)) {
        order.push(key);
        const before = beforeMap[key] || beforeMap[ln.location] || beforeMap[ln.section] || [];
        map.set(key, {
          key,
          displayName: ln.location || ln.section || 'Section',
          location: ln.location,
          section: ln.section,
          lines: [],
          beforePhotos: before,
        });
      }
      map.get(key)!.lines.push(ln);
    }
    return order.map((k) => map.get(k)!);
  }, [lines, beforeMap]);

  // Distinct vendors actually assigned on this reinspect, ordered by the
  // canonical VENDORS list (then any extras). Drives the header filter dropdown.
  const assignedVendors = useMemo(() => {
    const present = new Set<string>();
    for (const l of lines) { const v = (l.vendor || '').trim(); if (v) present.add(v); }
    return [...VENDORS.filter((v) => present.has(v)), ...Array.from(present).filter((v) => !VENDORS.includes(v))];
  }, [lines]);
  const [vendorFilter, setVendorFilter] = useState<string>('All');
  // Guard: if the selected vendor no longer has any lines, fall back to All.
  const activeVendorFilter = vendorFilter !== 'All' && assignedVendors.includes(vendorFilter) ? vendorFilter : 'All';

  // Sections to render — narrowed to the selected vendor's lines, hiding any
  // section that has none of them. Keeps the same key/photos so collapse state
  // and before/after photo maps still line up.
  const visibleSections = useMemo(() => {
    if (activeVendorFilter === 'All') return sections;
    return sections
      .map((s) => ({ ...s, lines: s.lines.filter((l) => (l.vendor || '').trim() === activeVendorFilter) }))
      .filter((s) => s.lines.length > 0);
  }, [sections, activeVendorFilter]);

  const totalPass = lines.filter((l) => l.passFail === 'pass').length;
  const totalFail = lines.filter((l) => l.passFail === 'fail').length;
  const allMarked = lines.length > 0 && lines.every((l) => l.passFail === 'pass' || l.passFail === 'fail');
  const allSectionsHaveAfter = sections.every((s) => (afterPhotos[s.key] || []).length > 0);

  // Offline-aware uploader for the in-app camera — caches to IndexedDB on a weak
  // signal and returns a draft URL, tagged to the camera's active section so it
  // re-attaches on sync. cameraKey tracks the room being shot.
  const uploadHelper = useCallback(
    (file: File) => uploadPhotoOrQueue(file, props.inspectionRecordId, cameraKey || ''),
    [props.inspectionRecordId, cameraKey],
  );

  function toggleCollapse(key: string) {
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  const allCollapsed = sections.length > 0 && sections.every((s) => collapsed.has(s.key));
  function setAllCollapsed(c: boolean) {
    setCollapsed(c ? new Set(sections.map((s) => s.key)) : new Set());
  }

  async function persistAfterPhotos(key: string, section: string, location: string, urlsIn: string[]) {
    // Never POST offline draft (blob:) URLs to HubSpot — they're local only and
    // get swapped for the real URL when the queue flushes on reconnect.
    const urls = urlsIn.filter((u) => !u.startsWith('blob:'));
    const existingId = afterPhotoRecordIds[key];
    const uuid = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const externalId = existingId || `QCAFTER-${props.inspectionRecordId}-${key}-${uuid}`;
    markSaving();
    const r = await fetch(`/api/inspections/${props.inspectionRecordId}/answers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        upserts: [{
          recordId: existingId,
          answerProps: buildSectionPhotoAnswerProps({
            answerIdExternal: externalId,
            section,
            summaryLabel: section,
            location,
            photoUrls: urls,
            photoPhase: 'after',
          }),
          questionHubspotRecordId: null,
        }],
        bumpStatusToInProgress: true,
      }),
    });
    if (!r.ok) { markSaveError(); throw new Error(`Save after-photos failed: HTTP ${r.status}`); }
    const data = await r.json();
    const newId = data?.results?.[0]?.recordId;
    if (newId && !existingId) {
      setAfterPhotoRecordIds((cur) => ({ ...cur, [key]: newId }));
    }
    markSaved();
  }

  async function addAfterPhotos(key: string, section: string, location: string, newUrls: string[]) {
    if (newUrls.length === 0) return;
    const merged = [...(afterPhotos[key] || []), ...newUrls];
    setAfterPhotos((cur) => ({ ...cur, [key]: merged }));
    try { await persistAfterPhotos(key, section, location, merged); }
    catch (e: any) { void dialog.alert(`Could not save photos: ${e?.message || e}`); }
  }

  async function removeAfterPhoto(key: string, section: string, location: string, url: string) {
    const merged = (afterPhotos[key] || []).filter((u) => u !== url);
    setAfterPhotos((cur) => ({ ...cur, [key]: merged }));
    try { await persistAfterPhotos(key, section, location, merged); }
    catch (e: any) { void dialog.alert(`Could not update photos: ${e?.message || e}`); }
    // Keep line tags in sync — a deleted After photo can't stay on a line.
    const sec = sections.find((s) => s.key === key);
    for (const line of (sec?.lines || [])) {
      if ((line.photoUrls || []).includes(url)) {
        await saveLinePhotos(line.recordId, (line.photoUrls || []).filter((u) => u !== url));
      }
    }
  }

  // Persist a QC line's photo_urls to its answer record (shared by tag/untag).
  async function saveLinePhotos(lineRecordId: string, urls: string[]) {
    setLines((cur) => cur.map((l) => (l.recordId === lineRecordId ? { ...l, photoUrls: urls } : l)));
    // Persist only real URLs — offline drafts (blob:) sync + swap on reconnect.
    const real = urls.filter((u) => !u.startsWith('blob:'));
    try {
      markSaving();
      const r = await fetch(`/api/inspections/${props.inspectionRecordId}/answers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          upserts: [{
            recordId: lineRecordId,
            answerProps: { photo_urls: joinPhotoUrls(real), photo_count: real.length },
            questionHubspotRecordId: null,
          }],
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      markSaved();
    } catch (e: any) { markSaveError(); void dialog.alert(`Could not update line tag: ${e?.message || e}`); }
  }

  // Tag a freshly-captured photo to a QC line FROM INSIDE THE CAMERA
  // (non-destructive — attaches the photo to the line record, returns url as-is).
  async function tagCameraPhotoToLineQc(url: string, lineRecordId: string): Promise<string> {
    const line = lines.find((l) => l.recordId === lineRecordId);
    if (!line) return url;
    const linePhotos = line.photoUrls || [];
    if (!linePhotos.includes(url)) await saveLinePhotos(lineRecordId, [...linePhotos, url]);
    return url;
  }

  // Swap an After photo for its marked-up version (re-upload + replace, persist).
  async function replaceAfterPhoto(key: string, section: string, location: string, index: number, file: File) {
    try {
      const oldForReplace = (afterPhotos[key] || [])[index];
      const url = await uploadPhotoOrQueue(file, props.inspectionRecordId, key, { replacesUrl: oldForReplace });
      const arr = [...(afterPhotos[key] || [])];
      if (index < 0 || index >= arr.length) return;
      const oldUrl = arr[index];
      arr[index] = url;
      setAfterPhotos((cur) => ({ ...cur, [key]: arr }));
      await persistAfterPhotos(key, section, location, arr);
      // Keep line tags in sync — swap the old URL for the marked-up one.
      if (oldUrl && oldUrl !== url) {
        const sec = sections.find((s) => s.key === key);
        for (const line of (sec?.lines || [])) {
          if ((line.photoUrls || []).includes(oldUrl)) {
            await saveLinePhotos(line.recordId, (line.photoUrls || []).map((u) => (u === oldUrl ? url : u)));
          }
        }
      }
    } catch (e: any) { void dialog.alert(`Could not update photo: ${e?.message || e}`); }
  }

  // Tag/untag an After photo to/from a QC line (non-destructive). The photo
  // stays in the After strip; only the line's photo_urls change.
  async function tagAfterPhotoToLine(key: string, index: number, lineRecordId: string) {
    const url = (afterPhotos[key] || [])[index];
    const line = lines.find((l) => l.recordId === lineRecordId);
    if (!url || !line) return;
    const linePhotos = line.photoUrls || [];
    if (!linePhotos.includes(url)) await saveLinePhotos(lineRecordId, [...linePhotos, url]);
  }
  async function untagAfterPhotoFromLine(key: string, index: number, lineRecordId: string) {
    const url = (afterPhotos[key] || [])[index];
    const line = lines.find((l) => l.recordId === lineRecordId);
    if (!url || !line) return;
    await saveLinePhotos(lineRecordId, (line.photoUrls || []).filter((u) => u !== url));
  }

  // ---- Offline photo cache + auto-sync ----------------------------------
  // Captures on a weak signal are cached to IndexedDB (draft blob: URLs) and
  // re-attached + persisted when connectivity returns. Mirrors RateCardForm.
  const afterPhotosRef = useRef(afterPhotos); afterPhotosRef.current = afterPhotos;
  const linesRef = useRef(lines); linesRef.current = lines;
  const persistRef = useRef(persistAfterPhotos); persistRef.current = persistAfterPhotos;
  const saveLineRef = useRef(saveLinePhotos); saveLineRef.current = saveLinePhotos;
  const rehydratedRef = useRef(false);

  const runQcFlush = async () => {
    if (!rehydratedRef.current) return; // wait until drafts are in state to swap
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    const sectionSwaps = new Map<string, string>();
    const lineSwaps = new Map<string, string>();
    await flushQueuedPhotos(props.inspectionRecordId, ({ sectionId, oldUrl, newUrl, replacesUrl, lineExternalId }) => {
      if (lineExternalId) { if (oldUrl) lineSwaps.set(oldUrl, newUrl); if (replacesUrl) lineSwaps.set(replacesUrl, newUrl); }
      else { if (oldUrl) sectionSwaps.set(oldUrl, newUrl); if (replacesUrl) sectionSwaps.set(replacesUrl, newUrl); }
    }).catch(() => ({ synced: 0 } as any));
    if (sectionSwaps.size) {
      const cur = afterPhotosRef.current;
      const next: Record<string, string[]> = { ...cur };
      const persistKeys: string[] = [];
      for (const [k, urls] of Object.entries(cur)) {
        let changed = false;
        const sw = urls.map((u) => { const r = sectionSwaps.get(u); if (r) { changed = true; return r; } return u; });
        if (changed) { next[k] = sw; persistKeys.push(k); }
      }
      if (persistKeys.length) {
        setAfterPhotos(next);
        for (const k of persistKeys) { const [section, location] = k.split('||'); void persistRef.current(k, section, location || '', next[k]); }
      }
    }
    if (lineSwaps.size) {
      const cur = linesRef.current;
      const toSave: { id: string; urls: string[] }[] = [];
      const next = cur.map((l) => {
        const photos = l.photoUrls || [];
        let changed = false;
        const sw = photos.map((u) => { const r = lineSwaps.get(u); if (r) { changed = true; return r; } return u; });
        if (!changed) return l;
        toSave.push({ id: l.recordId, urls: sw });
        return { ...l, photoUrls: sw };
      });
      if (toSave.length) { setLines(next); for (const t of toSave) void saveLineRef.current(t.id, t.urls); }
    }
  };
  const runQcFlushRef = useRef(runQcFlush); runQcFlushRef.current = runQcFlush;

  // Rehydrate queued drafts into state once the record has loaded, then drain.
  useEffect(() => {
    if (loading || rehydratedRef.current) return;
    rehydratedRef.current = true;
    void rehydrateQueuedPhotos(props.inspectionRecordId).then((drafts) => {
      if (drafts.length) {
        const bySection: Record<string, string[]> = {};
        const byLine: Record<string, string[]> = {};
        for (const d of drafts) {
          if (d.lineExternalId) (byLine[d.lineExternalId] = byLine[d.lineExternalId] || []).push(d.url);
          else (bySection[d.sectionId] = bySection[d.sectionId] || []).push(d.url);
        }
        if (Object.keys(bySection).length) setAfterPhotos((cur) => { const n = { ...cur }; for (const [k, urls] of Object.entries(bySection)) n[k] = Array.from(new Set([...(n[k] || []), ...urls])); return n; });
        if (Object.keys(byLine).length) setLines((cur) => cur.map((l) => byLine[l.recordId] ? { ...l, photoUrls: Array.from(new Set([...(l.photoUrls || []), ...byLine[l.recordId]])) } : l));
      }
    }).catch(() => {}).finally(() => { void runQcFlushRef.current(); });
  }, [loading, props.inspectionRecordId]);

  // Auto-retry: flush on reconnect + a periodic reconcile.
  useEffect(() => {
    const onOnline = () => { void runQcFlushRef.current(); };
    window.addEventListener('online', onOnline);
    const iv = setInterval(() => { void runQcFlushRef.current(); }, 15000);
    return () => { window.removeEventListener('online', onOnline); clearInterval(iv); };
  }, []);
  // Which of a section's lines the After photo at `index` is tagged to.
  function currentTagsForAfter(key: string, index: number): { externalId: string; label: string }[] {
    const url = (afterPhotos[key] || [])[index];
    if (!url) return [];
    const sec = sections.find((s) => s.key === key);
    return (sec?.lines || [])
      .filter((l) => (l.photoUrls || []).includes(url))
      .map((l) => ({ externalId: l.recordId, label: l.description || l.lineItemCode }));
  }

  async function setLinePassFail(line: QcLine, pf: 'pass' | 'fail') {
    const next = line.passFail === pf ? '' : pf;
    setLines((cur) => cur.map((l) => (l.recordId === line.recordId
      // Leaving 'fail' clears the failure note (it no longer applies).
      ? { ...l, passFail: next, qcFailureNote: next === 'fail' ? l.qcFailureNote : '' }
      : l)));
    markSaving();
    try {
      const r = await fetch(`/api/inspections/${props.inspectionRecordId}/answers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          upserts: [{ recordId: line.recordId, answerProps: { pass_fail: next }, questionHubspotRecordId: null }],
          bumpStatusToInProgress: true,
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      markSaved();
    } catch (e: any) {
      markSaveError();
      setLines((cur) => cur.map((l) => (l.recordId === line.recordId ? { ...l, passFail: line.passFail } : l)));
      void dialog.alert(`Could not save pass/fail: ${e?.message || e}`);
    }
    if (next !== 'fail' && line.qcFailureNote) void saveFailureNote(line.recordId, ''); // best-effort clear
  }

  // Local edit of a fail line's note (persisted on blur via saveFailureNote).
  function updateFailureNote(recordId: string, text: string) {
    setLines((cur) => cur.map((l) => (l.recordId === recordId ? { ...l, qcFailureNote: text } : l)));
  }

  // Persist a line's QC failure note. Separate from pass/fail so a missing
  // qc_failure_note property (pre-/admin/setup) can't break pass/fail saving.
  async function saveFailureNote(recordId: string, text: string) {
    markSaving();
    try {
      const r = await fetch(`/api/inspections/${props.inspectionRecordId}/answers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          upserts: [{ recordId, answerProps: { qc_failure_note: text }, questionHubspotRecordId: null }],
          bumpStatusToInProgress: true,
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      markSaved();
    } catch (e: any) {
      markSaveError();
      void dialog.alert(`Could not save the failure note (run /admin/setup if this persists): ${e?.message || e}`);
    }
  }

  // Burn each tagged After photo's line label into the image before submit, so
  // the QC PDF shows which line each photo evidences (idempotent; tagging stays
  // non-destructive until this terminal step).
  async function burnTaggedLabelsQc() {
    for (const sec of sections) {
      if (sec.lines.length === 0) continue;
      const after = [...(afterPhotos[sec.key] || [])];
      const swaps = new Map<string, string>();
      for (let i = 0; i < after.length; i++) {
        const url = after[i];
        if (isStamped(url)) continue;
        const taggedLines = sec.lines.filter((l) => (l.photoUrls || []).includes(url));
        if (taggedLines.length === 0) continue;
        const label = taggedLines.map((l) => l.description || l.lineItemCode).join(' · ');
        try {
          const stamped = await stampEntryWithLabel(url, label);
          if (stamped && stamped !== url) { after[i] = stamped; swaps.set(url, stamped); }
        } catch (e) { console.warn('[QC burnTaggedLabels] stamp failed:', e); }
      }
      if (swaps.size > 0) {
        setAfterPhotos((cur) => ({ ...cur, [sec.key]: after }));
        await persistAfterPhotos(sec.key, sec.section, sec.location, after);
        for (const line of sec.lines) {
          if (!(line.photoUrls || []).some((u) => swaps.has(u))) continue;
          await saveLinePhotos(line.recordId, (line.photoUrls || []).map((u) => swaps.get(u) || u));
        }
      }
    }
  }

  async function handleSubmit() {
    if (submittingRef.current) return;
    if (!allMarked) { void dialog.alert('Every line item must be marked Pass or Fail before submitting.'); return; }
    // A failed line MUST have a note explaining what failed (for the vendor/MC).
    const failMissingNote = lines.find((l) => l.passFail === 'fail' && !(l.qcFailureNote || '').trim());
    if (failMissingNote) {
      void dialog.alert(`Add a note on every FAILED line explaining what failed and what's needed to correct it.\n\nMissing: ${failMissingNote.description || failMissingNote.lineItemCode}`);
      return;
    }
    if (!allSectionsHaveAfter) { void dialog.alert('Every section needs at least one After Photo before submitting.'); return; }
    if (verdict !== 'pass' && verdict !== 'fail') { void dialog.alert('Select an overall Pass or Fail verdict.'); return; }
    // A failing overall verdict REQUIRES a comment — it prints on the QC PDF.
    if (verdict === 'fail' && !overallNote.trim()) {
      void dialog.alert('Add an overall failure comment explaining why the re-inspect failed — it’s included on the report.');
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await burnTaggedLabelsQc();
      const r = await fetch(`/api/inspections/${props.inspectionRecordId}/qc-finalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verdict, overallNote: verdict === 'fail' ? overallNote.trim() : '' }),
      });
      if (!r.ok) { const t = await r.text(); throw new Error(`HTTP ${r.status}: ${t.slice(0, 300)}`); }
      setResult(await r.json());
    } catch (e: any) {
      void dialog.alert(`Submit failed: ${e?.message || e}`);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  if (loading) return <div className="text-sm text-gray-500 py-8 text-center">Loading inspection...</div>;
  if (loadError) return <div className="text-sm text-red-600 py-8 text-center">Could not load: {loadError}</div>;

  return (
    <div className="max-w-7xl mx-auto px-5 sm:px-6 py-4 md:pb-24">
      <header className="mb-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h1 className="text-xl font-bold text-gray-900">{props.templateLabel}</h1>
              <span className="text-sm text-gray-700 font-semibold">&mdash; {props.propertyName}</span>
            </div>
            <div className="text-xs text-gray-500 mt-1">
              Inspector: {props.inspectorName} &middot; {props.bedrooms} bed / {props.bathrooms} bath
              {props.squareFootage != null && props.squareFootage > 0 && (
                <span> &middot; {props.squareFootage.toLocaleString()} sqft</span>
              )}
              {sourceName && <span> &middot; Validating: {sourceName}</span>}
            </div>
          </div>
          {/* Unlock (Rently code) inline to the LEFT of Back — hidden once
              read-only (completed). */}
          <div className="flex-shrink-0 self-start flex flex-row items-center gap-2">
            {!props.readOnly && (
              <UnlockButton
                propertyId={props.propertyRecordId}
                address={props.propertyName}
                inspectionName={props.templateLabel}
                inspectionId={props.inspectionRecordId}
                compact
              />
            )}
            <button
              type="button"
              onClick={props.onCancel}
              className="inline-flex items-center gap-1 text-sm font-semibold text-gray-700 hover:text-gray-900 border border-gray-300 hover:border-gray-400 rounded-lg px-3 py-1.5 bg-white"
              title="Go back"
            >
              <span aria-hidden>&larr;</span> Back
            </button>
          </div>
        </div>
      </header>

      <div className="sticky top-0 z-10 -mx-5 sm:-mx-6 px-5 sm:px-6 py-2 mb-3 bg-white border-b border-gray-200 shadow-sm">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm font-semibold text-gray-700">{lines.length} items</span>
            {assignedVendors.length > 0 && (
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
            )}
            {sections.length > 1 && (
              <button
                type="button"
                onClick={() => setAllCollapsed(!allCollapsed)}
                className="inline-flex items-center gap-1 text-xs font-heading text-gray-500 hover:text-gray-800 transition-colors"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                     className={`transition-transform ${allCollapsed ? 'rotate-180' : ''}`}>
                  <polyline points="18 15 12 9 6 15" />
                </svg>
                {allCollapsed ? 'Expand all' : 'Collapse all'}
              </button>
            )}
          </div>
          <div className="flex items-center gap-4 text-sm font-bold">
            <span className="text-emerald-600">{totalPass} pass</span>
            <span className="text-gray-300">&middot;</span>
            <span className="text-brand">{totalFail} fail</span>
          </div>
        </div>
      </div>

      {props.readOnly && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm text-amber-900 mb-3">
          This inspection is completed and read-only.
        </div>
      )}

      {visibleSections.map((s) => {
        const secPass = s.lines.filter((l) => l.passFail === 'pass').length;
        const secFail = s.lines.filter((l) => l.passFail === 'fail').length;
        const after = afterPhotos[s.key] || [];
        const isCollapsed = collapsed.has(s.key);
        return (
          <section key={s.key} className="mb-4 border border-gray-200 rounded-xl overflow-hidden shadow-md">
            <button
              type="button"
              onClick={() => toggleCollapse(s.key)}
              className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-50 border-b border-gray-200 text-left"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className={'text-gray-400 transition-transform ' + (isCollapsed ? '' : 'rotate-90')}>&#9654;</span>
                <h2 className="font-bold text-sm text-gray-900 truncate">{s.displayName}</h2>
                <span className="text-xs text-gray-400">&middot; {s.lines.length} {s.lines.length === 1 ? 'line' : 'lines'}</span>
              </div>
              <div className="text-xs font-bold shrink-0">
                <span className="text-emerald-600">{secPass} pass</span>
                <span className="text-gray-300"> &middot; </span>
                <span className="text-brand">{secFail} fail</span>
              </div>
            </button>

            {!isCollapsed && (
              <>
                <div className="px-4 py-3 grid grid-cols-2 gap-3 border-b border-gray-100">
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-2.5 min-w-0">
                    <PhotoStrip
                      label="Before"
                      photoUrls={cameraOpenAnywhere ? [] : s.beforePhotos}
                      size={64}
                      accent="gray"
                      emptyLabel="No before photos on source"
                      collapsed={!!photosCollapsed[s.key]}
                      onToggle={() => setPhotosCollapsed((c) => ({ ...c, [s.key]: !c[s.key] }))}
                      onPhotoClick={(i) => setQcLightbox({ phase: 'before', key: s.key, index: i })}
                    />
                  </div>

                  <div className="rounded-lg border-2 border-teal-300 bg-teal-50/60 p-2.5 min-w-0">
                    <PhotoStrip
                      label={after.length === 0 ? 'After • required' : 'After'}
                      photoUrls={cameraOpenAnywhere ? [] : after}
                      size={64}
                      accent="teal"
                      collapsed={!!photosCollapsed[s.key]}
                      onToggle={() => setPhotosCollapsed((c) => ({ ...c, [s.key]: !c[s.key] }))}
                      onRemove={props.readOnly ? undefined : (u) => removeAfterPhoto(s.key, s.section, s.location, u)}
                      onPhotoClick={(i) => setQcLightbox({ phase: 'after', key: s.key, index: i })}
                    >
                      {!props.readOnly && (
                        <button
                          type="button"
                          onClick={() => setCameraKey(s.key)}
                          className="text-xs font-semibold bg-teal-600 text-white rounded px-2 py-1.5 hover:bg-teal-700 whitespace-nowrap"
                        >Take Photo</button>
                      )}
                    </PhotoStrip>
                  </div>
                </div>

                {/* Desktop: full table (horizontal scroll if needed) */}
                <div className="overflow-x-auto hidden sm:block">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-200">
                        <th className="px-3 py-2 font-semibold">Category</th>
                        <th className="px-3 py-2 font-semibold">Sub</th>
                        <th className="px-3 py-2 font-semibold">Line Item</th>
                        <th className="px-3 py-2 font-semibold text-center">Qty</th>
                        <th className="px-3 py-2 font-semibold text-center">Unit</th>
                        <th className="px-3 py-2 font-semibold text-center">Vendor</th>
                        <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">Vendor $</th>
                        <th className="px-3 py-2 font-semibold text-center">Result</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {s.lines.map((ln) => (
                        <Fragment key={ln.recordId}>
                        <tr className="align-top">
                          <td className="px-3 py-2.5 text-gray-700 whitespace-nowrap">{ln.category}</td>
                          <td className="px-3 py-2.5 text-gray-700 whitespace-nowrap">{ln.subcategory}</td>
                          <td className="px-3 py-2.5 text-gray-900 min-w-[200px]">
                            {ln.description}
                            {ln.scopeNote && (
                              <div className="text-xs text-gray-500 italic mt-1">📝 Scope note: {ln.scopeNote}</div>
                            )}
                          </td>
                          <td className="px-3 py-2.5 text-center text-gray-600 tabular-nums whitespace-nowrap">{ln.quantity != null ? formatQty(ln.quantity) : ''}</td>
                          <td className="px-3 py-2.5 text-center text-gray-600">{ln.unit}</td>
                          <td className="px-3 py-2.5 text-center">
                            {ln.vendor && (() => {
                              const ps = vendorPillStyle(ln.vendor);
                              return (
                                <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${ps.bg} ${ps.text} ${ps.border || ''}`}>
                                  {ln.vendor}
                                </span>
                              );
                            })()}
                          </td>
                          <td className="px-3 py-2.5 text-right text-gray-900 whitespace-nowrap">{ln.vendorCost != null ? `$${formatMoney(ln.vendorCost)}` : ''}</td>
                          <td className="px-3 py-2.5">
                            <div className="flex items-center justify-center gap-1.5">
                              <button
                                type="button"
                                disabled={props.readOnly}
                                onClick={() => setLinePassFail(ln, 'pass')}
                                className={
                                  'w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold border transition ' +
                                  (ln.passFail === 'pass'
                                    ? 'bg-emerald-600 text-white border-emerald-600'
                                    : 'bg-white text-emerald-600 border-emerald-300 hover:border-emerald-500')
                                }
                                title="Pass"
                              >&#10003;</button>
                              <button
                                type="button"
                                disabled={props.readOnly}
                                onClick={() => setLinePassFail(ln, 'fail')}
                                className={
                                  'w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold border transition ' +
                                  (ln.passFail === 'fail'
                                    ? 'bg-brand text-white border-brand'
                                    : 'bg-white text-brand border-brand/40 hover:border-brand')
                                }
                                title="Fail"
                              >&#10007;</button>
                            </div>
                          </td>
                        </tr>
                        {ln.passFail === 'fail' && (
                          <tr>
                            <td colSpan={8} className="px-3 pb-3 pt-0 bg-brand/5">
                              <label className="block text-[11px] font-heading font-semibold text-brand mb-1">Failure note (required) — what failed &amp; how to fix it</label>
                              <textarea
                                value={ln.qcFailureNote || ''}
                                disabled={props.readOnly}
                                onChange={(e) => updateFailureNote(ln.recordId, e.target.value)}
                                onBlur={(e) => saveFailureNote(ln.recordId, e.target.value.trim())}
                                rows={2}
                                placeholder="e.g. Paint touch-up missed the north wall; re-coat and feather edges."
                                className="focus-brand w-full border border-brand/40 rounded-lg p-2 text-sm bg-white"
                              />
                            </td>
                          </tr>
                        )}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Mobile: stacked cards.
                    Cat · Sub · Short Desc  /  Subtext  /  Vendor · Qty Unit · Price
                    with pass/fail on the right. */}
                <div className="sm:hidden divide-y divide-gray-100 px-1">
                  {s.lines.map((ln) => {
                    const ps = ln.vendor ? vendorPillStyle(ln.vendor) : null;
                    return (
                      <div key={ln.recordId} className="py-3 px-2">
                       <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1 space-y-1">
                          {/* Line 1: Category · Sub · Short description */}
                          <div className="text-sm font-semibold text-gray-900 leading-snug">
                            <span className="text-gray-500 font-normal">
                              {ln.category}{ln.subcategory ? ` · ${ln.subcategory}` : ''} ·{' '}
                            </span>
                            {ln.description}
                          </div>
                          {/* Line 2: Subtext (only if present + different) */}
                          {ln.subtext && (
                            <div className="text-xs text-gray-500 leading-snug">{ln.subtext}</div>
                          )}
                          {/* Line 3: Vendor · Qty Unit · Price */}
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-600 pt-0.5">
                            {ps && (
                              <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${ps.bg} ${ps.text} ${ps.border || ''}`}>
                                {ln.vendor}
                              </span>
                            )}
                            {ln.unit && <span>{ln.quantity != null ? `${formatQty(ln.quantity)} ` : ''}{ln.unit}</span>}
                            {ln.vendorCost != null && (<><span>·</span><span className="text-gray-800 font-semibold">${formatMoney(ln.vendorCost)}</span></>)}
                          </div>
                        </div>
                        {/* Pass / fail */}
                        <div className="flex items-center gap-2 shrink-0 pt-0.5">
                          <button
                            type="button"
                            disabled={props.readOnly}
                            onClick={() => setLinePassFail(ln, 'pass')}
                            className={
                              'w-10 h-9 rounded-lg flex items-center justify-center text-sm font-bold border transition ' +
                              (ln.passFail === 'pass'
                                ? 'bg-emerald-600 text-white border-emerald-600'
                                : 'bg-white text-emerald-600 border-emerald-300')
                            }
                            aria-label="Pass"
                          >&#10003;</button>
                          <button
                            type="button"
                            disabled={props.readOnly}
                            onClick={() => setLinePassFail(ln, 'fail')}
                            className={
                              'w-10 h-9 rounded-lg flex items-center justify-center text-sm font-bold border transition ' +
                              (ln.passFail === 'fail'
                                ? 'bg-brand text-white border-brand'
                                : 'bg-white text-brand border-brand/40')
                            }
                            aria-label="Fail"
                          >&#10007;</button>
                        </div>
                       </div>
                       {/* Scope note (read-only reference: what to look for). */}
                       {ln.scopeNote && (
                         <div className="text-xs text-gray-500 italic mt-2 border-t border-gray-100 pt-2">📝 Scope note: {ln.scopeNote}</div>
                       )}
                       {/* Required failure note when failed. */}
                       {ln.passFail === 'fail' && (
                         <div className="mt-2">
                           <label className="block text-[11px] font-heading font-semibold text-brand mb-1">Failure note (required) — what failed &amp; how to fix it</label>
                           <textarea
                             value={ln.qcFailureNote || ''}
                             disabled={props.readOnly}
                             onChange={(e) => updateFailureNote(ln.recordId, e.target.value)}
                             onBlur={(e) => saveFailureNote(ln.recordId, e.target.value.trim())}
                             rows={2}
                             placeholder="e.g. Paint touch-up missed the north wall; re-coat and feather edges."
                             className="focus-brand w-full border border-brand/40 rounded-lg p-2 text-sm bg-white"
                           />
                         </div>
                       )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </section>
        );
      })}

      {lines.length === 0 && (
        <div className="text-sm text-gray-500 py-8 text-center border border-gray-200 rounded-xl">
          No line items were copied from the source inspection.
        </div>
      )}

      {!props.readOnly && (
        <div className="border-2 border-gray-200 rounded-xl p-4 mb-4 mt-4">
          <div className="text-sm font-bold text-gray-900 mb-2">Overall Inspection Result</div>
          <div className="flex items-center gap-3 mb-2">
            <button
              type="button"
              onClick={() => setVerdict('pass')}
              className={
                'flex-1 py-3 rounded-lg font-bold border-2 transition ' +
                (verdict === 'pass' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-emerald-600 border-emerald-300 hover:border-emerald-500')
              }
            >&#10003; Pass</button>
            <button
              type="button"
              onClick={() => setVerdict('fail')}
              className={
                'flex-1 py-3 rounded-lg font-bold border-2 transition ' +
                (verdict === 'fail' ? 'bg-brand text-white border-brand' : 'bg-white text-brand border-brand/40 hover:border-brand')
              }
            >&#10007; Fail</button>
          </div>

          {/* Required overall failure comment (Fail only) — printed on the PDF. */}
          {verdict === 'fail' && (
            <div className="mb-2">
              <label className="block text-[11px] font-heading font-semibold text-brand mb-1">Overall failure comment (required) — why the re-inspect failed</label>
              <textarea
                value={overallNote}
                onChange={(e) => setOverallNote(e.target.value)}
                rows={3}
                placeholder="Summarize what failed overall and what's needed to pass the re-inspect."
                className="focus-brand w-full border border-brand/40 rounded-lg p-2 text-sm bg-white"
              />
            </div>
          )}

          {(!allMarked || !allSectionsHaveAfter || !verdict || (verdict === 'fail' && !overallNote.trim())) && (
            <ul className="text-xs text-amber-700 list-disc pl-5 space-y-0.5">
              {!allMarked && <li>Mark every line item Pass or Fail.</li>}
              {!allSectionsHaveAfter && <li>Add at least one After Photo to every section.</li>}
              {!verdict && <li>Choose an overall Pass/Fail verdict.</li>}
              {verdict === 'fail' && !overallNote.trim() && <li>Add an overall failure comment.</li>}
            </ul>
          )}
        </div>
      )}

      {/* Spacer so the fixed footer doesn't cover the last content */}
      {!props.readOnly && <div className="h-20" />}

      {/* Floating footer — same pattern as the Scope Rate Card. Cancel
          Inspection / Save & Close / Submit Inspection, with a live save
          status chip. Shown for editable inspections. */}
      {!props.readOnly && (
        <div className="fixed bottom-0 inset-x-0 bg-white border-t-2 border-gray-200 shadow-[0_-4px_10px_rgba(0,0,0,0.05)] z-30">
          <div className="max-w-7xl mx-auto px-3 sm:px-4 py-2.5 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              {props.onCancelInspection && (
                <button
                  type="button"
                  onClick={props.onCancelInspection}
                  className="px-2.5 sm:px-4 py-2 text-xs sm:text-sm border border-red-300 text-red-700 rounded hover:bg-red-50 whitespace-nowrap"
                >
                  Cancel
                </button>
              )}
              <span className="hidden sm:inline-flex"><SaveStatusChip status={saveStatus} /></span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={props.onCancel}
                className="px-2.5 sm:px-4 py-2 text-xs sm:text-sm border border-emerald-300 text-emerald-700 rounded hover:bg-emerald-600 hover:text-white hover:border-emerald-600 active:bg-emerald-700 active:border-emerald-700 transition-colors whitespace-nowrap"
              >
                Save &amp; Close
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting || !allMarked || !allSectionsHaveAfter || !verdict}
                className="px-3 sm:px-5 py-2 text-xs sm:text-sm bg-brand text-white font-semibold rounded hover:bg-brand-dark disabled:bg-gray-300 disabled:cursor-not-allowed whitespace-nowrap"
              >
                {submitting ? 'Submitting...' : 'Submit'}
              </button>
            </div>
          </div>
        </div>
      )}

      {cameraKey != null && (
        <CameraCapture
          isOpen={true}
          addressSnapshot={props.propertyName}
          propertyRecordId={props.propertyRecordId}
          onClose={() => setCameraKey(null)}
          uploadPhoto={uploadHelper}
          uploadVideoEntry={(videoFile, posterFile) => uploadVideoEntryOrQueue(videoFile, posterFile, props.inspectionRecordId, cameraKey || '')}
          rooms={sections.map((s) => {
            const roomPhotos = afterPhotos[s.key] || [];
            const count = roomPhotos.length;
            return {
              id: s.key,
              name: s.displayName,
              photoCount: count,
              needsPhotos: count === 0, // QC requires an after-photo per section
              photos: roomPhotos,
            };
          })}
          currentRoomId={cameraKey}
          tagLines={(sections.find((s) => s.key === cameraKey)?.lines || [])
            .map((l) => ({ externalId: l.recordId, label: l.description || l.lineItemCode }))}
          onTagPhotoToLine={tagCameraPhotoToLineQc}
          onRoomChange={(leavingKey, capturedUrls, enteringKey) => {
            if (capturedUrls.length > 0) {
              const sec = sections.find((s) => s.key === leavingKey);
              if (sec) addAfterPhotos(sec.key, sec.section, sec.location, capturedUrls);
            }
            setCameraKey(enteringKey);
          }}
          onComplete={(urls) => {
            const sec = sections.find((s) => s.key === cameraKey);
            if (sec) addAfterPhotos(sec.key, sec.section, sec.location, urls);
            setCameraKey(null);
          }}
        />
      )}

      {result && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-5">
            <div className={'text-lg font-bold mb-1 ' + (result.verdict === 'pass' ? 'text-emerald-700' : 'text-brand')}>
              {result.verdict === 'pass' ? 'QC Passed' : 'QC Failed'}
            </div>
            <div className="text-sm text-gray-600 mb-4">{result.passCount} passed &middot; {result.failCount} failed</div>
            {result.resultSync && !result.resultSync.verdictSynced && (
              <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mb-3">
                Heads up: the report saved, but the overall verdict couldn’t be written to the inspection
                record (the QC result fields aren’t set up in HubSpot yet). Ask an admin to provision them.
              </div>
            )}
            <a
              href={result.pdf.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block w-full text-center py-2.5 rounded-lg font-semibold text-brand border border-brand/40 hover:bg-brand/5 mb-2"
            >Download QC Report (PDF)</a>
            <button
              type="button"
              onClick={() => { setResult(null); props.onSubmit(); }}
              className="w-full py-2.5 rounded-lg font-semibold text-white bg-gray-800 hover:bg-gray-900"
            >Done</button>
          </div>
        </div>
      )}

      {/* Photo viewer (swipe / markup / delete / tag-to-line / video) */}
      {qcLightbox && (() => {
        const isAfter = qcLightbox.phase === 'after';
        const photosByGroup = Object.fromEntries(
          sections.map((s) => [s.key, (isAfter ? (afterPhotos[s.key] || []) : s.beforePhotos)])
        );
        if ((photosByGroup[qcLightbox.key] || []).length === 0) return null;
        const groups = sections.map((s) => ({ id: s.key, name: s.displayName }));
        const secOf = (gid: string) => sections.find((s) => s.key === gid);
        return (
          <PhotoLightbox
            groups={groups}
            photosByGroup={photosByGroup}
            initialGroupId={qcLightbox.key}
            initialIndex={qcLightbox.index}
            // Before photos are the read-only source; After is editable.
            readOnly={!isAfter || props.readOnly}
            onClose={() => setQcLightbox(null)}
            onDelete={(gid, i) => {
              const sec = secOf(gid); if (!sec) return;
              const url = (afterPhotos[gid] || [])[i];
              if (url) removeAfterPhoto(sec.key, sec.section, sec.location, url);
            }}
            onReplace={(gid, i, file) => {
              const sec = secOf(gid); if (!sec) return;
              replaceAfterPhoto(sec.key, sec.section, sec.location, i, file);
            }}
            tagLinesByGroup={isAfter && !props.readOnly
              ? Object.fromEntries(sections.map((s) => [
                  s.key,
                  s.lines.map((l) => ({ externalId: l.recordId, label: l.description || l.lineItemCode })),
                ]))
              : undefined}
            onTagToLine={isAfter && !props.readOnly
              ? (gid, i, lineRecordId) => { if (secOf(gid)) tagAfterPhotoToLine(gid, i, lineRecordId); }
              : undefined}
            onUntagFromLine={isAfter && !props.readOnly
              ? (gid, i, lineRecordId) => { if (secOf(gid)) untagAfterPhotoFromLine(gid, i, lineRecordId); }
              : undefined}
            currentTagsFor={isAfter ? (gid, i) => currentTagsForAfter(gid, i) : undefined}
          />
        );
      })()}
    </div>
  );
}

/** Small live save-status indicator, mirrors the Scope Rate Card footer. */
function SaveStatusChip({ status }: { status: 'idle' | 'saving' | 'saved' | 'error' }) {
  if (status === 'idle') return null;
  const map = {
    saving: { text: 'Saving…', cls: 'text-gray-500' },
    saved: { text: 'All changes saved', cls: 'text-emerald-600' },
    error: { text: 'Save failed — retry', cls: 'text-red-600' },
  } as const;
  const m = map[status];
  return <span className={`text-xs font-heading font-semibold ${m.cls}`}>{m.text}</span>;
}
