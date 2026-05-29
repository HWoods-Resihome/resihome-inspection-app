/**
 * QcReinspectForm — the (PM) Turn Re-Inspect QC inspection form.
 *
 * Validates that a vendor completed the work dispatched on a Scope Rate Card.
 * The QC's line items are copied (snapshotted) from the source at create time;
 * this form loads them via /api/inspections/[id]/qc-data along with the
 * source's section photos (shown as "Before") and the QC's own "After" photos.
 *
 * Per section the inspector:
 *   - reviews Before photos (read-only, from source)
 *   - captures After photos (required to submit)
 *   - marks each line item Pass or Fail (chip)
 * Section headers tally pass/fail counts (like the cost totals on Scope).
 * At the bottom the inspector marks the overall verdict (manual) and Submits.
 *
 * Submit (no approval step) -> /api/inspections/[id]/qc-finalize which renders
 * the PDF, stores verdict + counts, flips to completed. Mirrors the 1099 flow.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { uploadFilesBatch, uploadPhoto, formatMoney } from '@/lib/photoUpload';
import { CameraCapture } from '@/components/CameraCapture';

interface QcLine {
  recordId: string;
  section: string;
  location: string;
  description: string;
  quantity: number | null;
  vendor: string;
  vendorCost: number | null;
  passFail: 'pass' | 'fail' | '';
}

interface Props {
  inspectionRecordId: string;
  templateLabel: string;
  inspectorName: string;
  propertyName: string;
  bedrooms: number;
  bathrooms: number;
  squareFootage: number | null;
  inspectionStatus: string;
  readOnly: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}

interface SectionGroup {
  key: string;           // `${section}||${location}`
  displayName: string;
  location: string;
  section: string;
  lines: QcLine[];
  beforePhotos: string[];
}

export function QcReinspectForm(props: Props) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lines, setLines] = useState<QcLine[]>([]);
  const [beforePhotos, setBeforePhotos] = useState<Record<string, string[]>>({});
  const [afterPhotos, setAfterPhotos] = useState<Record<string, string[]>>({});
  const [afterPhotoRecordIds, setAfterPhotoRecordIds] = useState<Record<string, string>>({});
  const [sourceName, setSourceName] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<'pass' | 'fail' | ''>('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<null | { verdict: string; passCount: number; failCount: number; pdf: { name: string; url: string } }>(null);
  const [cameraLoc, setCameraLoc] = useState<string | null>(null);

  // ---- Load QC data ----
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
        setLines(d.lines || []);
        setBeforePhotos(d.beforePhotos || {});
        const after: Record<string, string[]> = {};
        const afterIds: Record<string, string> = {};
        for (const [loc, v] of Object.entries(d.afterPhotos || {})) {
          const val = v as { recordId: string; urls: string[] };
          after[loc] = val.urls || [];
          afterIds[loc] = val.recordId;
        }
        setAfterPhotos(after);
        setAfterPhotoRecordIds(afterIds);
        setSourceName(d.sourceRateCardName || null);
        if (d.qcVerdict === 'pass' || d.qcVerdict === 'fail') setVerdict(d.qcVerdict);
      } catch (e: any) {
        if (!cancelled) setLoadError(String(e?.message || e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [props.inspectionRecordId]);

  // ---- Group lines into section instances, preserving order ----
  const sections: SectionGroup[] = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, SectionGroup>();
    for (const ln of lines) {
      const key = `${ln.section}||${ln.location}`;
      if (!map.has(key)) {
        order.push(key);
        map.set(key, {
          key,
          displayName: ln.location || ln.section || 'Section',
          location: ln.location,
          section: ln.section,
          lines: [],
          beforePhotos: beforePhotos[ln.location] || [],
        });
      }
      map.get(key)!.lines.push(ln);
    }
    return order.map((k) => map.get(k)!);
  }, [lines, beforePhotos]);

  // ---- Tallies ----
  const totalPass = lines.filter((l) => l.passFail === 'pass').length;
  const totalFail = lines.filter((l) => l.passFail === 'fail').length;
  const allMarked = lines.length > 0 && lines.every((l) => l.passFail === 'pass' || l.passFail === 'fail');
  const allSectionsHaveAfter = sections.every((s) => (afterPhotos[s.location] || []).length > 0);

  // ---- Photo upload helper bound to a section ----
  const uploadHelper = useCallback((file: File) => uploadPhoto(file), []);

  async function persistAfterPhotos(loc: string, section: string, urls: string[]) {
    const existingId = afterPhotoRecordIds[loc];
    const externalId = existingId || `QCAFTER-${props.inspectionRecordId}-${loc}-${Math.random().toString(36).slice(2, 8)}`;
    const r = await fetch(`/api/inspections/${props.inspectionRecordId}/answers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        upserts: [{
          recordId: existingId,
          answerProps: {
            answer_id_external: externalId,
            answer_type: 'section_photo',
            section,
            location: loc,
            photo_phase: 'after',
            photo_urls: urls.join(','),
            answer_summary: `${section} / After Photos (${urls.length})`,
          },
          questionHubspotRecordId: null,
        }],
        bumpStatusToInProgress: true,
      }),
    });
    if (!r.ok) throw new Error(`Save after-photos failed: HTTP ${r.status}`);
    const data = await r.json();
    const newId = data?.results?.[0]?.recordId;
    if (newId && !existingId) {
      setAfterPhotoRecordIds((cur) => ({ ...cur, [loc]: newId }));
    }
  }

  async function handleCameraComplete(loc: string, section: string, newUrls: string[]) {
    const merged = [...(afterPhotos[loc] || []), ...newUrls];
    setAfterPhotos((cur) => ({ ...cur, [loc]: merged }));
    setCameraLoc(null);
    try {
      await persistAfterPhotos(loc, section, merged);
    } catch (e: any) {
      alert(`Could not save photos: ${e?.message || e}`);
    }
  }

  async function handleFilePick(loc: string, section: string, files: FileList | null) {
    if (!files || files.length === 0) return;
    const uploaded: string[] = [];
    await uploadFilesBatch(Array.from(files), (url) => uploaded.push(url));
    if (uploaded.length === 0) return;
    const merged = [...(afterPhotos[loc] || []), ...uploaded];
    setAfterPhotos((cur) => ({ ...cur, [loc]: merged }));
    try {
      await persistAfterPhotos(loc, section, merged);
    } catch (e: any) {
      alert(`Could not save photos: ${e?.message || e}`);
    }
  }

  async function removeAfterPhoto(loc: string, section: string, url: string) {
    const merged = (afterPhotos[loc] || []).filter((u) => u !== url);
    setAfterPhotos((cur) => ({ ...cur, [loc]: merged }));
    try {
      await persistAfterPhotos(loc, section, merged);
    } catch (e: any) {
      alert(`Could not update photos: ${e?.message || e}`);
    }
  }

  // ---- Mark a line pass/fail (optimistic + persist) ----
  async function setLinePassFail(line: QcLine, pf: 'pass' | 'fail') {
    const next = line.passFail === pf ? '' : pf; // tapping the active chip clears it
    setLines((cur) => cur.map((l) => (l.recordId === line.recordId ? { ...l, passFail: next } : l)));
    try {
      const r = await fetch(`/api/inspections/${props.inspectionRecordId}/answers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          upserts: [{
            recordId: line.recordId,
            answerProps: { pass_fail: next },
            questionHubspotRecordId: null,
          }],
          bumpStatusToInProgress: true,
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e: any) {
      // Revert on failure
      setLines((cur) => cur.map((l) => (l.recordId === line.recordId ? { ...l, passFail: line.passFail } : l)));
      alert(`Could not save pass/fail: ${e?.message || e}`);
    }
  }

  // ---- Submit ----
  async function handleSubmit() {
    if (!allMarked) { alert('Every line item must be marked Pass or Fail before submitting.'); return; }
    if (!allSectionsHaveAfter) { alert('Every section needs at least one After Photo before submitting.'); return; }
    if (verdict !== 'pass' && verdict !== 'fail') { alert('Select an overall Pass or Fail verdict.'); return; }

    setSubmitting(true);
    try {
      const r = await fetch(`/api/inspections/${props.inspectionRecordId}/qc-finalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verdict }),
      });
      if (!r.ok) {
        const text = await r.text();
        throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`);
      }
      const data = await r.json();
      setResult(data);
    } catch (e: any) {
      alert(`Submit failed: ${e?.message || e}`);
    } finally {
      setSubmitting(false);
    }
  }

  // ---- Back (no edits to flush beyond what's already saved incrementally) ----
  function handleBack() { props.onCancel(); }

  if (loading) {
    return <div className="text-sm text-gray-500 py-8 text-center">Loading inspection…</div>;
  }
  if (loadError) {
    return <div className="text-sm text-red-600 py-8 text-center">Could not load: {loadError}</div>;
  }

  return (
    <>
      <header className="mb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h1 className="text-xl font-bold text-gray-900">{props.templateLabel}</h1>
              <span className="text-sm text-gray-700 font-semibold">— {props.propertyName}</span>
            </div>
            <div className="text-xs text-gray-500 mt-1">
              Inspector: {props.inspectorName} · {props.bedrooms} bed / {props.bathrooms} bath
              {props.squareFootage != null && props.squareFootage > 0 && (
                <span> · {props.squareFootage.toLocaleString()} sqft</span>
              )}
              {sourceName && <span> · Validating: {sourceName}</span>}
            </div>
          </div>
          <button
            type="button"
            onClick={handleBack}
            className="flex-shrink-0 inline-flex items-center gap-1 text-sm font-semibold text-gray-700 hover:text-gray-900 border border-gray-300 hover:border-gray-400 rounded-lg px-3 py-1.5 bg-white"
            title="Go back"
          >
            <span aria-hidden>←</span> Back
          </button>
        </div>
      </header>

      {/* Sticky tally bar */}
      <div className="sticky top-0 z-10 -mx-4 px-4 py-2 mb-3 bg-white border-b border-gray-200 shadow-sm">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="text-sm font-semibold text-gray-700">{lines.length} items</div>
          <div className="flex items-center gap-4 text-sm font-bold">
            <span className="text-emerald-600">{totalPass} pass</span>
            <span className="text-gray-300">·</span>
            <span className="text-brand">{totalFail} fail</span>
          </div>
        </div>
      </div>

      {props.readOnly && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm text-amber-900 mb-3">
          This inspection is completed and read-only.
        </div>
      )}

      {/* Sections */}
      {sections.map((s) => {
        const secPass = s.lines.filter((l) => l.passFail === 'pass').length;
        const secFail = s.lines.filter((l) => l.passFail === 'fail').length;
        const after = afterPhotos[s.location] || [];
        return (
          <section key={s.key} className="mb-5 border border-gray-200 rounded-xl overflow-hidden">
            {/* Section header */}
            <div className="flex items-center justify-between px-4 py-2 bg-gray-50 border-b border-gray-200">
              <h2 className="font-bold text-sm text-gray-900">{s.displayName}</h2>
              <div className="text-xs font-bold">
                <span className="text-emerald-600">{secPass} pass</span>
                <span className="text-gray-300"> · </span>
                <span className="text-brand">{secFail} fail</span>
              </div>
            </div>

            {/* Before / After photos */}
            <div className="px-4 py-3 grid grid-cols-2 gap-4 border-b border-gray-100">
              <div>
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Before</div>
                {s.beforePhotos.length === 0 ? (
                  <div className="text-xs text-gray-400">No before photos</div>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {s.beforePhotos.map((u, i) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <a key={i} href={u} target="_blank" rel="noopener noreferrer">
                        <img src={u} alt="before" className="w-16 h-16 object-cover rounded border border-gray-200" />
                      </a>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    After {after.length === 0 && <span className="text-brand">• required</span>}
                  </div>
                </div>
                {after.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {after.map((u, i) => (
                      <div key={i} className="relative">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <a href={u} target="_blank" rel="noopener noreferrer">
                          <img src={u} alt="after" className="w-16 h-16 object-cover rounded border border-gray-200" />
                        </a>
                        {!props.readOnly && (
                          <button
                            type="button"
                            onClick={() => removeAfterPhoto(s.location, s.section, u)}
                            className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-white border border-gray-300 rounded-full text-gray-600 text-xs leading-none shadow"
                            title="Remove photo"
                          >×</button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {!props.readOnly && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setCameraLoc(s.location)}
                      className="text-xs font-semibold bg-brand text-white rounded px-2.5 py-1.5 hover:bg-brand-dark"
                    >
                      Take After Photo
                    </button>
                    <label className="text-xs font-semibold text-gray-700 border border-gray-300 rounded px-2.5 py-1.5 cursor-pointer hover:border-gray-400">
                      Upload
                      <input
                        type="file" accept="image/*" multiple className="hidden"
                        onChange={(e) => { handleFilePick(s.location, s.section, e.target.files); e.currentTarget.value = ''; }}
                      />
                    </label>
                  </div>
                )}
              </div>
            </div>

            {/* Line items */}
            <div className="divide-y divide-gray-100">
              {s.lines.map((ln) => (
                <div key={ln.recordId} className="px-4 py-2.5 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-gray-900">{ln.description}</div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {ln.quantity != null && <span>Qty {ln.quantity} · </span>}
                      {ln.vendor && <span>{ln.vendor} · </span>}
                      {ln.vendorCost != null && <span>${formatMoney(ln.vendorCost)}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      disabled={props.readOnly}
                      onClick={() => setLinePassFail(ln, 'pass')}
                      className={
                        'w-9 h-9 rounded-full flex items-center justify-center text-base font-bold border transition ' +
                        (ln.passFail === 'pass'
                          ? 'bg-emerald-600 text-white border-emerald-600'
                          : 'bg-white text-emerald-600 border-emerald-300 hover:border-emerald-500')
                      }
                      title="Pass"
                    >✓</button>
                    <button
                      type="button"
                      disabled={props.readOnly}
                      onClick={() => setLinePassFail(ln, 'fail')}
                      className={
                        'w-9 h-9 rounded-full flex items-center justify-center text-base font-bold border transition ' +
                        (ln.passFail === 'fail'
                          ? 'bg-brand text-white border-brand'
                          : 'bg-white text-brand border-brand/40 hover:border-brand')
                      }
                      title="Fail"
                    >✕</button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })}

      {lines.length === 0 && (
        <div className="text-sm text-gray-500 py-8 text-center border border-gray-200 rounded-xl">
          No line items were copied from the source inspection.
        </div>
      )}

      {/* Overall verdict + submit */}
      {!props.readOnly && (
        <div className="border-2 border-gray-200 rounded-xl p-4 mb-8">
          <div className="text-sm font-bold text-gray-900 mb-2">Overall Inspection Result</div>
          <div className="flex items-center gap-3 mb-4">
            <button
              type="button"
              onClick={() => setVerdict('pass')}
              className={
                'flex-1 py-3 rounded-lg font-bold border-2 transition ' +
                (verdict === 'pass'
                  ? 'bg-emerald-600 text-white border-emerald-600'
                  : 'bg-white text-emerald-600 border-emerald-300 hover:border-emerald-500')
              }
            >✓ Pass</button>
            <button
              type="button"
              onClick={() => setVerdict('fail')}
              className={
                'flex-1 py-3 rounded-lg font-bold border-2 transition ' +
                (verdict === 'fail'
                  ? 'bg-brand text-white border-brand'
                  : 'bg-white text-brand border-brand/40 hover:border-brand')
              }
            >✕ Fail</button>
          </div>

          {/* Submit readiness hints */}
          {(!allMarked || !allSectionsHaveAfter || !verdict) && (
            <ul className="text-xs text-amber-700 mb-3 list-disc pl-5 space-y-0.5">
              {!allMarked && <li>Mark every line item Pass or Fail.</li>}
              {!allSectionsHaveAfter && <li>Add at least one After Photo to every section.</li>}
              {!verdict && <li>Choose an overall Pass/Fail verdict.</li>}
            </ul>
          )}

          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || !allMarked || !allSectionsHaveAfter || !verdict}
            className="w-full py-3 rounded-lg font-bold text-white bg-brand hover:bg-brand-dark disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? 'Submitting…' : 'Submit Inspection'}
          </button>
        </div>
      )}

      {/* Camera modal */}
      {cameraLoc != null && (
        <CameraCapture
          isOpen={true}
          onClose={() => setCameraLoc(null)}
          uploadPhoto={uploadHelper}
          onComplete={(urls) => {
            const sec = sections.find((s) => s.location === cameraLoc);
            handleCameraComplete(cameraLoc, sec?.section || '', urls);
          }}
        />
      )}

      {/* Result modal */}
      {result && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-5">
            <div className={'text-lg font-bold mb-1 ' + (result.verdict === 'pass' ? 'text-emerald-700' : 'text-brand')}>
              ✓ QC {result.verdict === 'pass' ? 'Passed' : 'Failed'}
            </div>
            <div className="text-sm text-gray-600 mb-4">
              {result.passCount} passed · {result.failCount} failed
            </div>
            <a
              href={result.pdf.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block w-full text-center py-2.5 rounded-lg font-semibold text-brand border border-brand/40 hover:bg-brand/5 mb-2"
            >
              Download QC Report (PDF)
            </a>
            <button
              type="button"
              onClick={() => { setResult(null); props.onSubmit(); }}
              className="w-full py-2.5 rounded-lg font-semibold text-white bg-gray-800 hover:bg-gray-900"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </>
  );
}
