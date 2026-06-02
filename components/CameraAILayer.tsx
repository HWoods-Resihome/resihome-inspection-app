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
import type { RateCardLineInput, RateCardLineItem, RegionRate } from '@/lib/types';
import { VENDORS } from '@/lib/vendors';
import { calculateLine, roundMoney } from '@/lib/rateCardMath';
import { ListPicker } from '@/components/ListPicker';
import { WheelPicker } from '@/components/WheelPicker';

const TENANT_PCT_OPTIONS = Array.from({ length: 21 }, (_, i) => i * 5); // 0..100 step 5

const INFER_INTERVAL_MS = 2500;
const KEYFRAME_EDGE = 640;
const AUDIO_CHUNK_MS = 2800; // shorter clips = transcript + card sooner (rolling context stitches splits)
const MAX_ROOM_STILLS = 12;
// Auto-still is now a FALLBACK: it only fires when the inspector has gone idle
// (no manual shutter, no AI still, no chip) for this long — so supplemental
// photos fill gaps instead of firing every few seconds.
const AUTO_IDLE_MS = 15000;
const AUTO_CHECK_MS = 3500;
const DEBUG_DEFAULT = false; // on-device pipeline HUD (mic → Whisper → vision) — off; flip to re-enable
const AUTO_PHOTO = false;    // auto room-still capture (idle fallback + per-call-out) — off; flip to re-enable
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

interface ChipEdit { qty: string; vendor: string; tenantPct: string; vendorCost: string }
const EMPTY_EDIT: ChipEdit = { qty: '', vendor: 'Vendor 1', tenantPct: '100', vendorCost: '' };
function seedEdit(s: LiveSuggestion): ChipEdit {
  return {
    qty: s.needsMeasurement
      ? (s.estimatedQuantity && s.estimatedQuantity > 0 ? String(s.estimatedQuantity) : '')
      : String(s.quantity ?? 1),
    vendor: s.suggestedVendor || 'Vendor 1',
    tenantPct: String(s.tenantBillBackPercent ?? 100),
    vendorCost: '',
  };
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
  // Catalog + region rates so the card can compute live vendor cost (qty-aware).
  catalog: RateCardLineItem[];
  regions: RegionRate[];
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
  const { enabled, videoRef, getStream, getLastManualCaptureAt, getActiveRoom, rooms, onNavigateRoom, region, catalog, regions, tenantMonths, addressSnapshot, propertyRecordId, uploadPhoto, onAddLine, onStill, onStatus } = props;

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
  // Recently-sent speech (last ~8s) prepended as CONTEXT to the next voice tick,
  // so a phrase chopped across 4s clips ("the blinds need to" + "be replaced")
  // is seen complete by the model.
  const recentCtxRef = useRef<{ t: number; text: string }[]>([]);
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
  // "Working" lingers ~1.4s past the last transcribe/inference so the status
  // doesn't flicker back to "Listening" in the gaps between clips — it reads as
  // one continuous "Processing…" until the work actually settles.
  const [working, setWorking] = useState(false);
  const workTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [heardText, setHeardText] = useState('');
  const [errText, setErrText] = useState('');
  const [chips, setChips] = useState<LiveSuggestion[]>([]);
  // Per-chip editable values (qty / vendor / tenant% / vendor $) — the inspector
  // can tweak these on the card OR by voice BEFORE adding. Seeded from the
  // suggestion; voice edit_line and the inline controls both write here.
  const [editById, setEditById] = useState<Record<string, ChipEdit>>({});
  const setEdit = (id: string, patch: Partial<ChipEdit>) => setEditById((m) => ({ ...m, [id]: { ...(m[id] || EMPTY_EDIT), ...patch } }));
  // Which inline field is currently open for editing (tap-to-edit, like the form).
  const [editing, setEditing] = useState<{ id: string; field: keyof ChipEdit } | null>(null);
  // Draft text while a qty / vendor$ input is open — committed on Done/Enter (qty
  // also commits on blur; vendor$ reverts on blur so a stray tap-out keeps the
  // formula value).
  const [draft, setDraft] = useState('');
  const openEdit = (id: string, field: keyof ChipEdit, current: string) => { setDraft(current); setEditing({ id, field }); };
  const money2 = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // Capture animation: a shutter flash + a "saved" thumbnail toast so the
  // inspector sees the AI grabbing room photos and doesn't re-shoot them.
  const [flashKey, setFlashKey] = useState(0);
  const [savedShot, setSavedShot] = useState<{ key: number; url: string; roomName: string; count: number } | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Quick "Added ✓" confirmation that pops then fizzles out on Add.
  const [addedFx, setAddedFx] = useState<{ key: number; label: string } | null>(null);
  const addedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { chipsRef.current = chips; }, [chips]);

  // Hold "working" true while transcribing/scanning, and for a short linger after,
  // so brief gaps between clips don't bounce the status back to "Listening".
  useEffect(() => {
    if (scanning || transcribing) {
      if (workTimer.current) { clearTimeout(workTimer.current); workTimer.current = null; }
      setWorking(true);
    } else {
      if (workTimer.current) clearTimeout(workTimer.current);
      workTimer.current = setTimeout(() => { setWorking(false); workTimer.current = null; }, 1400);
    }
  }, [scanning, transcribing]);

  // Derive a single status line + tone and report it up to the host camera,
  // which renders it in its black header strip (not floating over the image).
  useEffect(() => {
    if (!enabled) return;
    let text: string; let tone: 'idle' | 'listen' | 'heard' | 'think' | 'err';
    // Single forward flow that only moves forward: Listening → Processing →
    // (output card / message). "working" lingers so it never flickers backward.
    if (errText) { text = errText; tone = 'err'; }
    else if (working) { text = 'Processing…'; tone = 'think'; }
    else if (heardText) { text = heardText; tone = 'heard'; }
    else if (listening) { text = 'Listening — say what you see'; tone = 'listen'; }
    else { text = 'Starting mic…'; tone = 'idle'; }
    onStatus?.({ text, tone });
  }, [enabled, errText, working, heardText, listening, onStatus]);

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
      // Auto-still FALLBACK (disabled while AUTO_PHOTO is off): only when idle.
      if (AUTO_PHOTO) stillTimer.current = setInterval(() => { void maybeAutoStill(); }, AUTO_CHECK_MS);
    })();
    return () => {
      openRef.current = false;
      if (inferTimer.current) clearInterval(inferTimer.current);
      if (stillTimer.current) clearInterval(stillTimer.current);
      if (savedTimer.current) clearTimeout(savedTimer.current);
      if (addedTimer.current) clearTimeout(addedTimer.current);
      if (workTimer.current) clearTimeout(workTimer.current);
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
        transcriptBufRef.current = '';
        recentCtxRef.current = [];
        navRecentRef.current = [];
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
    'pdf', 'pdf pdf', 'pc', 'la la la', 'na na na', 'silence', 'background noise',
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
      // NB: we intentionally do NOT echo the raw transcript to the status line —
      // flipping between the quote and "Processing" read like an error. The card
      // is the confirmation. heardText is reserved for nav / no-match messages.
      // Try room navigation against a short rolling window (commands split across
      // clips). If it navigates, treat the window as consumed and DON'T feed it to
      // the work endpoint (otherwise "move to the kitchen" becomes a bogus line).
      const now = Date.now();
      navRecentRef.current = [...navRecentRef.current.filter((e) => now - e.t < 8000), { t: now, text: txt }];
      const navWindow = navRecentRef.current.map((e) => e.text).join(' ');
      if (maybeNavigate(navWindow)) { navRecentRef.current = []; return; }
      transcriptBufRef.current += txt + ' ';
      // Fire inference immediately so the card appears right after you speak,
      // instead of waiting for the next fixed tick. (Guarded by inFlight.)
      if (!inFlight.current && openRef.current) void runInference();
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
    const newText = transcriptBufRef.current.trim();
    const hasNewVoice = newText.length > 0;
    const b64 = grabKeyframeB64(KEYFRAME_EDGE);
    // Voice goes text-only, so a missing frame only blocks SILENT ticks. If the
    // inspector spoke, proceed even without a usable frame (camera covered/booting).
    if (!hasNewVoice && !b64) { setErrText('Camera not ready'); return; }
    // Prepend recent context so a phrase split across clips reads complete; only
    // include context when there's NEW speech (silent ticks send no transcript).
    const now = Date.now();
    recentCtxRef.current = recentCtxRef.current.filter((e) => now - e.t < 8000);
    const ctx = recentCtxRef.current.map((e) => e.text).join(' ');
    const delta = hasNewVoice ? (ctx + ' ' + newText).trim() : '';
    transcriptBufRef.current = '';
    // On failure, put the new words back (don't commit to context); on success,
    // commit them to context for the next tick.
    const rebufferOnFail = () => { if (hasNewVoice) transcriptBufRef.current = (newText + ' ' + transcriptBufRef.current).trimStart(); };
    const commitContext = () => { if (hasNewVoice) recentCtxRef.current.push({ t: Date.now(), text: newText }); };
    inFlight.current = true;
    // Only surface "Processing…" for VOICE-driven work — silent background vision
    // ticks shouldn't keep the header stuck on Processing after a line is added.
    if (hasNewVoice) setScanning(true);
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
      commitContext();
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
          return nc;
        }));
        // Voice amendments write into the same editById the card binds to.
        setEditById((m) => {
          const n = { ...m };
          for (const e of editList) {
            const cur = n[e.targetId] || EMPTY_EDIT;
            const patch: ChipEdit = { ...cur };
            if (e.vendor) patch.vendor = e.vendor;
            if (typeof e.tenantBillBackPercent === 'number') patch.tenantPct = String(e.tenantBillBackPercent);
            if (typeof e.quantity === 'number') patch.qty = String(e.quantity);
            n[e.targetId] = patch;
          }
          return n;
        });
        const ed = editList[0];
        dbg(`edit ${ed.vendor ? `vendor=${ed.vendor}` : ''}${typeof ed.quantity === 'number' ? ` qty=${ed.quantity}` : ''}${typeof ed.tenantBillBackPercent === 'number' ? ` tenant=${ed.tenantBillBackPercent}` : ''}`.trim());
      }

      const incoming: LiveSuggestion[] = Array.isArray(d.suggestions) ? d.suggestions : [];
      const fresh = incoming.filter((s) => s.lineItemCode && !seen.codes.has(s.lineItemCode));
      if (fresh.length) {
        const batchStill = AUTO_PHOTO ? await captureStill(true, 'call-out') : undefined;
        const seeds: Record<string, ChipEdit> = {};
        for (const s of fresh) {
          seen.codes.add(s.lineItemCode);
          seen.descs.add(s.description);
          s.roomId = room.id;
          s.stillUrl = batchStill;
          seeds[s.id] = seedEdit(s);
        }
        setEditById((m) => ({ ...m, ...seeds }));
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
      // If the inspector kept talking while this call was in flight, process the
      // buffered words right away instead of waiting for the next tick.
      if (openRef.current && transcriptBufRef.current.trim()) setTimeout(() => { if (!inFlight.current) void runInference(); }, 40);
    }
  }

  // ---- chip actions ----
  function editOf(s: LiveSuggestion): ChipEdit { return editById[s.id] || seedEdit(s); }
  function addChip(s: LiveSuggestion) {
    const e = editOf(s);
    let qty: number;
    if (s.needsMeasurement) { const v = Number(e.qty); if (!isFinite(v) || v <= 0) return; qty = v; }
    else { const v = Number(e.qty); qty = isFinite(v) && v > 0 ? v : (s.quantity ?? 1); }
    const tenant = Math.max(0, Math.min(100, Math.round(Number(e.tenantPct))));
    const vCost = Number(e.vendorCost);
    const line: RateCardLineInput = {
      externalId: genId(), section: '', location: '',
      lineItemCode: s.lineItemCode, quantity: qty,
      tenantBillBackPercent: isFinite(tenant) ? tenant : (s.tenantBillBackPercent ?? 100),
      assignedTo: e.vendor || s.suggestedVendor || 'Vendor 1',
      note: '', customLaborRate: null, customAdjustedMaterialCost: null,
      customVendorCost: (isFinite(vCost) && e.vendorCost.trim() !== '') ? vCost : null,
      photoUrls: s.stillUrl ? [s.stillUrl] : [],
    };
    onAddLineRef.current(s.roomId, line);
    dbg(`✚ added ${s.lineItemCode} q${qty} ${line.assignedTo}`);
    // Quick visual confirmation that fizzles out.
    setAddedFx({ key: Date.now(), label: s.description });
    if (addedTimer.current) clearTimeout(addedTimer.current);
    addedTimer.current = setTimeout(() => setAddedFx(null), 1150);
    setChips((cur) => cur.filter((c) => c.id !== s.id));
  }
  function dismissChip(s: LiveSuggestion) {
    setChips((cur) => cur.filter((c) => c.id !== s.id));
  }

  // Live vendor cost from the rate-card math — updates with qty / tenant% /
  // override, identical to the manual line card's formula.
  function vendorCostFor(s: LiveSuggestion, e: ChipEdit): number | null {
    const item = catalog.find((c) => c.lineItemCode === s.lineItemCode);
    if (!item) return null;
    const qty = Number(e.qty);
    if (!isFinite(qty) || qty <= 0) return null;
    try {
      const calc = calculateLine(item, region, regions, {
        quantity: qty,
        tenantBillBackPercent: Number(e.tenantPct) || 100,
        customLaborRate: null,
        customAdjustedMaterialCost: null,
        customVendorCost: e.vendorCost.trim() === '' ? null : Number(e.vendorCost),
      });
      return roundMoney(calc.vendorCost);
    } catch { return null; }
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

      {/* "Added ✓" confirmation — pops in the center then fizzles out. */}
      {addedFx && (
        <div key={addedFx.key} className="fixed left-1/2 top-[42%] z-[60] pointer-events-none animate-addedPop">
          <div className="flex items-center gap-2 bg-emerald-600 text-white rounded-full px-5 py-2.5 shadow-xl">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
            <span className="text-sm font-heading font-bold">Added</span>
            <span className="text-sm text-white/85 max-w-[180px] truncate">{addedFx.label}</span>
          </div>
        </div>
      )}

      {/* On-device debug HUD (mic → Whisper → vision). Hidden unless DEBUG_DEFAULT
          is flipped on; dbg() still logs to the console either way. */}
      {dbgOn && (
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
      )}
      {DEBUG_DEFAULT && !dbgOn && (
        <button onClick={() => setDbgOn(true)} className="absolute left-2 top-[140px] z-40 pointer-events-auto bg-black/60 rounded-full w-7 h-7 text-sm">🐞</button>
      )}

      {/* Chip tray — floats above the camera controls. Each card has inline
          qty / vendor / tenant% / vendor$ controls so the inspector (or voice)
          can adjust BEFORE adding. */}
      <div className="pointer-events-none absolute left-0 right-0 bottom-28 px-3 space-y-2 max-h-[52vh] overflow-y-auto">
        {visibleChips.map((s) => {
          const e = editOf(s);
          const addDisabled = s.needsMeasurement && !(Number(e.qty) > 0);
          const item = catalog.find((c) => c.lineItemCode === s.lineItemCode);
          const subtext = (item?.laborSubtext || item?.laborFullDescription || '').trim();
          const unitAbbr = s.measurementUnit ? s.unit : ''; // SF / LF / SY (compact)
          return (
          <div key={s.id} className="pointer-events-auto bg-white rounded-xl p-3 shadow-xl ring-1 ring-black/5">
            <div className="flex items-start gap-2">
              {s.stillUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={displayImageSrc(s.stillUrl)} alt="" className="w-11 h-11 object-cover rounded border border-gray-200 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${confColor(s.confidence)}`} />
                  <span className="text-sm font-semibold text-ink leading-tight">{s.description}</span>
                </div>
                <div className="text-[11px] text-gray-600">{s.category}{s.subcategory ? ` · ${s.subcategory}` : ''}</div>
                {subtext && (
                  <div className="text-[11px] text-gray-600 mt-0.5" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{subtext}</div>
                )}
              </div>
            </div>

            {/* Editable fields — one row. Qty + Vendor $ are tap-to-edit text;
                Vendor + Tenant % use the branded ListPicker / WheelPicker (same
                as the manual line card). Vendor $ shows the live formula cost. */}
            {(() => { const vc = vendorCostFor(s, e); const vcFormula = vendorCostFor(s, { ...e, vendorCost: '' }); const overridden = e.vendorCost.trim() !== ''; return (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[12px]">
              {/* Qty — tap to edit; full value pre-selected; Done/Enter or blur keeps it. */}
              {editing && editing.id === s.id && editing.field === 'qty' ? (
                <input autoFocus type="text" inputMode="decimal" enterKeyHint="done" value={draft}
                  onFocus={(ev) => ev.currentTarget.select()}
                  onChange={(ev) => setDraft(ev.target.value.replace(/[^0-9.]/g, ''))}
                  onBlur={() => { setEdit(s.id, { qty: draft }); setEditing(null); }}
                  onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); setEdit(s.id, { qty: draft }); setEditing(null); } else if (ev.key === 'Escape') { setEditing(null); } }}
                  className="h-7 w-16 bg-gray-100 rounded-lg px-2 text-[12px] outline-none ring-2 ring-brand/40" />
              ) : (
                <button onClick={() => openEdit(s.id, 'qty', e.qty)} className="text-gray-500">
                  Qty <span className="text-gray-900 font-semibold">{e.qty || (s.needsMeasurement ? '—' : '1')}</span>{unitAbbr ? ` ${unitAbbr}` : ''}
                </button>
              )}
              <span className="text-gray-300">·</span>
              {/* Vendor — branded ListPicker */}
              <ListPicker value={e.vendor} options={VENDORS.map((v) => ({ value: v, label: v }))}
                onChange={(v) => setEdit(s.id, { vendor: v })} ariaLabel="Vendor" large
                className="inline-flex items-center gap-0.5 text-gray-900 font-semibold max-w-[150px]" />
              <span className="text-gray-300">·</span>
              {/* Tenant % — branded WheelPicker */}
              <span className="inline-flex items-center text-gray-500">Tenant&nbsp;
                <WheelPicker value={e.tenantPct || '100'} options={TENANT_PCT_OPTIONS.map((p) => ({ value: String(p), label: `${p}%` }))}
                  onChange={(v) => setEdit(s.id, { tenantPct: v })} ariaLabel="Tenant %" large
                  className="inline-flex items-center gap-0.5 text-gray-900 font-semibold" />
              </span>
              <span className="text-gray-300">·</span>
              {/* Vendor $ — live formula cost; tap to override. Done/Enter keeps the
                  override; tapping out (blur) reverts to the formula value. */}
              {editing && editing.id === s.id && editing.field === 'vendorCost' ? (
                <input autoFocus type="text" inputMode="decimal" enterKeyHint="done" value={draft}
                  onFocus={(ev) => ev.currentTarget.select()}
                  onChange={(ev) => setDraft(ev.target.value.replace(/[^0-9.]/g, ''))}
                  onBlur={() => setEditing(null)} /* revert: don't commit on tap-out */
                  onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); setEdit(s.id, { vendorCost: draft }); setEditing(null); } else if (ev.key === 'Escape') { setEditing(null); } }}
                  placeholder={vcFormula != null ? money2(vcFormula) : 'auto'}
                  className="h-7 w-24 bg-gray-100 rounded-lg px-2 text-[12px] outline-none ring-2 ring-brand/40" />
              ) : (
                <button onClick={() => openEdit(s.id, 'vendorCost', e.vendorCost)} className="text-gray-500">
                  Vendor $ <span className="text-gray-900 font-semibold">{vc != null ? `$${money2(vc)}` : '—'}</span>
                  {overridden && <span className="text-brand"> ✎</span>}
                </button>
              )}
            </div>
            ); })()}
            {s.needsMeasurement && s.estimatedQuantity && s.estimatedQuantity > 0 && (
              <div className="text-[11px] text-amber-700 mt-1">≈ AI estimate ({s.estimatedQuantity} {s.unit}) — confirm, edit, or say the size.</div>
            )}

            <div className="flex gap-2 mt-2">
              <button onClick={() => addChip(s)} disabled={addDisabled}
                className="flex-1 h-9 rounded-lg bg-emerald-600 text-white font-heading font-semibold text-sm hover:bg-emerald-700 disabled:bg-gray-300 disabled:cursor-not-allowed">Add</button>
              <button onClick={() => dismissChip(s)}
                className="px-4 h-9 rounded-lg border border-gray-300 text-gray-700 font-heading font-semibold text-sm bg-white hover:bg-gray-50">✕</button>
            </div>
          </div>
          );
        })}
      </div>
    </div>
  );
}
