/**
 * LiveRoomScan (Phase 3, Beta) — live in-camera scope assistant.
 *
 * Opens the rear camera and, while the inspector pans the room:
 *   • samples a downscaled keyframe every couple seconds → fast vision endpoint
 *     (Haiku) → NEW scope call-outs appear as chips (deduped across the session);
 *   • runs continuous speech recognition (where supported) so spoken call-outs
 *     become chips instantly and feed the vision endpoint as context;
 *   • periodically grabs full-res, evidence-stamped stills → room photos (so the
 *     scan satisfies the photo requirement), and tags the latest still to chips;
 *   • each chip: Add (measured items confirm/edit the pre-filled estimate) or ✕.
 * Finish commits the staged lines + stills to the room.
 *
 * Performance is the whole point: single in-flight inference at a time, tiny
 * keyframes, server dedupe + client dedupe, refs (not state) for hot paths.
 */

import { useEffect, useRef, useState } from 'react';
import { uploadPhoto } from '@/lib/photoUpload';
import { displayImageSrc } from '@/lib/photoDisplay';
import {
  drawEvidenceStamp, buildStampLines, getGeoFix, resolvePropertyRefCoords, type StampLine,
} from '@/lib/evidenceStamp';
import { isArMeasureSupported, measureFloorAreaSF } from '@/lib/webxrMeasure';
import type { RateCardLineInput } from '@/lib/types';

const INFER_INTERVAL_MS = 2500;   // keyframe → vision cadence
const STILL_INTERVAL_MS = 5000;   // full-res stamped still cadence
const KEYFRAME_EDGE = 640;        // downscale before sending (speed)
const MAX_STILLS = 10;

interface LiveSuggestion {
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
  rationale: string;
  confidence: 'high' | 'medium' | 'low';
  stillUrl?: string;
}

interface Props {
  sectionLabel: string;
  sectionDisplayName: string;
  location: string;
  tenantMonths: number | null;
  addressSnapshot: string;
  propertyRecordId?: string;
  onClose: () => void;
  onAddLine: (line: RateCardLineInput) => void;
  onFramesCaptured: (urls: string[]) => void;
  onFallbackToRecord?: () => void;  // camera denied / unsupported → record-video flow
}

function genId(): string {
  const uuid = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `RCLINE-${uuid}`;
}

function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && (navigator as any).maxTouchPoints > 1);
}

export function LiveRoomScan(props: Props) {
  const {
    sectionLabel, sectionDisplayName, location, tenantMonths,
    addressSnapshot, propertyRecordId, onClose, onAddLine, onFramesCaptured,
  } = props;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const inferTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stillTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const inFlight = useRef(false);
  const openRef = useRef(true);
  const recRef = useRef<any>(null);

  const stampLinesRef = useRef<StampLine[]>([]);
  const seenDescRef = useRef<Set<string>>(new Set());   // sent to model + dedupe
  const seenCodeRef = useRef<Set<string>>(new Set());   // client dedupe
  const transcriptBufRef = useRef('');                  // finals not yet sent
  const stillUrlsRef = useRef<string[]>([]);
  const latestStillRef = useRef<string | undefined>(undefined);
  const stagedRef = useRef<RateCardLineInput[]>([]);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [voiceOn, setVoiceOn] = useState(false);
  const [interim, setInterim] = useState('');
  const [chips, setChips] = useState<LiveSuggestion[]>([]);
  const [qtyById, setQtyById] = useState<Record<string, string>>({});
  const [stagedCount, setStagedCount] = useState(0);
  const [stillCount, setStillCount] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [arSupported, setArSupported] = useState(false);
  const [measuring, setMeasuring] = useState(false);

  useEffect(() => {
    let on = true;
    isArMeasureSupported().then((v) => { if (on) setArSupported(v); }).catch(() => {});
    return () => { on = false; };
  }, []);

  // ---- lifecycle ----
  useEffect(() => {
    openRef.current = true;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (!openRef.current) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.muted = true;
          (videoRef.current as any).playsInline = true;
          await videoRef.current.play().catch(() => {});
        }
        setReady(true);
        // Geo/stamp once.
        const [ref, fix] = await Promise.all([
          resolvePropertyRefCoords(propertyRecordId, addressSnapshot),
          getGeoFix(),
        ]);
        stampLinesRef.current = buildStampLines(addressSnapshot, fix, ref);
        startVoice();
        // Kick off loops.
        setTimeout(() => { void captureStill(); }, 700);
        inferTimer.current = setInterval(() => { void runInference(); }, INFER_INTERVAL_MS);
        stillTimer.current = setInterval(() => { void captureStill(); }, STILL_INTERVAL_MS);
      } catch {
        setError('Camera unavailable — allow camera access and reopen, or use Record video.');
      }
    })();
    return () => { teardown(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function teardown() {
    openRef.current = false;
    if (inferTimer.current) clearInterval(inferTimer.current);
    if (stillTimer.current) clearInterval(stillTimer.current);
    try { recRef.current?.stop?.(); } catch { /* noop */ }
    recRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  // AR measure needs exclusive camera access, so pause the live pipeline, run
  // the WebXR session, then resume — keeps both smooth and conflict-free.
  function pauseForAr() {
    if (inferTimer.current) clearInterval(inferTimer.current);
    if (stillTimer.current) clearInterval(stillTimer.current);
    try { recRef.current?.stop?.(); } catch { /* noop */ }
    recRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }
  async function resumeAfterAr() {
    if (!openRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      if (!openRef.current) { stream.getTracks().forEach((t) => t.stop()); return; }
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play().catch(() => {}); }
      startVoice();
      inferTimer.current = setInterval(() => { void runInference(); }, INFER_INTERVAL_MS);
      stillTimer.current = setInterval(() => { void captureStill(); }, STILL_INTERVAL_MS);
    } catch {
      setError('Couldn’t restart the camera after measuring — tap Finish and reopen.');
    }
  }
  async function measureChip(id: string) {
    setMeasuring(true);
    pauseForAr();
    try {
      const sf = await measureFloorAreaSF();
      if (sf && sf > 0) setQtyById((m) => ({ ...m, [id]: String(sf) }));
    } catch { /* keep estimate */ } finally {
      await resumeAfterAr();
      setMeasuring(false);
    }
  }

  // ---- voice (continuous; auto-restart) ----
  function startVoice() {
    const SR = (typeof window !== 'undefined') && ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
    if (!SR || isIOS()) { setVoiceOn(false); return; } // iOS Safari has no reliable continuous recognition
    try {
      const rec = new SR();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = 'en-US';
      rec.onresult = (e: any) => {
        let finalDelta = '';
        let interimTxt = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finalDelta += r[0].transcript + ' ';
          else interimTxt += r[0].transcript;
        }
        if (finalDelta) transcriptBufRef.current += finalDelta;
        setInterim(interimTxt.trim());
      };
      rec.onend = () => { if (openRef.current) { try { rec.start(); } catch { /* noop */ } } };
      rec.onerror = () => { /* transient — onend restarts */ };
      rec.start();
      recRef.current = rec;
      setVoiceOn(true);
    } catch {
      setVoiceOn(false);
    }
  }

  // ---- keyframe + still capture ----
  function grabKeyframeB64(edge: number): string | null {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return null;
    const scale = Math.min(1, edge / Math.max(v.videoWidth, v.videoHeight));
    const w = Math.round(v.videoWidth * scale);
    const h = Math.round(v.videoHeight * scale);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.6).split(',')[1] || null;
  }

  async function captureStill() {
    const v = videoRef.current;
    if (!openRef.current || !v || !v.videoWidth || stillUrlsRef.current.length >= MAX_STILLS) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(v, 0, 0, c.width, c.height);
    drawEvidenceStamp(ctx, c.width, c.height, stampLinesRef.current);
    const blob = await new Promise<Blob | null>((res) => c.toBlob((b) => res(b), 'image/jpeg', 0.8));
    if (!blob) return;
    try {
      const f = new File([blob], `live_${Date.now()}.jpg`, { type: 'image/jpeg' });
      const url = await uploadPhoto(f);
      if (!openRef.current) return;
      stillUrlsRef.current.push(url);
      latestStillRef.current = url;
      setStillCount(stillUrlsRef.current.length);
    } catch { /* non-fatal */ }
  }

  // ---- inference ----
  async function runInference() {
    if (inFlight.current || !openRef.current) return;
    const b64 = grabKeyframeB64(KEYFRAME_EDGE);
    if (!b64) return;
    inFlight.current = true;
    setScanning(true);
    const delta = transcriptBufRef.current.trim();
    transcriptBufRef.current = '';
    try {
      const r = await fetch('/api/rate-card/room-scan-live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sectionName: sectionDisplayName,
          tenantMonths: typeof tenantMonths === 'number' ? tenantMonths : 12,
          transcriptDelta: delta,
          seen: Array.from(seenDescRef.current),
          frame: b64,
        }),
      });
      if (!r.ok || !openRef.current) return;
      const d = await r.json();
      const incoming: LiveSuggestion[] = Array.isArray(d.suggestions) ? d.suggestions : [];
      const fresh = incoming.filter((s) => s.lineItemCode && !seenCodeRef.current.has(s.lineItemCode));
      if (fresh.length) {
        const seed: Record<string, string> = {};
        for (const s of fresh) {
          seenCodeRef.current.add(s.lineItemCode);
          seenDescRef.current.add(s.description);
          s.stillUrl = latestStillRef.current;
          if (s.needsMeasurement && s.estimatedQuantity && s.estimatedQuantity > 0) seed[s.id] = String(s.estimatedQuantity);
        }
        if (Object.keys(seed).length) setQtyById((m) => ({ ...m, ...seed }));
        setChips((cur) => [...cur, ...fresh]);
      }
    } catch { /* skip this tick */ } finally {
      inFlight.current = false;
      setScanning(false);
    }
  }

  // ---- chip actions ----
  function addChip(s: LiveSuggestion) {
    let qty: number;
    if (s.needsMeasurement) {
      const v = Number(qtyById[s.id]);
      if (!isFinite(v) || v <= 0) return;
      qty = v;
    } else {
      qty = s.quantity ?? 1;
    }
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
      photoUrls: s.stillUrl ? [s.stillUrl] : [],
    };
    stagedRef.current.push(line);
    setStagedCount(stagedRef.current.length);
    setChips((cur) => cur.filter((c) => c.id !== s.id)); // code stays in seen
  }

  function dismissChip(s: LiveSuggestion) {
    setChips((cur) => cur.filter((c) => c.id !== s.id)); // code stays in seen → won't re-surface
  }

  async function finish() {
    teardown();
    // Commit staged lines + push the stamped stills into the room photos.
    for (const line of stagedRef.current) {
      try { onAddLine(line); } catch { /* continue */ }
    }
    if (stillUrlsRef.current.length) onFramesCaptured([...stillUrlsRef.current]);
    onClose();
  }

  const confColor = (c: string) => c === 'high' ? 'bg-emerald-500' : c === 'low' ? 'bg-amber-500' : 'bg-sky-500';

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      {/* Live video */}
      <video ref={videoRef} className="absolute inset-0 w-full h-full object-cover" playsInline muted />

      {/* Top bar */}
      <div className="relative z-10 flex items-center justify-between px-4 pt-4 pb-2 bg-gradient-to-b from-black/60 to-transparent">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-white font-heading font-bold text-sm truncate">{sectionDisplayName}</span>
          <span className="text-[10px] font-bold uppercase tracking-wide text-white bg-violet-600 rounded px-1.5 py-0.5">Live · Beta</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1 text-[11px] text-white/90">
            <span className={`w-2 h-2 rounded-full ${scanning ? 'bg-violet-400 animate-pulse' : 'bg-white/40'}`} />
            {scanning ? 'Scanning…' : ready ? 'Ready' : 'Starting…'}
          </span>
          <button onClick={() => { teardown(); onClose(); }} aria-label="Cancel"
            className="text-white/90 text-2xl leading-none w-8 h-8 flex items-center justify-center">×</button>
        </div>
      </div>

      {/* Voice / guidance line */}
      <div className="relative z-10 px-4">
        {error ? (
          <div className="text-sm text-red-300 bg-black/50 rounded-lg px-3 py-2">
            {error}
            {props.onFallbackToRecord && (
              <button onClick={() => { teardown(); props.onFallbackToRecord!(); }}
                className="ml-2 underline font-semibold text-white">Record video instead</button>
            )}
          </div>
        ) : (
          <div className="text-[12px] text-white/80 bg-black/30 rounded-lg px-3 py-1.5 inline-block max-w-full">
            {voiceOn
              ? (interim ? <span className="italic">“{interim}”</span> : 'Pan slowly — say what you see (e.g. “broken blinds, carpet needs replacing”).')
              : 'Pan slowly across the room. (Voice call-outs aren’t available in this browser.)'}
          </div>
        )}
      </div>

      <div className="flex-1" />

      {/* Chip tray */}
      <div className="relative z-10 px-3 pb-3 space-y-2 max-h-[52vh] overflow-y-auto">
        {chips.map((s) => (
          <div key={s.id} className="bg-white/95 backdrop-blur rounded-xl p-3 shadow-lg">
            <div className="flex items-start gap-2">
              <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${confColor(s.confidence)}`} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-ink">{s.description}</div>
                <div className="text-[11px] text-gray-500">{s.category}{s.subcategory ? ` · ${s.subcategory}` : ''} · {s.unit || 'EA'}</div>
                {s.rationale && <div className="text-xs text-gray-600 mt-0.5 leading-snug">{s.rationale}</div>}
                {s.needsMeasurement && (
                  <div className="mt-2">
                    <div className="flex items-center gap-2">
                      <input
                        type="text" inputMode="decimal"
                        value={qtyById[s.id] || ''}
                        onChange={(e) => setQtyById((m) => ({ ...m, [s.id]: e.target.value.replace(/[^0-9.]/g, '') }))}
                        placeholder={`Enter ${s.measurementUnit}`}
                        className="h-9 w-28 bg-gray-100 rounded-lg px-3 text-sm outline-none focus:ring-2 focus:ring-violet-300"
                      />
                      <span className="text-xs text-gray-500">{s.measurementUnit}</span>
                      {arSupported && (s.unit === 'SF') && (
                        <button onClick={() => void measureChip(s.id)} disabled={measuring}
                          className="ml-auto text-xs font-semibold text-violet-700 border border-violet-300 rounded-lg px-2 py-1 disabled:opacity-50">
                          {measuring ? 'Measuring…' : '📐 Measure (AR)'}
                        </button>
                      )}
                    </div>
                    {s.estimatedQuantity && s.estimatedQuantity > 0 && (
                      <div className="text-[11px] text-amber-700 mt-1">≈ AI estimate ({s.estimatedQuantity} {s.unit}) — confirm, edit{arSupported ? ', or Measure (AR)' : ''}.</div>
                    )}
                  </div>
                )}
              </div>
            </div>
            <div className="flex gap-2 mt-2">
              <button onClick={() => addChip(s)}
                disabled={s.needsMeasurement && !(Number(qtyById[s.id]) > 0)}
                className="flex-1 h-9 rounded-lg bg-emerald-600 text-white font-heading font-semibold text-sm hover:bg-emerald-700 disabled:bg-gray-300 disabled:cursor-not-allowed">
                Add
              </button>
              <button onClick={() => dismissChip(s)}
                className="px-4 h-9 rounded-lg border border-gray-300 text-gray-700 font-heading font-semibold text-sm bg-white hover:bg-gray-50">
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Bottom bar */}
      <div className="relative z-10 px-4 py-3 bg-gradient-to-t from-black/70 to-transparent flex items-center justify-between gap-3">
        <div className="text-[12px] text-white/85">
          <span className="font-semibold text-white">{stagedCount}</span> added · {stillCount} photo{stillCount === 1 ? '' : 's'}
        </div>
        <button onClick={() => void finish()}
          className="bg-violet-600 hover:bg-violet-700 text-white font-heading font-bold px-6 py-2.5 rounded-lg">
          Finish
        </button>
      </div>
    </div>
  );
}
