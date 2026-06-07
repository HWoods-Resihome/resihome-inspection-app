/**
 * RoomScanModal (Beta) — Phase 1 of the camera-AI scope assistant.
 *
 * Flow:
 *   1) Inspector records / picks a short room video.
 *   2) We extract a handful of still frames (canvas), stamp them (address +
 *      timestamp) like the in-app camera, and upload them — they become the
 *      room's section photos (so the video satisfies the photo requirement).
 *   3) We best-effort transcribe the clip's voice-over (so spoken call-outs and
 *      measurements feed the AI).
 *   4) Frames + transcript go to /api/rate-card/room-scan, which returns draft
 *      line-item suggestions (catalog-resolved), each tied to a supporting frame.
 *   5) Inspector reviews each suggestion: fill any unknown SF/LF measurement,
 *      then Add (creates the line, with the supporting still tagged to it) or
 *      Decline. Same add/decline UX as AI review.
 *
 * Nothing is auto-final: every line is the inspector's explicit Add.
 */

import { useEffect, useRef, useState } from 'react';
import { uploadPhoto } from '@/lib/photoUpload';
import { NumberField } from '@/components/NumberPad';
import { displayImageSrc } from '@/lib/photoDisplay';
import { extractAudioWav16k } from '@/lib/audioExtract';
import {
  drawEvidenceStamp, buildStampLines, getGeoFix, resolvePropertyRefCoords, type StampLine,
} from '@/lib/evidenceStamp';
import { isArMeasureSupported, measureFloorAreaSF } from '@/lib/webxrMeasure';
import type { RateCardLineInput } from '@/lib/types';

const FRAME_COUNT = 8;                 // stills pulled from the clip

// Friendly cycling status (same cadence as the AI-review modal) so the wait
// feels like the assistant is working through the room.
const SCAN_PHASES = [
  'Pulling photos from your video…',
  'Reading the room…',
  'Checking walls, floors & fixtures…',
  'Noting your call-outs…',
  'Matching to the rate card…',
  'Applying clean, safe & functional rules…',
  'Pulling together suggestions…',
];

interface Suggestion {
  id: string;
  description: string;
  lineItemCode: string;
  category: string;
  subcategory: string;
  unit: string;
  quantity: number | null;
  needsMeasurement: boolean;
  measurementUnit: string;
  estimatedQuantity: number | null;
  suggestedVendor: string;
  tenantBillBackPercent: number;
  frameIndex: number;
  rationale: string;
  confidence: 'high' | 'medium' | 'low';
}

interface Props {
  sectionId: string;
  sectionLabel: string;       // stored on the line (e.g. "Bedroom")
  sectionDisplayName: string; // shown to the user (e.g. "Bedroom 1")
  location: string;
  region: string;
  tenantMonths: number | null;
  addressSnapshot: string;
  propertyRecordId?: string;  // for the GPS proximity verdict (same as the camera)
  onClose: () => void;
  onAddLine: (line: RateCardLineInput) => void;
  onFramesCaptured: (urls: string[]) => void;  // add stamped stills to room photos
}

type Phase = 'idle' | 'extracting' | 'analyzing' | 'review' | 'error';

function genId(): string {
  const uuid = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `RCLINE-${uuid}`;
}

function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const r = reader.result as string;
      const comma = r.indexOf(',');
      resolve(comma >= 0 ? r.slice(comma + 1) : r);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function seek(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    const on = () => { video.removeEventListener('seeked', on); resolve(); };
    video.addEventListener('seeked', on);
    video.currentTime = Math.max(0, Math.min(t, (video.duration || t) - 0.05));
  });
}

// Extract `count` JPEG frames evenly across the clip, each burned with the
// shared evidence stamp (address / timestamp / GPS) — identical to the camera.
async function extractFrames(file: File, count: number, stampLines: StampLine[]): Promise<Blob[]> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.src = url;
  video.muted = true;
  (video as any).playsInline = true;
  video.preload = 'auto';
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('Could not read the video.'));
    });
    const dur = video.duration && isFinite(video.duration) ? video.duration : 0;
    const canvas = document.createElement('canvas');
    const out: Blob[] = [];
    for (let i = 0; i < count; i++) {
      const t = dur > 0 ? dur * ((i + 0.5) / count) : 0;
      await seek(video, t);
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      drawEvidenceStamp(ctx, canvas.width, canvas.height, stampLines);
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob((b) => res(b), 'image/jpeg', 0.8));
      if (blob) out.push(blob);
      if (dur === 0) break; // a still/0-length file → one frame is enough
    }
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Pull the clip's audio (16 kHz mono WAV — tiny) and transcribe it, so spoken
// measurements / call-outs feed the AI. Robust to clip length: we send audio,
// not the whole video, so there's no size cap. Returns '' if unavailable.
async function transcribeVideo(file: File): Promise<string> {
  try {
    const wav = await extractAudioWav16k(file);
    if (!wav || wav.size === 0) return '';
    const base64 = await fileToBase64(wav);
    const r = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64, mime: 'audio/wav' }),
    });
    if (!r.ok) return '';
    const d = await r.json();
    return String(d.text || '').trim();
  } catch {
    return '';
  }
}

export function RoomScanModal(props: Props) {
  const {
    sectionId, sectionLabel, sectionDisplayName, location, region, tenantMonths,
    addressSnapshot, onClose, onAddLine, onFramesCaptured,
  } = props;

  const fileRef = useRef<HTMLInputElement | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [frameUrls, setFrameUrls] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [qtyById, setQtyById] = useState<Record<string, string>>({});
  const [handled, setHandled] = useState<Record<string, 'added' | 'declined'>>({});
  const [phraseIdx, setPhraseIdx] = useState(0);
  const [arSupported, setArSupported] = useState(false);
  const [measuringId, setMeasuringId] = useState<string | null>(null);

  useEffect(() => {
    let on = true;
    isArMeasureSupported().then((v) => { if (on) setArSupported(v); }).catch(() => {});
    return () => { on = false; };
  }, []);

  async function measure(id: string) {
    setMeasuringId(id);
    try {
      const sf = await measureFloorAreaSF();
      if (sf && sf > 0) setQtyById((m) => ({ ...m, [id]: String(sf) }));
    } catch { /* keep estimate */ } finally {
      setMeasuringId(null);
    }
  }

  const working = phase === 'extracting' || phase === 'analyzing';
  useEffect(() => {
    if (!working) { setPhraseIdx(0); return; }
    const t = setInterval(() => setPhraseIdx((p) => (p + 1) % SCAN_PHASES.length), 3800);
    return () => clearInterval(t);
  }, [working]);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = (e.target.files || [])[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    setPhase('extracting');
    try {
      // 0) Resolve location once so the stills carry the same GPS/proximity
      //    stamp the live camera burns (address + time + coords + ✓/✗).
      setStatus('Checking location…');
      const [refCoords, fix] = await Promise.all([
        resolvePropertyRefCoords(props.propertyRecordId, addressSnapshot),
        getGeoFix(),
      ]);
      const stampLines = buildStampLines(addressSnapshot, fix, refCoords);

      // 1) Frames (stamped) → upload → room photos.
      setStatus('Grabbing photos from the video…');
      const blobs = await extractFrames(file, FRAME_COUNT, stampLines);
      if (blobs.length === 0) throw new Error('Could not read frames from that video.');
      const base64s: string[] = [];
      const urls: string[] = [];
      for (let i = 0; i < blobs.length; i++) {
        base64s.push(await fileToBase64(blobs[i]));
        setStatus(`Uploading photo ${i + 1}/${blobs.length}…`);
        const f = new File([blobs[i]], `scan_${Date.now()}_${i}.jpg`, { type: 'image/jpeg' });
        urls.push(await uploadPhoto(f));
      }
      setFrameUrls(urls);
      onFramesCaptured(urls); // satisfies the room photo requirement

      // 2) Best-effort voice-over transcription.
      setStatus('Listening for your call-outs…');
      const transcript = await transcribeVideo(file);

      // 3) Analyze.
      setPhase('analyzing');
      setStatus('Analyzing the room…');
      const r = await fetch('/api/rate-card/room-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sectionName: sectionDisplayName,
          region,
          transcript,
          tenantMonths: typeof tenantMonths === 'number' ? tenantMonths : 12,
          frames: base64s.map((data) => ({ data })),
        }),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error(`Analysis failed (${r.status}). ${t.slice(0, 140)}`);
      }
      const data = await r.json();
      const list: Suggestion[] = Array.isArray(data.suggestions) ? data.suggestions : [];
      setSuggestions(list);
      // Pre-fill the measurement field with the AI's rough estimate so the
      // approve screen isn't blank — the inspector confirms or overwrites it.
      const seed: Record<string, string> = {};
      for (const s of list) {
        if (s.needsMeasurement && s.estimatedQuantity && s.estimatedQuantity > 0) seed[s.id] = String(s.estimatedQuantity);
      }
      setQtyById(seed);
      setPhase('review');
    } catch (err: any) {
      setError(String(err?.message || err));
      setPhase('error');
    }
  }

  function frameUrlFor(s: Suggestion): string | undefined {
    return frameUrls[s.frameIndex] ?? frameUrls[0];
  }

  function handleAdd(s: Suggestion) {
    let qty: number;
    if (s.needsMeasurement) {
      const v = Number(qtyById[s.id]);
      if (!isFinite(v) || v <= 0) return; // require a measurement first
      qty = v;
    } else {
      qty = s.quantity ?? 1;
    }
    const supporting = frameUrlFor(s);
    const line: RateCardLineInput = {
      externalId: genId(),
      section: sectionLabel,
      location,
      lineItemCode: s.lineItemCode,
      quantity: qty,
      tenantBillBackPercent: s.tenantBillBackPercent,
      assignedTo: s.suggestedVendor || 'Vendor 1',
      note: '',
      customLaborRate: null,
      customAdjustedMaterialCost: null,
      customVendorCost: null,
      photoUrls: supporting ? [supporting] : [],
    };
    onAddLine(line);
    setHandled((h) => ({ ...h, [s.id]: 'added' }));
  }

  const remaining = suggestions.filter((s) => !handled[s.id]).length;
  const confColor = (c: string) => c === 'high' ? 'text-emerald-700 bg-emerald-50'
    : c === 'low' ? 'text-amber-700 bg-amber-50' : 'text-sky-700 bg-sky-50';

  return (
    <div data-modal-overlay className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center sm:justify-center transition-[padding] duration-200">
      <div data-modal-scroll className="bg-white w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl max-h-[92vh] overflow-y-auto shadow-xl">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between z-10">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-heading font-bold text-base text-ink truncate">AI Room Scan</span>
            <span className="text-[10px] font-bold uppercase tracking-wide text-white bg-violet-600 rounded px-1.5 py-0.5">Beta</span>
            <span className="text-xs text-gray-500 truncate">· {sectionDisplayName}</span>
          </div>
          <button type="button" onClick={onClose} aria-label="Close"
            className="text-gray-400 hover:text-gray-700 text-2xl leading-none w-8 h-8 flex items-center justify-center">×</button>
        </div>

        <div className="px-4 py-4">
          {phase === 'idle' && (
            <div className="text-center py-6">
              <p className="text-sm text-gray-600 mb-4">
                Record a slow pan of the room (10–30s). Speak any measurements or call-outs as you go
                (e.g. &ldquo;carpet is about 200 square feet&rdquo;). The AI suggests line items and pulls
                photos into the room — you confirm each one.
              </p>
              <button type="button" onClick={() => fileRef.current?.click()}
                className="inline-flex items-center gap-2 bg-violet-600 hover:bg-violet-700 text-white font-heading font-bold px-5 py-2.5 rounded-lg">
                Record room video
              </button>
              <p className="text-[11px] text-gray-400 mt-3">Beta — always review the suggestions before submitting.</p>
            </div>
          )}

          {working && (
            <div className="text-center py-10">
              <div className="inline-block w-8 h-8 border-2 border-violet-300 border-t-violet-600 rounded-full animate-spin mb-3" />
              <div className="text-sm font-semibold text-gray-800 transition-opacity">{SCAN_PHASES[phraseIdx]}</div>
              {status && <div className="text-xs text-gray-400 mt-1">{status}</div>}
            </div>
          )}

          {phase === 'error' && (
            <div className="py-6 text-center">
              <div className="text-sm text-red-600 mb-4">{error}</div>
              <button type="button" onClick={() => { setPhase('idle'); setError(''); }}
                className="text-sm font-semibold text-violet-700 underline">Try again</button>
            </div>
          )}

          {phase === 'review' && (
            <div>
              <div className="text-xs text-gray-500 mb-3">
                {frameUrls.length} photo{frameUrls.length === 1 ? '' : 's'} added to {sectionDisplayName}.
                {suggestions.length > 0
                  ? ` ${suggestions.length} suggestion${suggestions.length === 1 ? '' : 's'} — add or decline each.`
                  : ' No line items suggested.'}
              </div>

              <div className="space-y-3">
                {suggestions.map((s) => {
                  const state = handled[s.id];
                  const url = frameUrlFor(s);
                  return (
                    <div key={s.id} className={`border rounded-lg p-3 ${state ? 'opacity-60 border-gray-200' : 'border-gray-300'}`}>
                      <div className="flex gap-3">
                        {url && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={displayImageSrc(url)} alt="" className="w-16 h-16 object-cover rounded border border-gray-200 shrink-0" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-semibold text-ink">{s.description}</span>
                            <span className={`text-[10px] font-semibold rounded px-1.5 py-0.5 ${confColor(s.confidence)}`}>{s.confidence}</span>
                          </div>
                          <div className="text-[11px] text-gray-500">{s.category}{s.subcategory ? ` · ${s.subcategory}` : ''} · {s.unit || 'EA'}</div>
                          {s.rationale && <div className="text-xs text-gray-600 mt-1 leading-snug">{s.rationale}</div>}

                          {s.needsMeasurement && !state && (
                            <div className="mt-2">
                              <div className="flex items-center gap-2">
                                <NumberField
                                  value={qtyById[s.id] || ''}
                                  onChange={(v) => setQtyById((m) => ({ ...m, [s.id]: v }))}
                                  placeholder={`Enter ${s.measurementUnit}`}
                                  ariaLabel={`Quantity in ${s.measurementUnit}`}
                                  className="h-9 w-32 bg-gray-100 rounded-lg px-3 text-sm outline-none focus:ring-2 focus:ring-violet-300"
                                />
                                <span className="text-xs text-gray-500">{s.measurementUnit}</span>
                                {arSupported && s.unit === 'SF' && (
                                  <button type="button" onClick={() => void measure(s.id)} disabled={measuringId === s.id}
                                    className="ml-auto text-xs font-semibold text-violet-700 border border-violet-300 rounded-lg px-2 py-1 disabled:opacity-50">
                                    {measuringId === s.id ? 'Measuring…' : '📐 Measure (AR)'}
                                  </button>
                                )}
                              </div>
                              {s.estimatedQuantity && s.estimatedQuantity > 0 && (
                                <div className="text-[11px] text-amber-700 mt-1">
                                  ≈ AI estimate ({s.estimatedQuantity} {s.unit}) — confirm, edit{arSupported ? ', or Measure (AR)' : ''} before adding.
                                </div>
                              )}
                            </div>
                          )}
                          {!s.needsMeasurement && !state && (
                            <div className="text-[11px] text-gray-500 mt-1">Qty {s.quantity ?? 1} {s.unit}</div>
                          )}
                        </div>
                      </div>

                      {state ? (
                        <div className={`text-xs font-semibold mt-2 ${state === 'added' ? 'text-emerald-700' : 'text-gray-500'}`}>
                          {state === 'added' ? '✓ Added' : 'Declined'}
                        </div>
                      ) : (
                        <div className="flex gap-2 mt-3">
                          <button type="button" onClick={() => handleAdd(s)}
                            disabled={s.needsMeasurement && !(Number(qtyById[s.id]) > 0)}
                            className="flex-1 h-9 rounded-lg bg-emerald-600 text-white font-heading font-semibold text-sm hover:bg-emerald-700 disabled:bg-gray-300 disabled:cursor-not-allowed">
                            Add
                          </button>
                          <button type="button" onClick={() => setHandled((h) => ({ ...h, [s.id]: 'declined' }))}
                            className="flex-1 h-9 rounded-lg border border-gray-300 text-gray-700 font-heading font-semibold text-sm hover:bg-gray-50">
                            Decline
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {remaining > 0 && suggestions.length > 0 && (
                <div className="text-[11px] text-amber-700 text-center mt-4 mb-1">
                  Add or decline each suggestion to finish ({remaining} left).
                </div>
              )}
              <button
                type="button"
                onClick={onClose}
                disabled={remaining > 0}
                className={`w-full ${remaining > 0 ? 'mt-1' : 'mt-4'} h-11 rounded-lg font-heading font-bold ${
                  remaining > 0 ? 'bg-gray-300 text-gray-500 cursor-not-allowed' : 'bg-gray-900 text-white'
                }`}
              >
                Done
              </button>
            </div>
          )}
        </div>

        <input ref={fileRef} type="file" accept="video/*" capture="environment" className="hidden" onChange={onPick} />
      </div>
    </div>
  );
}
