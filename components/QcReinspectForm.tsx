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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { uploadFilesBatch, uploadPhoto, formatMoney } from '@/lib/photoUpload';
import { CameraCapture } from '@/components/CameraCapture';
import { PhotoLightbox } from '@/components/PhotoLightbox';
import { vendorPillStyle } from '@/lib/vendors';
import { PhotoStrip } from '@/components/PhotoStrip';
import { useAppDialog } from '@/components/AppDialog';
import { buildSectionPhotoAnswerProps, joinPhotoUrls } from '@/lib/answerProps';
import { stampEntryWithLabel } from '@/lib/photoStamp';

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
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<null | { verdict: string; passCount: number; failCount: number; pdf: { name: string; url: string } }>(null);
  const [cameraKey, setCameraKey] = useState<string | null>(null);
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

  function markSaving() { setSaveStatus('saving'); }
  function markSaved() {
    setSaveStatus('saved');
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    savedTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000);
  }
  function markSaveError() { setSaveStatus('error'); }
  useEffect(() => () => { if (savedTimerRef.current) clearTimeout(savedTimerRef.current); }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const r = await fetch(`/api/inspections/${props.inspectionRecordId}/qc-data`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        if (cancelled) return;
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
      } catch (e: any) {
        if (!cancelled) setLoadError(String(e?.message || e));
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

  const totalPass = lines.filter((l) => l.passFail === 'pass').length;
  const totalFail = lines.filter((l) => l.passFail === 'fail').length;
  const allMarked = lines.length > 0 && lines.every((l) => l.passFail === 'pass' || l.passFail === 'fail');
  const allSectionsHaveAfter = sections.every((s) => (afterPhotos[s.key] || []).length > 0);

  const uploadHelper = useCallback((file: File) => uploadPhoto(file), []);

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

  async function persistAfterPhotos(key: string, section: string, location: string, urls: string[]) {
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

  async function handleFilePick(key: string, section: string, location: string, files: FileList | null) {
    if (!files || files.length === 0) return;
    const uploaded: string[] = [];
    await uploadFilesBatch(Array.from(files), (url) => uploaded.push(url));
    await addAfterPhotos(key, section, location, uploaded);
  }

  async function removeAfterPhoto(key: string, section: string, location: string, url: string) {
    const merged = (afterPhotos[key] || []).filter((u) => u !== url);
    setAfterPhotos((cur) => ({ ...cur, [key]: merged }));
    try { await persistAfterPhotos(key, section, location, merged); }
    catch (e: any) { void dialog.alert(`Could not update photos: ${e?.message || e}`); }
  }

  // Tag a freshly-captured photo to a QC line FROM INSIDE THE CAMERA (mirrors
  // Scope). Stamps the label, attaches to the line record, returns the stamped
  // URL so the camera carries it into the After strip on close.
  async function tagCameraPhotoToLineQc(url: string, lineRecordId: string): Promise<string> {
    const line = lines.find((l) => l.recordId === lineRecordId);
    if (!line) return url;
    let tagged = url;
    try { tagged = await stampEntryWithLabel(url, line.description || line.lineItemCode); }
    catch (e) { console.warn('[QC] camera tag stamp failed:', e); }
    const linePhotos = line.photoUrls || [];
    if (!linePhotos.includes(tagged)) {
      const next = [...linePhotos, tagged];
      setLines((cur) => cur.map((l) => (l.recordId === lineRecordId ? { ...l, photoUrls: next } : l)));
      try {
        markSaving();
        const r = await fetch(`/api/inspections/${props.inspectionRecordId}/answers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            upserts: [{
              recordId: lineRecordId,
              answerProps: { photo_urls: joinPhotoUrls(next), photo_count: next.length },
              questionHubspotRecordId: null,
            }],
          }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        markSaved();
      } catch (e: any) { markSaveError(); }
    }
    return tagged;
  }

  // Swap an After photo for its marked-up version (re-upload + replace, persist).
  async function replaceAfterPhoto(key: string, section: string, location: string, index: number, file: File) {
    try {
      const url = await uploadPhoto(file);
      const arr = [...(afterPhotos[key] || [])];
      if (index < 0 || index >= arr.length) return;
      arr[index] = url;
      setAfterPhotos((cur) => ({ ...cur, [key]: arr }));
      await persistAfterPhotos(key, section, location, arr);
    } catch (e: any) { void dialog.alert(`Could not update photo: ${e?.message || e}`); }
  }

  // Tag an After photo to one of the section's QC lines: stamp the line label
  // onto the photo, attach it to that line's record (so it shows under the line
  // in the scope/PDF), and keep it in the After strip — mirroring Scope.
  async function tagAfterPhotoToLine(key: string, section: string, location: string, index: number, lineRecordId: string) {
    const url = (afterPhotos[key] || [])[index];
    const line = lines.find((l) => l.recordId === lineRecordId);
    if (!url || !line) return;
    let tagged = url;
    try { tagged = await stampEntryWithLabel(url, line.description || line.lineItemCode); }
    catch (e) { console.warn('[QC] tag stamp failed:', e); }

    // Attach to the line record (append to its photo_urls).
    const linePhotos = line.photoUrls || [];
    if (!linePhotos.includes(tagged)) {
      const nextLinePhotos = [...linePhotos, tagged];
      setLines((cur) => cur.map((l) => (l.recordId === lineRecordId ? { ...l, photoUrls: nextLinePhotos } : l)));
      try {
        markSaving();
        const r = await fetch(`/api/inspections/${props.inspectionRecordId}/answers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            upserts: [{
              recordId: lineRecordId,
              answerProps: { photo_urls: joinPhotoUrls(nextLinePhotos), photo_count: nextLinePhotos.length },
              questionHubspotRecordId: null,
            }],
          }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        markSaved();
      } catch (e: any) { markSaveError(); void dialog.alert(`Could not tag photo to line: ${e?.message || e}`); }
    }

    // Swap the stamped version into the After strip so the label shows there too.
    if (tagged !== url) {
      const arr = [...(afterPhotos[key] || [])];
      arr[index] = tagged;
      setAfterPhotos((cur) => ({ ...cur, [key]: arr }));
      try { await persistAfterPhotos(key, section, location, arr); } catch { /* best-effort */ }
    }
  }

  async function setLinePassFail(line: QcLine, pf: 'pass' | 'fail') {
    const next = line.passFail === pf ? '' : pf;
    setLines((cur) => cur.map((l) => (l.recordId === line.recordId ? { ...l, passFail: next } : l)));
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
  }

  async function handleSubmit() {
    if (!allMarked) { void dialog.alert('Every line item must be marked Pass or Fail before submitting.'); return; }
    if (!allSectionsHaveAfter) { void dialog.alert('Every section needs at least one After Photo before submitting.'); return; }
    if (verdict !== 'pass' && verdict !== 'fail') { void dialog.alert('Select an overall Pass or Fail verdict.'); return; }
    setSubmitting(true);
    try {
      const r = await fetch(`/api/inspections/${props.inspectionRecordId}/qc-finalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verdict }),
      });
      if (!r.ok) { const t = await r.text(); throw new Error(`HTTP ${r.status}: ${t.slice(0, 300)}`); }
      setResult(await r.json());
    } catch (e: any) {
      void dialog.alert(`Submit failed: ${e?.message || e}`);
    } finally {
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
          <button
            type="button"
            onClick={props.onCancel}
            className="flex-shrink-0 inline-flex items-center gap-1 text-sm font-semibold text-gray-700 hover:text-gray-900 border border-gray-300 hover:border-gray-400 rounded-lg px-3 py-1.5 bg-white"
            title="Go back"
          >
            <span aria-hidden>&larr;</span> Back
          </button>
        </div>
      </header>

      <div className="sticky top-0 z-10 -mx-5 sm:-mx-6 px-5 sm:px-6 py-2 mb-3 bg-white border-b border-gray-200 shadow-sm">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold text-gray-700">{lines.length} items</span>
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

      {sections.map((s) => {
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
                      photoUrls={s.beforePhotos}
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
                      photoUrls={after}
                      size={64}
                      accent="teal"
                      collapsed={!!photosCollapsed[s.key]}
                      onToggle={() => setPhotosCollapsed((c) => ({ ...c, [s.key]: !c[s.key] }))}
                      onRemove={props.readOnly ? undefined : (u) => removeAfterPhoto(s.key, s.section, s.location, u)}
                      onPhotoClick={(i) => setQcLightbox({ phase: 'after', key: s.key, index: i })}
                    >
                      {!props.readOnly && (
                        <div className="flex items-center gap-1.5 flex-nowrap">
                          <button
                            type="button"
                            onClick={() => setCameraKey(s.key)}
                            className="text-xs font-semibold bg-teal-600 text-white rounded px-2 py-1.5 hover:bg-teal-700 whitespace-nowrap"
                          >Take Photo</button>
                          <label className="text-xs font-semibold text-teal-700 border border-teal-300 rounded px-2 py-1.5 cursor-pointer hover:border-teal-400 bg-white whitespace-nowrap">
                            Upload
                            <input
                              type="file" accept="image/*" multiple className="hidden"
                              onChange={(e) => { handleFilePick(s.key, s.section, s.location, e.target.files); e.currentTarget.value = ''; }}
                            />
                          </label>
                        </div>
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
                        <th className="px-3 py-2 font-semibold text-right">Vendor $</th>
                        <th className="px-3 py-2 font-semibold text-center">Result</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {s.lines.map((ln) => (
                        <tr key={ln.recordId} className="align-top">
                          <td className="px-3 py-2.5 text-gray-700 whitespace-nowrap">{ln.category}</td>
                          <td className="px-3 py-2.5 text-gray-700 whitespace-nowrap">{ln.subcategory}</td>
                          <td className="px-3 py-2.5 text-gray-900 min-w-[200px]">{ln.description}</td>
                          <td className="px-3 py-2.5 text-center text-gray-600">{ln.quantity != null ? ln.quantity : ''}</td>
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
                      <div key={ln.recordId} className="py-3 px-2 flex items-start justify-between gap-3">
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
                            {ln.unit && <span>{ln.quantity != null ? `${ln.quantity} ` : ''}{ln.unit}</span>}
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

          {(!allMarked || !allSectionsHaveAfter || !verdict) && (
            <ul className="text-xs text-amber-700 list-disc pl-5 space-y-0.5">
              {!allMarked && <li>Mark every line item Pass or Fail.</li>}
              {!allSectionsHaveAfter && <li>Add at least one After Photo to every section.</li>}
              {!verdict && <li>Choose an overall Pass/Fail verdict.</li>}
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
          rooms={sections.map((s) => {
            const count = (afterPhotos[s.key] || []).length;
            return {
              id: s.key,
              name: s.displayName,
              photoCount: count,
              needsPhotos: count === 0, // QC requires an after-photo per section
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
              ? (gid, i, lineRecordId) => {
                  const sec = secOf(gid); if (!sec) return;
                  tagAfterPhotoToLine(sec.key, sec.section, sec.location, i, lineRecordId);
                }
              : undefined}
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
