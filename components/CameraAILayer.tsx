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
const KEYFRAME_EDGE = 640;
const AUDIO_CHUNK_MS = 4000;
const MAX_ROOM_STILLS = 12;
// Auto-still is now a FALLBACK: it only fires when the inspector has gone idle
// (no manual shutter, no AI still, no chip) for this long — so supplemental
// photos fill gaps instead of firing every few seconds.
const AUTO_IDLE_MS = 15000;
const AUTO_CHECK_MS = 3500;
const DEBUG_DEFAULT = true; // on-device pipeline HUD (mic → Whisper → vision)
// Peak deviation (0–128) a clip must reach to count as speech. Below this it's
// silence/background and we skip Whisper (which otherwise hallucinates phrases).
// Kept low enough not to clip quiet/distant speech; the phrase filter is the
// backstop for any hallucination that slips through.
const VAD_PEAK_MIN = 9;

interface ActiveRoom { id: string; name: string; photoCount?: number }

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
  // The camera's shared stream (video + audio in AI mode). We pull the mic from
  // here instead of opening a second getUserMedia — one stream = reliable voice.
  getStream: () => MediaStream | null;
  // Epoch ms of the last manual shutter press (0 if none) — gates the auto-still.
  getLastManualCaptureAt: () => number;
  getActiveRoom: () => ActiveRoom | null;
  rooms: ActiveRoom[];
  onNavigateRoom: (sectionId: string) => void;
  region: string;
  tenantMonths: number | null;
  addressSnapshot: string;
  propertyRecordId?: string;
  uploadPhoto: (file: File) => Promise<string>;
  onAddLine: (sectionId: string, line: RateCardLineInput) => void;
  onStill: (sectionId: string, url: string) => void;
  // Report the live status up so the host camera can render it in its header.
  onStatus?: (s: { text: string; tone: 'idle' | 'listen' | 'heard' | 'think' | 'err' }) => void;
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
  const { enabled, videoRef, getStream, getLastManualCaptureAt, getActiveRoom, rooms, onNavigateRoom, region, tenantMonths, addressSnapshot, propertyRecordId, uploadPhoto, onAddLine, onStill, onStatus } = props;

  // Kept fresh each render so the once-wired audio loop / inference timers read
  // current rooms + callbacks instead of their first-render closures.
  const roomsRef = useRef<ActiveRoom[]>(rooms);
  const navRef = useRef(onNavigateRoom);
  const getActiveRoomRef = useRef(getActiveRoom);
  // The timers/audio loop are wired once, so they'd otherwise call first-render
  // versions of these props. Mirror them so the hot paths always use current.
  const uploadPhotoRef = useRef(uploadPhoto);
  const onStillRef = useRef(onStill);
  const onAddLineRef = useRef(onAddLine);
  const getStreamRef = useRef(getStream);
  const getLastManualCaptureAtRef = useRef(getLastManualCaptureAt);
  const tenantMonthsRef = useRef(tenantMonths);
  useEffect(() => {
    roomsRef.current = rooms; navRef.current = onNavigateRoom; getActiveRoomRef.current = getActiveRoom;
    uploadPhotoRef.current = uploadPhoto; onStillRef.current = onStill; onAddLineRef.current = onAddLine;
    getStreamRef.current = getStream; getLastManualCaptureAtRef.current = getLastManualCaptureAt;
    tenantMonthsRef.current = tenantMonths;
  });

  const openRef = useRef(false);
  const inFlight = useRef(false);
  const inferTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stillTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioRecRef = useRef<MediaRecorder | null>(null);
  const audioLoopRef = useRef(false);
  // Only set if the shared stream had no audio (mic permission denied on the
  // combined request) and we had to open our own mic as a fallback.
  const ownAudioRef = useRef<MediaStream | null>(null);
  // Web Audio analyser for voice-activity detection — we measure each clip's
  // loudness and skip transcription on near-silent clips so Whisper can't
  // hallucinate stock phrases ("bye bye", "thank you") on silence.
  const audioCtxRef = useRef<AudioContext | null>(null);

  const stampLinesRef = useRef<StampLine[]>([]);
  const transcriptBufRef = useRef('');
  // Recent transcript fragments for room-nav matching — a command like
  // "move to the front entryway" often splits across two ~4s clips, so we match
  // against a short rolling window, not a single clip.
  const navRecentRef = useRef<{ t: number; text: string }[]>([]);
  const seenByRoomRef = useRef<Record<string, { codes: Set<string>; descs: Set<string> }>>({});
  const roomStillCountRef = useRef<Record<string, number>>({});
  const chipsRef = useRef<LiveSuggestion[]>([]);
  // Active room id. Ref drives the poll's change-detection (no stale closure);
  // state drives the render filter. We NEVER clear chips on room change — chips
  // are kept per-room and filtered by activeId, so an in-flight inference can't
  // wipe a just-added chip, and a room's un-actioned chips reappear on return.
  const activeIdRef = useRef<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Auto-still fallback bookkeeping: last AI still + room-entered timestamps.
  const lastAiStillAtRef = useRef(0);
  const roomEnteredAtRef = useRef(Date.now());

  // ---- on-device debug HUD (mic → Whisper → vision pipeline) ----
  const [dbgOn, setDbgOn] = useState(DEBUG_DEFAULT);
  const [dbgLines, setDbgLines] = useState<string[]>([]);
  function dbg(s: string) {
    const line = `${new Date().toLocaleTimeString('en-US', { hour12: false })} ${s}`;
    // eslint-disable-next-line no-console
    console.log('[AICam]', line);
    setDbgLines((p) => [...p.slice(-11), line]);
  }

  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [heardText, setHeardText] = useState('');
  const [errText, setErrText] = useState('');
  const [chips, setChips] = useState<LiveSuggestion[]>([]);
  const [qtyById, setQtyById] = useState<Record<string, string>>({});
  // Capture animation: a shutter flash + a "saved" thumbnail toast so the
  // inspector sees the AI grabbing room photos and doesn't re-shoot them.
  const [flashKey, setFlashKey] = useState(0);
  const [savedShot, setSavedShot] = useState<{ key: number; url: string; roomName: string; count: number } | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { chipsRef.current = chips; }, [chips]);

  // Derive a single status line + tone and report it up to the host camera,
  // which renders it in its black header strip (not floating over the image).
  useEffect(() => {
    if (!enabled) return;
    let text: string; let tone: 'idle' | 'listen' | 'heard' | 'think' | 'err';
    if (errText) { text = errText; tone = 'err'; }
    else if (scanning) { text = 'Thinking…'; tone = 'think'; }
    else if (transcribing) { text = 'Heard you…'; tone = 'heard'; }
    else if (heardText) { text = `“${heardText}”`; tone = 'heard'; }
    else if (listening) { text = 'Listening — say what you see'; tone = 'listen'; }
    else { text = 'Starting mic…'; tone = 'idle'; }
    onStatus?.({ text, tone });
  }, [enabled, errText, scanning, transcribing, heardText, listening, onStatus]);

  function seenFor(roomId: string) {
    if (!seenByRoomRef.current[roomId]) seenByRoomRef.current[roomId] = { codes: new Set(), descs: new Set() };
    return seenByRoomRef.current[roomId];
  }

  // Start / stop the whole layer with `enabled`.
  useEffect(() => {
    if (!enabled) return;
    openRef.current = true;
    dbg('layer enabled');
    (async () => {
      const [ref, fix] = await Promise.all([
        resolvePropertyRefCoords(propertyRecordId, addressSnapshot),
        getGeoFix(),
      ]);
      stampLinesRef.current = buildStampLines(addressSnapshot, fix, ref);
      await startAudioLoop();
      inferTimer.current = setInterval(() => { void runInference(); }, INFER_INTERVAL_MS);
      // Auto-still FALLBACK: only when idle (no manual/AI photo) for AUTO_IDLE_MS.
      stillTimer.current = setInterval(() => { void maybeAutoStill(); }, AUTO_CHECK_MS);
    })();
    return () => {
      openRef.current = false;
      if (inferTimer.current) clearInterval(inferTimer.current);
      if (stillTimer.current) clearInterval(stillTimer.current);
      if (savedTimer.current) clearTimeout(savedTimer.current);
      stopAudioLoop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Reset chips when the active room changes (fresh per room).
  useEffect(() => {
    if (!enabled) return;
    const iv = setInterval(() => {
      const a = getActiveRoomRef.current();
      const id = a?.id ?? null;
      if (id !== activeIdRef.current) {
        activeIdRef.current = id;
        setActiveId(id);
        roomEnteredAtRef.current = Date.now();
        setHeardText('');
        dbg(`room → ${a?.name || '—'}`);
      }
    }, 600);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Auto-still fallback: fire ONE supplemental stamped still only when the
  // inspector has been idle (no manual shutter, no AI still) for AUTO_IDLE_MS,
  // so we ensure coverage without spamming photos while they're shooting/talking.
  async function maybeAutoStill() {
    if (!openRef.current) return;
    const room = getActiveRoomRef.current();
    if (!room) return;
    if ((roomStillCountRef.current[room.id] || 0) >= MAX_ROOM_STILLS) return;
    const lastManual = getLastManualCaptureAtRef.current?.() || 0;
    const idleSince = Math.max(lastManual, lastAiStillAtRef.current, roomEnteredAtRef.current);
    if (Date.now() - idleSince < AUTO_IDLE_MS) return;
    dbg(`auto-still (idle ${Math.round((Date.now() - idleSince) / 1000)}s)`);
    await captureStill(false, 'auto');
  }

  // ---- voice: chunked audio → Whisper ----
  function pickAudioMime(): string {
    const MR: any = (typeof window !== 'undefined') && (window as any).MediaRecorder;
    if (!MR?.isTypeSupported) return '';
    // iOS Safari ONLY records audio/mp4; Android Chrome's mp4 audio recording is
    // often broken/empty, while webm/opus is reliable — so order by platform.
    const isIOS = typeof navigator !== 'undefined'
      && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && (navigator as any).maxTouchPoints > 1));
    const order = isIOS
      ? ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
      : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    for (const m of order) { try { if (MR.isTypeSupported(m)) return m; } catch { /* noop */ } }
    return '';
  }
  // Whisper "silence hallucinations" — on a near-silent / noisy clip (road, wind)
  // it emits stock phrases ("thank you", "bye bye") or repeated junk tokens
  // ("pdf pdf PDF PDF…", "you you you"). Drop them so they never reach the model
  // or the on-screen feedback.
  const NOISE_PHRASES = new Set([
    'you', 'thank you', 'thanks', 'thank you very much', 'thanks for watching',
    'thank you for watching', 'bye', 'bye bye', 'byebye', 'goodbye', 'see you',
    'see you next time', 'see you later', 'okay', 'ok', 'uh', 'um', 'hmm', 'mm',
    'mhm', 'yeah', 'so', 'the', 'please subscribe', 'subscribe', 'i', 'oh',
    'thank you so much', 'thanks so much', 'music', 'applause', 'foreign',
    'pdf', 'pdf pdf', 'pc', 'la la la', 'na na na',
  ]);
  // Single tokens that, when they dominate a clip, mark it as hallucinated noise.
  const JUNK_TOKENS = new Set(['pdf', 'pc', 'you', 'the', 'uh', 'um', 'mm', 'mhm', 'la', 'na', 'ah', 'oh', 'yeah', 'bye', 'thank', 'thanks', 'so', 'a', 'i']);
  function isNoise(t: string): boolean {
    const s = t.trim().toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
    if (s.length < 3) return true;
    if (NOISE_PHRASES.has(s)) return true;
    const words = s.split(' ').filter(Boolean);
    if (!words.length) return true;
    // Dominant repeated token: e.g. "pdf pdf PDF PDF pdf PDF PDF pc p" — if one
    // token is >=50% of a 3+ word clip, it's hallucinated noise, not speech.
    const freq: Record<string, number> = {};
    let maxTok = ''; let maxN = 0;
    for (const w of words) { freq[w] = (freq[w] || 0) + 1; if (freq[w] > maxN) { maxN = freq[w]; maxTok = w; } }
    if (words.length >= 3 && maxN / words.length >= 0.5) return true;
    if (Object.keys(freq).length === 1 && JUNK_TOKENS.has(maxTok)) return true;
    return false;
  }
  async function transcribeChunk(blob: Blob) {
    try {
      setTranscribing(true);
      const base64 = await blobToBase64(blob);
      const r = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base64, mime: (blob.type || 'audio/mp4').split(';')[0] }) });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        dbg(`stt ✗ ${r.status} ${String(e?.error || '').slice(0, 40)}`);
        setErrText(`Voice ${r.status}: ${String(e?.error || '').slice(0, 50)}`);
        return;
      }
      const d = await r.json();
      const txt = String(d.text || '').trim();
      if (!txt) { dbg('stt: (empty)'); return; }
      if (isNoise(txt)) { dbg(`stt: noise “${txt.slice(0, 24)}”`); return; }
      dbg(`stt ✓ “${txt.slice(0, 32)}”`);
      setErrText('');
      setHeardText(txt);
      // Try room navigation against a short rolling window (commands split across
      // clips). If it navigates, treat the window as consumed and DON'T feed it to
      // the work endpoint (otherwise "move to the kitchen" becomes a bogus line).
      const now = Date.now();
      navRecentRef.current = [...navRecentRef.current.filter((e) => now - e.t < 8000), { t: now, text: txt }];
      const navWindow = navRecentRef.current.map((e) => e.text).join(' ');
      if (maybeNavigate(navWindow)) { navRecentRef.current = []; return; }
      transcriptBufRef.current += txt + ' ';
    } catch (e: any) {
      dbg(`stt err ${String(e?.message || e).slice(0, 30)}`);
    } finally { setTranscribing(false); }
  }

  // ---- voice room navigation ("go to kitchen", "walking into bedroom 1") ----
  function normalizeNav(s: string): string {
    return s.toLowerCase()
      .replace(/\bone\b/g, '1').replace(/\btwo\b/g, '2').replace(/\bthree\b/g, '3')
      .replace(/\bfour\b/g, '4').replace(/\bfive\b/g, '5').replace(/\bsix\b/g, '6')
      .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function maybeNavigate(raw: string): boolean {
    const t = normalizeNav(raw);
    if (!t) return false;
    const list = roomsRef.current || [];
    if (list.length < 2) return false;
    const cur = getActiveRoomRef.current();
    const go = (id: string): boolean => {
      if (!id || id === cur?.id) return false;
      const r = list.find((x) => x.id === id);
      navRef.current(id);
      if (r) { setHeardText(`→ ${r.name}`); dbg(`nav → ${r.name}`); }
      return true;
    };

    // "next room" / "previous room" relative moves.
    if (/\bnext\s+room\b/.test(t)) {
      const i = list.findIndex((x) => x.id === cur?.id);
      if (i >= 0) return go(list[(i + 1) % list.length].id);
    }
    if (/\b(?:previous|prev|last)\s+room\b/.test(t)) {
      const i = list.findIndex((x) => x.id === cur?.id);
      if (i >= 0) return go(list[(i - 1 + list.length) % list.length].id);
    }

    // Require a navigation cue, then match a room name in the trailing words.
    const cue = t.match(/(?:go(?:ing)?\s+(?:to|into|in)|walk(?:ing)?\s+(?:into|in|to)|head(?:ing)?\s+(?:to|into)|switch(?:ing)?\s+to|mov(?:e|ing)\s+(?:to|on\s+to)|over\s+to|now\s+(?:in|on)|let\s+s\s+(?:do|go\s+to)|back\s+to|this\s+is\s+(?:the\s+)?)/);
    if (!cue || cue.index === undefined) return false;
    const tail = t.slice(cue.index + cue[0].length).trim();
    if (!tail) return false;

    let best: { id: string; score: number } | null = null;
    for (const r of list) {
      const tokens = normalizeNav(r.name).split(' ').filter(Boolean);
      if (!tokens.length) continue;
      let hit = 0;
      for (const tok of tokens) { if (tok.length >= 2 && new RegExp(`\\b${tok}\\b`).test(tail)) hit++; }
      const score = hit / tokens.length; // fraction of the room name heard
      if (hit > 0 && (!best || score > best.score)) best = { id: r.id, score };
    }
    if (best && best.score >= 0.5) return go(best.id);
    return false;
  }
  // Current mic tracks: prefer the camera's SHARED stream; fall back to a mic we
  // opened ourselves. Re-derived each clip so a re-acquired stream is picked up.
  function liveAudioTracks(): MediaStreamTrack[] {
    const shared = getStreamRef.current?.();
    const st = shared?.getAudioTracks().filter((t) => t.readyState === 'live') || [];
    if (st.length) return st;
    return ownAudioRef.current?.getAudioTracks().filter((t) => t.readyState === 'live') || [];
  }
  async function startAudioLoop() {
    // Wait briefly for the camera's shared audio (the combined getUserMedia may
    // still be resolving); only open our own mic if it never appears.
    const start = Date.now();
    while (openRef.current && Date.now() - start < 3000) {
      if (liveAudioTracks().length) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!openRef.current) return;
    let source = getStreamRef.current?.()?.getAudioTracks().some((t) => t.readyState === 'live') ? 'shared' : 'none';
    if (!liveAudioTracks().length) {
      dbg('no shared audio — opening own mic');
      try {
        const own = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (!openRef.current) { own.getTracks().forEach((t) => t.stop()); return; }
        ownAudioRef.current = own;
        source = 'own';
      } catch (e: any) { dbg(`mic denied: ${String(e?.name || e).slice(0, 24)}`); setListening(false); setErrText('Mic blocked — allow microphone'); return; }
    }
    if (!liveAudioTracks().length) { dbg('mic: 0 tracks'); setListening(false); return; }
    audioLoopRef.current = true;
    setListening(true);
    const mime = pickAudioMime();
    dbg(`mic ✓ ${source} · ${mime || 'default'}`);
    const recordOnce = () => {
      if (!audioLoopRef.current || !openRef.current) return;
      const tracks = liveAudioTracks();
      if (!tracks.length) { dbg('mic tracks lost'); setListening(false); return; }
      try {
        const audioStream = new MediaStream(tracks);
        const rec = mime ? new MediaRecorder(audioStream, { mimeType: mime }) : new MediaRecorder(audioStream);
        audioRecRef.current = rec;
        const parts: BlobPart[] = [];

        // --- voice-activity detection: track the clip's peak loudness ---
        let peak = 0; let vadActive = false; let sampler: ReturnType<typeof setInterval> | null = null;
        let srcNode: MediaStreamAudioSourceNode | null = null;
        let analyserNode: AnalyserNode | null = null;
        try {
          const AC: any = (window as any).AudioContext || (window as any).webkitAudioContext;
          if (AC) {
            if (!audioCtxRef.current) audioCtxRef.current = new AC();
            const ctx = audioCtxRef.current!;
            if (ctx.state === 'suspended') ctx.resume().catch(() => {});
            srcNode = ctx.createMediaStreamSource(audioStream);
            const an = ctx.createAnalyser(); an.fftSize = 512;
            srcNode.connect(an);
            analyserNode = an;
            const buf = new Uint8Array(an.fftSize);
            sampler = setInterval(() => {
              an.getByteTimeDomainData(buf);
              let m = 0; for (let i = 0; i < buf.length; i++) { const d = Math.abs(buf[i] - 128); if (d > m) m = d; }
              if (m > peak) peak = m;
            }, 120);
          }
        } catch { /* VAD unavailable → don't gate */ }

        rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
        rec.onstop = () => {
          if (sampler) clearInterval(sampler);
          try { srcNode?.disconnect(); analyserNode?.disconnect(); } catch { /* noop */ }
          vadActive = !!audioCtxRef.current && audioCtxRef.current.state === 'running';
          if (parts.length) {
            const blob = new Blob(parts, { type: rec.mimeType || mime || 'audio/mp4' });
            const kb = Math.round(blob.size / 1024);
            if (blob.size <= 1200) dbg(`clip too small (${blob.size}b)`);
            // Gate on loudness ONLY when VAD is actually running (Android/desktop);
            // if the AudioContext never resumed (some iOS), send the clip ungated.
            else if (vadActive && peak < VAD_PEAK_MIN) dbg(`silent clip skipped (pk${peak})`);
            else { dbg(`clip ${kb}KB pk${peak}`); void transcribeChunk(blob); }
          } else dbg('clip: no data');
          if (audioLoopRef.current && openRef.current) recordOnce();
        };
        rec.onerror = (ev: any) => dbg(`rec err ${String(ev?.error?.name || '')}`);
        rec.start();
        setTimeout(() => { try { if (rec.state !== 'inactive') rec.stop(); } catch { /* noop */ } }, AUDIO_CHUNK_MS);
      } catch (e: any) { dbg(`rec start err ${String(e?.message || e).slice(0, 24)}`); setListening(false); }
    };
    recordOnce();
  }
  function stopAudioLoop() {
    audioLoopRef.current = false;
    setListening(false);
    try { if (audioRecRef.current && audioRecRef.current.state !== 'inactive') audioRecRef.current.stop(); } catch { /* noop */ }
    audioRecRef.current = null;
    // Only stop a mic WE opened — never the camera's shared stream.
    ownAudioRef.current?.getTracks().forEach((t) => t.stop());
    ownAudioRef.current = null;
    try { audioCtxRef.current?.close(); } catch { /* noop */ }
    audioCtxRef.current = null;
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
  async function captureStill(force: boolean, reason = 'still'): Promise<string | undefined> {
    const v = videoRef.current;
    const room = getActiveRoomRef.current();
    if (!openRef.current || !v || !v.videoWidth || !room) return undefined;
    if (!force && (roomStillCountRef.current[room.id] || 0) >= MAX_ROOM_STILLS) return undefined;
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
    const ctx = c.getContext('2d'); if (!ctx) return undefined;
    ctx.drawImage(v, 0, 0, c.width, c.height);
    drawEvidenceStamp(ctx, c.width, c.height, stampLinesRef.current);
    // Fire the shutter flash the instant we grab the frame — immediate feedback,
    // before the (slower) upload round-trip.
    setFlashKey((k) => k + 1);
    lastAiStillAtRef.current = Date.now(); // counts as activity → throttles fallback
    const blob = await new Promise<Blob | null>((res) => c.toBlob((b) => res(b), 'image/jpeg', 0.8));
    if (!blob) return undefined;
    try {
      const url = await uploadPhotoRef.current(new File([blob], `ai_${Date.now()}.jpg`, { type: 'image/jpeg' }));
      if (!openRef.current) return undefined;
      const count = (roomStillCountRef.current[room.id] || 0) + 1;
      roomStillCountRef.current[room.id] = count;
      onStillRef.current(room.id, url);
      dbg(`📸 ${reason} → ${room.name} (#${count})`);
      // Pop the saved-thumbnail toast (re-keyed so back-to-back grabs re-animate).
      setSavedShot({ key: Date.now(), url, roomName: room.name, count });
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSavedShot(null), 2200);
      return url;
    } catch (e: any) { dbg(`still upload err ${String(e?.message || e).slice(0, 24)}`); return undefined; }
  }

  // ---- inference ----
  async function runInference() {
    if (inFlight.current || !openRef.current) return;
    const room = getActiveRoomRef.current();
    if (!room) { setErrText('No active room'); return; }
    const delta = transcriptBufRef.current.trim();
    const b64 = grabKeyframeB64(KEYFRAME_EDGE);
    // Voice goes text-only, so a missing frame only blocks SILENT ticks. If the
    // inspector spoke, proceed even without a usable frame (camera covered/booting).
    if (!delta && !b64) { setErrText('Camera not ready'); return; }
    transcriptBufRef.current = '';
    // If this call fails, put the spoken words back so they aren't lost.
    const rebufferOnFail = () => { if (delta) transcriptBufRef.current = (delta + ' ' + transcriptBufRef.current).trimStart(); };
    inFlight.current = true;
    setScanning(true);
    const seen = seenFor(room.id);
    try {
      const r = await fetch('/api/rate-card/room-scan-live', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sectionName: room.name,
          tenantMonths: typeof tenantMonthsRef.current === 'number' ? tenantMonthsRef.current : 12,
          transcriptDelta: delta,
          seen: Array.from(seen.descs),
          seenCodes: Array.from(seen.codes),
          active: chipsRef.current.filter((c) => c.roomId === room.id).map((c) => ({ id: c.id, description: c.description, unit: c.unit })),
          frame: b64 || '',
        }),
      });
      if (!openRef.current) return;
      if (!r.ok) {
        rebufferOnFail();
        const e = await r.json().catch(() => ({}));
        dbg(`vision ✗ ${r.status} ${String(e?.error || '').slice(0, 40)}`);
        setErrText(`AI ${r.status}: ${String(e?.error || '').slice(0, 80) || 'request failed'}`);
        return;
      }
      const d = await r.json();
      setErrText('');
      const nS = Array.isArray(d.suggestions) ? d.suggestions.length : 0;
      const nE = Array.isArray(d.edits) ? d.edits.length : 0;
      const nU = Array.isArray(d.unmatched) ? d.unmatched.length : 0;
      dbg(`vision ✓${delta ? ` +voice` : ''} sugg:${nS} edit:${nE} unmatch:${nU}`);

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
        const batchStill = await captureStill(true, 'call-out');
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

      // The model heard/saw something but it didn't map to a catalog item — tell
      // the inspector instead of silently dropping it.
      const unmatched: string[] = Array.isArray(d.unmatched) ? d.unmatched : [];
      if (!fresh.length && !editList.length && unmatched.length) {
        setHeardText(`No catalog match for “${unmatched[0]}” — try naming the work`);
      }
    } catch (e: any) {
      rebufferOnFail();
      if (openRef.current) setErrText(`AI offline: ${String(e?.message || e).slice(0, 60)}`);
    } finally {
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
  const visibleChips = chips.filter((c) => c.roomId === activeId || !activeId);
  const confColor = (c: string) => c === 'high' ? 'bg-emerald-500' : c === 'low' ? 'bg-amber-500' : 'bg-sky-500';

  return (
    // Full-viewport overlay (pointer-events pass through except on the chips /
    // debug panel). MUST be fixed inset-0 — a zero-height container would push
    // the bottom-anchored chip tray off-screen.
    <div className="pointer-events-none fixed inset-0 z-30">
      {/* Shutter flash — full-screen white blink the instant a still is grabbed. */}
      {flashKey > 0 && (
        <div key={flashKey} className="fixed inset-0 z-40 bg-white animate-shutterFlash pointer-events-none" />
      )}

      {/* Saved-thumbnail toast — confirms the AI just saved a room photo so the
          inspector knows it's covered and won't re-shoot the same view. */}
      {savedShot && (
        <div key={savedShot.key} className="fixed left-1/2 -translate-x-1/2 top-28 z-40 pointer-events-none animate-shotSaved">
          <div className="flex items-center gap-2 bg-black/75 text-white rounded-xl pl-2 pr-3 py-2 shadow-lg">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={displayImageSrc(savedShot.url)} alt="" className="w-9 h-9 object-cover rounded-md border border-white/30" />
            <div className="leading-tight">
              <div className="text-[12px] font-semibold flex items-center gap-1">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                Photo saved
              </div>
              <div className="text-[10.5px] text-white/70">{savedShot.roomName} · {savedShot.count} auto</div>
            </div>
          </div>
        </div>
      )}

      {/* On-device debug HUD — the live mic → Whisper → vision pipeline so we can
          see exactly where things stall on a real phone. Toggle with the 🐞 chip. */}
      {dbgOn ? (
        <div className="absolute left-2 top-[140px] z-40 w-[190px] bg-black/78 rounded-lg p-2 text-[9px] leading-[1.35] text-emerald-200 font-mono pointer-events-auto shadow-lg">
          <div className="flex items-center justify-between mb-1">
            <span className="text-white font-bold">AI DEBUG</span>
            <button onClick={() => setDbgOn(false)} className="text-white/70 px-1">✕</button>
          </div>
          <div className="space-y-0.5 max-h-[40vh] overflow-y-auto">
            {dbgLines.length === 0 ? <div className="text-white/50">starting…</div>
              : dbgLines.map((l, i) => <div key={i} className="break-words">{l}</div>)}
          </div>
        </div>
      ) : (
        <button onClick={() => setDbgOn(true)} className="absolute left-2 top-[140px] z-40 pointer-events-auto bg-black/60 rounded-full w-7 h-7 text-sm">🐞</button>
      )}

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
