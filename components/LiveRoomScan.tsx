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
import { defaultVendorForItem } from '@/lib/vendors';
import type { RateCardLineInput } from '@/lib/types';

const INFER_INTERVAL_MS = 2500;   // keyframe → vision cadence
const STILL_INTERVAL_MS = 5000;   // full-res stamped still cadence
const KEYFRAME_EDGE = 640;        // downscale before sending (speed)
const MAX_STILLS = 10;
const SIG_EDGE = 16;              // tiny grayscale grid for silent-tick change detection
const FRAME_SAME_DELTA = 6;       // mean abs grayscale diff below this = "same scene" → skip

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

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const r = reader.result as string;
      const comma = r.indexOf(',');
      resolve(comma >= 0 ? r.slice(comma + 1) : r);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
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
  const finishedRef = useRef(false);  // guards finish() against a double-tap
  const openRef = useRef(true);
  const lastFrameSigRef = useRef<Uint8ClampedArray | null>(null);  // last analyzed silent-tick frame
  const audioRecRef = useRef<MediaRecorder | null>(null);
  const audioLoopRef = useRef(false);

  const stampLinesRef = useRef<StampLine[]>([]);
  const seenDescRef = useRef<Set<string>>(new Set());   // sent to model + dedupe
  const seenCodeRef = useRef<Set<string>>(new Set());   // client dedupe
  const transcriptBufRef = useRef('');                  // transcribed text not yet sent
  const stillUrlsRef = useRef<string[]>([]);
  const latestStillRef = useRef<string | undefined>(undefined);
  const stagedRef = useRef<RateCardLineInput[]>([]);
  const chipsRef = useRef<LiveSuggestion[]>([]);        // live mirror for the inference payload

  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [heardText, setHeardText] = useState('');
  const [chips, setChips] = useState<LiveSuggestion[]>([]);
  const [qtyById, setQtyById] = useState<Record<string, string>>({});
  const [stagedCount, setStagedCount] = useState(0);
  const [stillCount, setStillCount] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [arSupported, setArSupported] = useState(false);
  const [measuring, setMeasuring] = useState(false);

  useEffect(() => { chipsRef.current = chips; }, [chips]);

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
          audio: true,
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
        startAudioLoop();
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
    stopAudioLoop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  // AR measure needs exclusive camera access, so pause the live pipeline, run
  // the WebXR session, then resume — keeps both smooth and conflict-free.
  function pauseForAr() {
    if (inferTimer.current) clearInterval(inferTimer.current);
    if (stillTimer.current) clearInterval(stillTimer.current);
    stopAudioLoop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }
  async function resumeAfterAr() {
    if (!openRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true,
      });
      if (!openRef.current) { stream.getTracks().forEach((t) => t.stop()); return; }
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play().catch(() => {}); }
      startAudioLoop();
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

  // ---- voice: chunked audio → Whisper (works on iOS Safari too) ----
  // We cycle a MediaRecorder in ~4s clips; each complete clip is transcribed and
  // fed to the next inference. This replaces the Web Speech API (absent/flaky on
  // iOS) and gives a reliable "heard you" signal on every platform.
  function pickAudioMime(): string {
    const MR: any = (typeof window !== 'undefined') && (window as any).MediaRecorder;
    if (!MR?.isTypeSupported) return '';
    for (const m of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']) {
      try { if (MR.isTypeSupported(m)) return m; } catch { /* noop */ }
    }
    return '';
  }
  // Common Whisper "silence hallucinations" we don't want to feed the model.
  function isNoise(t: string): boolean {
    const s = t.trim().toLowerCase().replace(/[.!?]/g, '');
    return s.length < 2 || ['you', 'thank you', 'thanks', 'thanks for watching', 'bye', 'okay', 'ok'].includes(s);
  }
  async function transcribeChunk(blob: Blob) {
    try {
      setTranscribing(true);
      const base64 = await blobToBase64(blob);
      const r = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64, mime: (blob.type || 'audio/mp4').split(';')[0] }),
      });
      if (r.ok) {
        const d = await r.json();
        const txt = String(d.text || '').trim();
        if (txt && !isNoise(txt)) {
          transcriptBufRef.current += txt + ' ';
          setHeardText(txt);
        }
      }
    } catch { /* skip this clip */ } finally {
      setTranscribing(false);
    }
  }
  function startAudioLoop() {
    const stream = streamRef.current;
    if (!stream || stream.getAudioTracks().length === 0) { setListening(false); return; }
    audioLoopRef.current = true;
    setListening(true);
    const mime = pickAudioMime();
    const recordOnce = () => {
      if (!audioLoopRef.current || !openRef.current || !streamRef.current) return;
      try {
        const audioStream = new MediaStream(streamRef.current.getAudioTracks());
        const rec = mime ? new MediaRecorder(audioStream, { mimeType: mime }) : new MediaRecorder(audioStream);
        audioRecRef.current = rec;
        const parts: BlobPart[] = [];
        rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
        rec.onstop = () => {
          if (parts.length) {
            const blob = new Blob(parts, { type: rec.mimeType || mime || 'audio/mp4' });
            if (blob.size > 1200) void transcribeChunk(blob);
          }
          if (audioLoopRef.current && openRef.current) recordOnce();
        };
        rec.start();
        setTimeout(() => { try { if (rec.state !== 'inactive') rec.stop(); } catch { /* noop */ } }, 4000);
      } catch {
        setListening(false);
      }
    };
    recordOnce();
  }
  function stopAudioLoop() {
    audioLoopRef.current = false;
    setListening(false);
    try { if (audioRecRef.current && audioRecRef.current.state !== 'inactive') audioRecRef.current.stop(); } catch { /* noop */ }
    audioRecRef.current = null;
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

  // Coarse 16x16 grayscale fingerprint of the current frame — cheap (tiny canvas
  // + one getImageData). Used to skip silent vision ticks when the camera is held
  // still: a near-duplicate frame only yields already-deduped suggestions.
  function frameSignature(): Uint8ClampedArray | null {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return null;
    const c = document.createElement('canvas');
    c.width = SIG_EDGE; c.height = SIG_EDGE;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0, SIG_EDGE, SIG_EDGE);
    let data: Uint8ClampedArray;
    try { data = ctx.getImageData(0, 0, SIG_EDGE, SIG_EDGE).data; } catch { return null; }
    const gray = new Uint8ClampedArray(SIG_EDGE * SIG_EDGE);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) gray[p] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
    return gray;
  }
  function frameChangedEnough(sig: Uint8ClampedArray): boolean {
    const last = lastFrameSigRef.current;
    if (!last || last.length !== sig.length) return true;
    let sum = 0;
    for (let i = 0; i < sig.length; i++) sum += Math.abs(sig[i] - last[i]);
    return sum / sig.length >= FRAME_SAME_DELTA;
  }

  // Capture a full-res, evidence-stamped still → upload → room photos. Returns
  // the uploaded URL. `force` bypasses the periodic cap (used for per-suggestion
  // stills and the manual shutter, so each item gets its OWN photo).
  async function captureStill(force = false): Promise<string | undefined> {
    const v = videoRef.current;
    if (!openRef.current || !v || !v.videoWidth) return undefined;
    if (!force && stillUrlsRef.current.length >= MAX_STILLS) return undefined;
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    const ctx = c.getContext('2d');
    if (!ctx) return undefined;
    ctx.drawImage(v, 0, 0, c.width, c.height);
    drawEvidenceStamp(ctx, c.width, c.height, stampLinesRef.current);
    const blob = await new Promise<Blob | null>((res) => c.toBlob((b) => res(b), 'image/jpeg', 0.8));
    if (!blob) return undefined;
    try {
      const f = new File([blob], `live_${Date.now()}.jpg`, { type: 'image/jpeg' });
      const url = await uploadPhoto(f);
      if (!openRef.current) return undefined;
      stillUrlsRef.current.push(url);
      latestStillRef.current = url;
      setStillCount(stillUrlsRef.current.length);
      return url;
    } catch { return undefined; }
  }

  // ---- inference ----
  async function runInference() {
    if (inFlight.current || !openRef.current) return;
    const delta = transcriptBufRef.current.trim();
    // Silent vision tick: skip the call when the scene hasn't materially changed
    // since the last analyzed frame (camera held still). A duplicate frame only
    // produces already-deduped suggestions, so this cuts the highest-frequency
    // vision call with no loss. Voice ticks always run — voice is the primary
    // signal and is analyzed text-only server-side.
    if (!delta) {
      const sig = frameSignature();
      if (sig && !frameChangedEnough(sig)) return;
      if (sig) lastFrameSigRef.current = sig;
    }
    const b64 = grabKeyframeB64(KEYFRAME_EDGE);
    if (!b64) return;
    inFlight.current = true;
    setScanning(true);
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
          active: chipsRef.current.map((c) => ({ id: c.id, description: c.description, unit: c.unit })),
          frame: b64,
        }),
      });
      if (!r.ok || !openRef.current) return;
      const d = await r.json();

      // Apply voice edits to pending chips first (qty / scope / vendor / %).
      const editList: any[] = Array.isArray(d.edits) ? d.edits : [];
      if (editList.length) {
        setChips((cur) => cur.map((c) => {
          const e = editList.find((x) => x.targetId === c.id);
          if (!e) return c;
          const nc = { ...c };
          if (e.lineItemCode) {
            nc.lineItemCode = e.lineItemCode;
            nc.description = e.description || nc.description;
            nc.category = e.category || nc.category;
            nc.subcategory = e.subcategory ?? nc.subcategory;
            nc.unit = e.unit || nc.unit;
            nc.needsMeasurement = !!e.needsMeasurement;
            nc.measurementUnit = e.measurementUnit || '';
          }
          if (e.vendor) nc.suggestedVendor = e.vendor;
          if (typeof e.tenantBillBackPercent === 'number') nc.tenantBillBackPercent = e.tenantBillBackPercent;
          if (typeof e.quantity === 'number') nc.quantity = e.quantity;
          return nc;
        }));
        setQtyById((m) => {
          const n = { ...m };
          for (const e of editList) if (typeof e.quantity === 'number') n[e.targetId] = String(e.quantity);
          return n;
        });
      }

      const incoming: LiveSuggestion[] = Array.isArray(d.suggestions) ? d.suggestions : [];
      const fresh = incoming.filter((s) => s.lineItemCode && !seenCodeRef.current.has(s.lineItemCode));
      if (fresh.length) {
        // Capture a DEDICATED still for this batch so each call-out gets its own
        // relevant photo (not a single shared frame).
        const batchStill = await captureStill(true);
        const seed: Record<string, string> = {};
        for (const s of fresh) {
          seenCodeRef.current.add(s.lineItemCode);
          seenDescRef.current.add(s.description);
          s.stillUrl = batchStill || latestStillRef.current;
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
      assignedTo: defaultVendorForItem({ lineItemCode: s.lineItemCode, description: s.description }) || s.suggestedVendor || 'Vendor 1',
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
    if (finishedRef.current) return;  // re-entry guard: a double-tap would otherwise
    finishedRef.current = true;       // add every staged line + still TWICE.
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
          {/* Always-listening indicator */}
          <span className="flex items-center gap-1 text-[11px] text-white/90">
            <span className={`w-2 h-2 rounded-full ${listening ? 'bg-emerald-400 animate-pulse' : 'bg-white/40'}`} />
            {listening ? 'Listening' : 'Mic off'}
          </span>
          <button onClick={() => { teardown(); onClose(); }} aria-label="Cancel"
            className="text-white/90 text-2xl leading-none w-8 h-8 flex items-center justify-center">×</button>
        </div>
      </div>

      {/* Voice / guidance + assurance line */}
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
          <div className="text-[12px] text-white bg-black/40 rounded-lg px-3 py-1.5 inline-block max-w-full">
            {scanning ? (
              <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse" /> Thinking…</span>
            ) : transcribing ? (
              <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> Heard you — processing…</span>
            ) : heardText ? (
              <span className="italic text-emerald-200">“{heardText}”</span>
            ) : (
              <span className="text-white/80">Pan slowly — say what you see (e.g. “broken blinds, paint two walls, carpet needs replacing”).</span>
            )}
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
        <div className="flex items-center gap-3">
          {/* Manual shutter — grab a still into the room photos any time. */}
          <button onClick={() => void captureStill(true)} disabled={!ready} aria-label="Take photo"
            className="w-12 h-12 rounded-full bg-white/90 border-4 border-white/60 shadow-lg active:scale-95 disabled:opacity-50 flex items-center justify-center">
            <span className="w-7 h-7 rounded-full bg-white border border-gray-300" />
          </button>
          <button onClick={() => void finish()}
            className="bg-violet-600 hover:bg-violet-700 text-white font-heading font-bold px-6 py-2.5 rounded-lg">
            Finish
          </button>
        </div>
      </div>
    </div>
  );
}
