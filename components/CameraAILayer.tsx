/**
 * CameraAILayer — the AI assist layer for the all-in-one camera (Beta).
 *
 * Rides ON TOP of CameraCapture: it reads the camera's existing <video> element
 * for keyframes and runs its OWN audio-only mic, so it adds zero risk to the
 * camera's stream/room/markup machinery. While the inspector works the camera
 * (any room), this layer:
 *   • always listens (chunked audio → Whisper) with visible "heard you" feedback;
 *   • samples a keyframe every ~2.5s → fast vision endpoint → call-out chips;
 *   • applies voice edits to pending chips ("two walls", "whole room", "PPW");
 *   • grabs evidence-stamped stills (per call-out + periodically) into the room;
 *   • Add commits the line to the CURRENT room immediately (tagged to its still).
 *
 * Resets its chips/seen set when the active room changes.
 */

import { useEffect, useRef, useState } from 'react';
import { displayImageSrc } from '@/lib/photoDisplay';
import {
  drawEvidenceStamp, buildStampLines, getGeoFix, resolvePropertyRefCoords, type StampLine,
} from '@/lib/evidenceStamp';
import type { RateCardLineInput } from '@/lib/types';

const INFER_INTERVAL_MS = 2500;
const STILL_INTERVAL_MS = 6000;
const KEYFRAME_EDGE = 640;
const AUDIO_CHUNK_MS = 4000;
const MAX_ROOM_STILLS = 12;

interface ActiveRoom { id: string; name: string }

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
  roomId: string;
  stillUrl?: string;
}

interface Props {
  enabled: boolean;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  getActiveRoom: () => ActiveRoom | null;
  region: string;
  tenantMonths: number | null;
  addressSnapshot: string;
  propertyRecordId?: string;
  uploadPhoto: (file: File) => Promise<string>;
  onAddLine: (sectionId: string, line: RateCardLineInput) => void;
  onStill: (sectionId: string, url: string) => void;
}

function genId(): string {
  const uuid = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `RCLINE-${uuid}`;
}
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { const r = reader.result as string; const c = r.indexOf(','); resolve(c >= 0 ? r.slice(c + 1) : r); };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function CameraAILayer(props: Props) {
  const { enabled, videoRef, getActiveRoom, region, tenantMonths, addressSnapshot, propertyRecordId, uploadPhoto, onAddLine, onStill } = props;

  const openRef = useRef(false);
  const inFlight = useRef(false);
  const inferTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stillTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioRecRef = useRef<MediaRecorder | null>(null);
  const audioLoopRef = useRef(false);
  const audioStreamRef = useRef<MediaStream | null>(null);

  const stampLinesRef = useRef<StampLine[]>([]);
  const transcriptBufRef = useRef('');
  const seenByRoomRef = useRef<Record<string, { codes: Set<string>; descs: Set<string> }>>({});
  const roomStillCountRef = useRef<Record<string, number>>({});
  const chipsRef = useRef<LiveSuggestion[]>([]);
  const activeIdRef = useRef<string | null>(null);

  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [heardText, setHeardText] = useState('');
  const [chips, setChips] = useState<LiveSuggestion[]>([]);
  const [qtyById, setQtyById] = useState<Record<string, string>>({});

  useEffect(() => { chipsRef.current = chips; }, [chips]);

  function seenFor(roomId: string) {
    if (!seenByRoomRef.current[roomId]) seenByRoomRef.current[roomId] = { codes: new Set(), descs: new Set() };
    return seenByRoomRef.current[roomId];
  }

  // Start / stop the whole layer with `enabled`.
  useEffect(() => {
    if (!enabled) return;
    openRef.current = true;
    (async () => {
      const [ref, fix] = await Promise.all([
        resolvePropertyRefCoords(propertyRecordId, addressSnapshot),
        getGeoFix(),
      ]);
      stampLinesRef.current = buildStampLines(addressSnapshot, fix, ref);
      await startAudioLoop();
      inferTimer.current = setInterval(() => { void runInference(); }, INFER_INTERVAL_MS);
      stillTimer.current = setInterval(() => { void captureStill(false); }, STILL_INTERVAL_MS);
      setTimeout(() => { void captureStill(false); }, 1200);
    })();
    return () => {
      openRef.current = false;
      if (inferTimer.current) clearInterval(inferTimer.current);
      if (stillTimer.current) clearInterval(stillTimer.current);
      stopAudioLoop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Reset chips when the active room changes (fresh per room).
  useEffect(() => {
    if (!enabled) return;
    const iv = setInterval(() => {
      const a = getActiveRoom();
      const id = a?.id ?? null;
      if (id !== activeIdRef.current) {
        activeIdRef.current = id;
        setChips([]);
        setHeardText('');
      }
    }, 600);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // ---- voice: chunked audio → Whisper ----
  function pickAudioMime(): string {
    const MR: any = (typeof window !== 'undefined') && (window as any).MediaRecorder;
    if (!MR?.isTypeSupported) return '';
    for (const m of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']) { try { if (MR.isTypeSupported(m)) return m; } catch { /* noop */ } }
    return '';
  }
  function isNoise(t: string): boolean {
    const s = t.trim().toLowerCase().replace(/[.!?]/g, '');
    return s.length < 2 || ['you', 'thank you', 'thanks', 'thanks for watching', 'bye', 'okay', 'ok'].includes(s);
  }
  async function transcribeChunk(blob: Blob) {
    try {
      setTranscribing(true);
      const base64 = await blobToBase64(blob);
      const r = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base64, mime: (blob.type || 'audio/mp4').split(';')[0] }) });
      if (r.ok) { const d = await r.json(); const txt = String(d.text || '').trim(); if (txt && !isNoise(txt)) { transcriptBufRef.current += txt + ' '; setHeardText(txt); } }
    } catch { /* skip */ } finally { setTranscribing(false); }
  }
  async function startAudioLoop() {
    try {
      const audio = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!openRef.current) { audio.getTracks().forEach((t) => t.stop()); return; }
      audioStreamRef.current = audio;
      audioLoopRef.current = true;
      setListening(true);
      const mime = pickAudioMime();
      const recordOnce = () => {
        if (!audioLoopRef.current || !openRef.current || !audioStreamRef.current) return;
        try {
          const rec = mime ? new MediaRecorder(audioStreamRef.current, { mimeType: mime }) : new MediaRecorder(audioStreamRef.current);
          audioRecRef.current = rec;
          const parts: BlobPart[] = [];
          rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
          rec.onstop = () => {
            if (parts.length) { const blob = new Blob(parts, { type: rec.mimeType || mime || 'audio/mp4' }); if (blob.size > 1200) void transcribeChunk(blob); }
            if (audioLoopRef.current && openRef.current) recordOnce();
          };
          rec.start();
          setTimeout(() => { try { if (rec.state !== 'inactive') rec.stop(); } catch { /* noop */ } }, AUDIO_CHUNK_MS);
        } catch { setListening(false); }
      };
      recordOnce();
    } catch { setListening(false); }
  }
  function stopAudioLoop() {
    audioLoopRef.current = false;
    setListening(false);
    try { if (audioRecRef.current && audioRecRef.current.state !== 'inactive') audioRecRef.current.stop(); } catch { /* noop */ }
    audioRecRef.current = null;
    audioStreamRef.current?.getTracks().forEach((t) => t.stop());
    audioStreamRef.current = null;
  }

  // ---- frames + stills (read the shared camera video) ----
  function grabKeyframeB64(edge: number): string | null {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return null;
    const scale = Math.min(1, edge / Math.max(v.videoWidth, v.videoHeight));
    const w = Math.round(v.videoWidth * scale), h = Math.round(v.videoHeight * scale);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); if (!ctx) return null;
    ctx.drawImage(v, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.6).split(',')[1] || null;
  }
  async function captureStill(force: boolean): Promise<string | undefined> {
    const v = videoRef.current;
    const room = getActiveRoom();
    if (!openRef.current || !v || !v.videoWidth || !room) return undefined;
    if (!force && (roomStillCountRef.current[room.id] || 0) >= MAX_ROOM_STILLS) return undefined;
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
    const ctx = c.getContext('2d'); if (!ctx) return undefined;
    ctx.drawImage(v, 0, 0, c.width, c.height);
    drawEvidenceStamp(ctx, c.width, c.height, stampLinesRef.current);
    const blob = await new Promise<Blob | null>((res) => c.toBlob((b) => res(b), 'image/jpeg', 0.8));
    if (!blob) return undefined;
    try {
      const url = await uploadPhoto(new File([blob], `ai_${Date.now()}.jpg`, { type: 'image/jpeg' }));
      if (!openRef.current) return undefined;
      roomStillCountRef.current[room.id] = (roomStillCountRef.current[room.id] || 0) + 1;
      onStill(room.id, url);
      return url;
    } catch { return undefined; }
  }

  // ---- inference ----
  async function runInference() {
    if (inFlight.current || !openRef.current) return;
    const room = getActiveRoom();
    if (!room) return;
    const b64 = grabKeyframeB64(KEYFRAME_EDGE);
    if (!b64) return;
    inFlight.current = true;
    setScanning(true);
    const delta = transcriptBufRef.current.trim();
    transcriptBufRef.current = '';
    const seen = seenFor(room.id);
    try {
      const r = await fetch('/api/rate-card/room-scan-live', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sectionName: room.name,
          tenantMonths: typeof tenantMonths === 'number' ? tenantMonths : 12,
          transcriptDelta: delta,
          seen: Array.from(seen.descs),
          active: chipsRef.current.filter((c) => c.roomId === room.id).map((c) => ({ id: c.id, description: c.description, unit: c.unit })),
          frame: b64,
        }),
      });
      if (!r.ok || !openRef.current) return;
      const d = await r.json();

      const editList: any[] = Array.isArray(d.edits) ? d.edits : [];
      if (editList.length) {
        setChips((cur) => cur.map((c) => {
          const e = editList.find((x) => x.targetId === c.id);
          if (!e) return c;
          const nc = { ...c };
          if (e.lineItemCode) { nc.lineItemCode = e.lineItemCode; nc.description = e.description || nc.description; nc.category = e.category || nc.category; nc.subcategory = e.subcategory ?? nc.subcategory; nc.unit = e.unit || nc.unit; nc.needsMeasurement = !!e.needsMeasurement; nc.measurementUnit = e.measurementUnit || ''; }
          if (e.vendor) nc.suggestedVendor = e.vendor;
          if (typeof e.tenantBillBackPercent === 'number') nc.tenantBillBackPercent = e.tenantBillBackPercent;
          if (typeof e.quantity === 'number') nc.quantity = e.quantity;
          return nc;
        }));
        setQtyById((m) => { const n = { ...m }; for (const e of editList) if (typeof e.quantity === 'number') n[e.targetId] = String(e.quantity); return n; });
      }

      const incoming: LiveSuggestion[] = Array.isArray(d.suggestions) ? d.suggestions : [];
      const fresh = incoming.filter((s) => s.lineItemCode && !seen.codes.has(s.lineItemCode));
      if (fresh.length) {
        const batchStill = await captureStill(true);
        const seed: Record<string, string> = {};
        for (const s of fresh) {
          seen.codes.add(s.lineItemCode);
          seen.descs.add(s.description);
          s.roomId = room.id;
          s.stillUrl = batchStill;
          if (s.needsMeasurement && s.estimatedQuantity && s.estimatedQuantity > 0) seed[s.id] = String(s.estimatedQuantity);
        }
        if (Object.keys(seed).length) setQtyById((m) => ({ ...m, ...seed }));
        setChips((cur) => [...cur, ...fresh]);
      }
    } catch { /* skip */ } finally {
      inFlight.current = false;
      setScanning(false);
    }
  }

  // ---- chip actions ----
  function addChip(s: LiveSuggestion) {
    let qty: number;
    if (s.needsMeasurement) { const v = Number(qtyById[s.id]); if (!isFinite(v) || v <= 0) return; qty = v; }
    else qty = s.quantity ?? 1;
    const line: RateCardLineInput = {
      externalId: genId(), section: '', location: '',
      lineItemCode: s.lineItemCode, quantity: qty,
      tenantBillBackPercent: s.tenantBillBackPercent, assignedTo: s.suggestedVendor || 'Vendor 1',
      note: '', customLaborRate: null, customAdjustedMaterialCost: null, customVendorCost: null,
      photoUrls: s.stillUrl ? [s.stillUrl] : [],
    };
    onAddLine(s.roomId, line);
    setChips((cur) => cur.filter((c) => c.id !== s.id));
  }
  function dismissChip(s: LiveSuggestion) {
    setChips((cur) => cur.filter((c) => c.id !== s.id));
  }

  if (!enabled) return null;
  const activeId = activeIdRef.current;
  const visibleChips = chips.filter((c) => c.roomId === activeId || !activeId);
  const confColor = (c: string) => c === 'high' ? 'bg-emerald-500' : c === 'low' ? 'bg-amber-500' : 'bg-sky-500';

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-30">
      {/* Status / heard line (just under the camera top bar) */}
      <div className="px-4 pt-16 flex justify-center">
        <div className="pointer-events-none text-[12px] text-white bg-black/45 rounded-full px-3 py-1.5 max-w-[92%]">
          {scanning ? (
            <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse" /> Thinking…</span>
          ) : transcribing ? (
            <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> Heard you…</span>
          ) : heardText ? (
            <span className="italic text-emerald-200">“{heardText}”</span>
          ) : (
            <span className="flex items-center gap-1.5"><span className={`w-1.5 h-1.5 rounded-full ${listening ? 'bg-emerald-400 animate-pulse' : 'bg-white/40'}`} /> {listening ? 'Listening — say what you see' : 'Mic off'}</span>
          )}
        </div>
      </div>

      {/* Chip tray — floats above the camera controls */}
      <div className="pointer-events-none absolute left-0 right-0 bottom-28 px-3 space-y-2 max-h-[42vh] overflow-y-auto">
        {visibleChips.map((s) => (
          <div key={s.id} className="pointer-events-auto bg-white/95 backdrop-blur rounded-xl p-3 shadow-lg">
            <div className="flex items-start gap-2">
              {s.stillUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={displayImageSrc(s.stillUrl)} alt="" className="w-12 h-12 object-cover rounded border border-gray-200 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${confColor(s.confidence)}`} />
                  <span className="text-sm font-semibold text-ink">{s.description}</span>
                </div>
                <div className="text-[11px] text-gray-500">{s.category}{s.subcategory ? ` · ${s.subcategory}` : ''} · {s.suggestedVendor}</div>
                {s.rationale && <div className="text-xs text-gray-600 mt-0.5 leading-snug">{s.rationale}</div>}
                {s.needsMeasurement && (
                  <div className="mt-2">
                    <div className="flex items-center gap-2">
                      <input type="text" inputMode="decimal" value={qtyById[s.id] || ''}
                        onChange={(e) => setQtyById((m) => ({ ...m, [s.id]: e.target.value.replace(/[^0-9.]/g, '') }))}
                        placeholder={`Enter ${s.measurementUnit}`}
                        className="h-9 w-28 bg-gray-100 rounded-lg px-3 text-sm outline-none focus:ring-2 focus:ring-violet-300" />
                      <span className="text-xs text-gray-500">{s.measurementUnit}</span>
                    </div>
                    {s.estimatedQuantity && s.estimatedQuantity > 0 && (
                      <div className="text-[11px] text-amber-700 mt-1">≈ AI estimate ({s.estimatedQuantity} {s.unit}) — confirm, edit, or say the size.</div>
                    )}
                  </div>
                )}
              </div>
            </div>
            <div className="flex gap-2 mt-2">
              <button onClick={() => addChip(s)} disabled={s.needsMeasurement && !(Number(qtyById[s.id]) > 0)}
                className="flex-1 h-9 rounded-lg bg-emerald-600 text-white font-heading font-semibold text-sm hover:bg-emerald-700 disabled:bg-gray-300 disabled:cursor-not-allowed">Add</button>
              <button onClick={() => dismissChip(s)}
                className="px-4 h-9 rounded-lg border border-gray-300 text-gray-700 font-heading font-semibold text-sm bg-white hover:bg-gray-50">✕</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
