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
import { VENDORS, defaultVendorForCode } from '@/lib/vendors';
import { calculateLine, roundMoney } from '@/lib/rateCardMath';
import { ListPicker } from '@/components/ListPicker';
import { WheelPicker } from '@/components/WheelPicker';
import { EditableLineRow } from '@/components/EditableLineRow';
import { formatQty } from '@/lib/photoUpload';

const TENANT_PCT_OPTIONS = Array.from({ length: 21 }, (_, i) => i * 5); // 0..100 step 5

const INFER_INTERVAL_MS = 2500;
const KEYFRAME_EDGE = 640;
const AUDIO_CHUNK_MS = 2800; // fallback fixed-clip length when VAD is unavailable (iOS suspended ctx)
// Voice-activity endpointing: cut the utterance once the inspector has been quiet
// for SILENCE_HANG_MS (a short buffer so mini "umm…" pauses don't split a phrase),
// with a hard safety cap and an idle-restart to drop silent buffers.
const SILENCE_HANG_MS = 600;
const MAX_UTTER_MS = 9000;
const IDLE_RESTART_MS = 5000;
const MAX_ROOM_STILLS = 12;
// Dead-zone resilience: voice clips that can't reach Whisper while offline are
// banked and retried on reconnect (bounded so a long outage can't blow up memory).
const MAX_PENDING_CLIPS = 8;
// Auto-still is now a FALLBACK: it only fires when the inspector has gone idle
// (no manual shutter, no AI still, no chip) for this long — so supplemental
// photos fill gaps instead of firing every few seconds.
const AUTO_IDLE_MS = 15000;
const AUTO_CHECK_MS = 3500;
const DEBUG_DEFAULT = false; // on-device pipeline HUD (mic → Whisper → vision) — off in production
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
    // Per-code default vendor (eviction codes / flooring) wins over the AI's
    // suggestion and the generic default; still editable on the chip.
    vendor: defaultVendorForCode(s.lineItemCode) || s.suggestedVendor || 'Vendor 1',
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
  // Live digital-zoom factor of the shared camera (1 = none). Captures crop to it
  // so AI stills/frames match the pinch-zoomed preview.
  getZoom?: () => number;
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
  const { enabled, videoRef, getStream, getZoom, getLastManualCaptureAt, getActiveRoom, rooms, onNavigateRoom, region, catalog, regions, tenantMonths, addressSnapshot, propertyRecordId, uploadPhoto, onAddLine, onStill, onStatus } = props;
  // Center-crop the current video frame into ctx by the live digital-zoom factor,
  // so AI frames + saved stills match the pinch-zoomed preview.
  const drawZoomedFrame = (ctx: CanvasRenderingContext2D, v: HTMLVideoElement, dw: number, dh: number) => {
    const z = getZoom ? getZoom() : 1;
    if (z > 1.001) {
      const sw = v.videoWidth / z, sh = v.videoHeight / z;
      ctx.drawImage(v, (v.videoWidth - sw) / 2, (v.videoHeight - sh) / 2, sw, sh, 0, 0, dw, dh);
    } else {
      ctx.drawImage(v, 0, 0, dw, dh);
    }
  };

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
    drainRef.current = drainPendingClips; // keep the reconnect drainer current (no stale closure)
  });

  // When service returns, finish out any voice call-outs banked during a dead
  // zone. Wired once; calls drainRef so it always runs the latest drainer.
  useEffect(() => {
    const onOnline = () => { drainRef.current(); };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, []);

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
  const monitorRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Dead-zone resilience: voice clips banked while offline + a guard so only one
  // drain runs at a time. drainRef always points at the latest drain fn so the
  // window 'online' listener (wired once) never calls a stale closure.
  const pendingClipsRef = useRef<Blob[]>([]);
  const drainingClipsRef = useRef(false);
  const drainRef = useRef<() => void>(() => {});
  const [pendingClips, setPendingClips] = useState(0);

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
  // In-flight call-out still uploads, keyed by chip id. The chip renders the
  // instant the AI calls something out; the photo uploads in the BACKGROUND and
  // its URL is patched on when ready. Add awaits this so the photo is never lost
  // even if the inspector taps Add before the upload finishes.
  const stillUploadRef = useRef<Record<string, Promise<string | undefined>>>({});
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
    setDbgLines((p) => [...p.slice(-5), line]); // keep the last ~6 so the HUD stays short
  }

  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [scanning, setScanning] = useState(false);
  // Landscape: confine the call-out cards to the camera viewport (bottom-left)
  // so they don't overlay the photo column + control rail on the right.
  const [isLandscape, setIsLandscape] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(orientation: landscape)');
    const apply = () => setIsLandscape(mq.matches);
    apply();
    mq.addEventListener?.('change', apply);
    window.addEventListener('resize', apply);
    return () => { mq.removeEventListener?.('change', apply); window.removeEventListener('resize', apply); };
  }, []);

  // EXACT placement: measure the live-preview element's box so the call-out
  // cards span precisely the camera section and stop exactly where the photo
  // column / control rail begin — no estimated offsets. The video fills the
  // viewport (absolute inset-0), so its rect IS the camera section. A
  // ResizeObserver re-measures whenever the layout shifts (photo column appears,
  // rotation, rail resize), and we convert to screen-edge insets the fixed
  // overlay can position against.
  const [vpInsets, setVpInsets] = useState<{ left: number; width: number; bottom: number; height: number } | null>(null);
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    const measure = () => {
      const el = videoRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      setVpInsets({ left: r.left, width: r.width, bottom: window.innerHeight - r.bottom, height: r.height });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    const t1 = setTimeout(measure, 250);
    const t2 = setTimeout(measure, 700);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && videoRef.current) {
      ro = new ResizeObserver(measure);
      ro.observe(videoRef.current);
    }
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
      clearTimeout(t1); clearTimeout(t2);
      ro?.disconnect();
    };
  }, [enabled, videoRef]);
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
  // Tapped a call-out's photo to validate it full-screen.
  const [zoomUrl, setZoomUrl] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Quick "Added ✓" confirmation that pops then fizzles out on Add.
  const [addedFx, setAddedFx] = useState<{ key: number; label: string } | null>(null);
  const addedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // When set, the full "Add Line Item" editor (the SAME one as the manual rate-
  // card form) is open, seeded from a tapped suggestion. The inspector can tweak
  // any field — category / sub / item / qty / vendor / tenant % / vendor $ — then
  // Save Line to add it to the chip's room, exactly like the inline Add.
  const [editorState, setEditorState] = useState<{ chip: LiveSuggestion; line: RateCardLineInput } | null>(null);

  useEffect(() => { chipsRef.current = chips; }, [chips]);

  // Hold "working" true while transcribing/scanning, and for a short linger after,
  // so brief gaps between an utterance, its transcription, and inference don't
  // bounce the status back to "Listening".
  useEffect(() => {
    if (scanning || transcribing) {
      if (workTimer.current) { clearTimeout(workTimer.current); workTimer.current = null; }
      setWorking(true);
    } else {
      if (workTimer.current) clearTimeout(workTimer.current);
      workTimer.current = setTimeout(() => { setWorking(false); workTimer.current = null; }, 1800);
    }
  }, [scanning, transcribing]);

  // Transient messages (nav confirmation, no-match hint) shouldn't stick in the
  // header — auto-clear so the status falls back to Listening.
  useEffect(() => {
    if (!heardText) return;
    const t = setTimeout(() => setHeardText(''), 3000);
    return () => clearTimeout(t);
  }, [heardText]);

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
  // Send ONE clip to Whisper → transcript. Throws on a network / transient (5xx,
  // 429) failure so the caller can bank + retry; a 4xx is permanent (swallowed).
  async function sendClipForText(blob: Blob): Promise<string> {
    const base64 = await blobToBase64(blob);
    const r = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base64, mime: (blob.type || 'audio/mp4').split(';')[0] }) });
    if (!r.ok) {
      if (r.status >= 500 || r.status === 429) throw new Error(`stt ${r.status}`); // transient → retry
      const e = await r.json().catch(() => ({}));
      dbg(`stt ✗ ${r.status} ${String(e?.error || '').slice(0, 40)}`);
      setErrText(`Voice ${r.status}: ${String(e?.error || '').slice(0, 50)}`);
      return '';
    }
    const d = await r.json();
    return String(d.text || '').trim();
  }

  // Route a transcript: a room-nav command, or a work call-out (buffer + infer).
  function handleTranscript(txt: string) {
    if (!txt) { dbg('stt: (empty)'); return; }
    if (isNoise(txt)) { dbg(`stt: noise “${txt.slice(0, 24)}”`); return; }
    dbg(`stt ✓ “${txt.slice(0, 32)}”`);
    setErrText('');
    // Try room navigation against a short rolling window (commands split across
    // clips). If it navigates, treat the window as consumed and DON'T feed it to
    // the work endpoint (otherwise "move to the kitchen" becomes a bogus line).
    const now = Date.now();
    navRecentRef.current = [...navRecentRef.current.filter((e) => now - e.t < 8000), { t: now, text: txt }];
    const navWindow = navRecentRef.current.map((e) => e.text).join(' ');
    if (maybeNavigate(navWindow)) { navRecentRef.current = []; return; }
    transcriptBufRef.current += txt + ' ';
    // Fire inference immediately so the card appears right after you speak.
    if (!inFlight.current && openRef.current) void runInference();
  }

  // Bank a clip we couldn't send (offline / transient) for retry on reconnect.
  function enqueueClip(blob: Blob) {
    const q = pendingClipsRef.current;
    q.push(blob);
    while (q.length > MAX_PENDING_CLIPS) q.shift(); // bound memory over a long outage
    setPendingClips(q.length);
    setErrText(`Offline — ${q.length} voice call-out${q.length === 1 ? '' : 's'} saved, will finish when you're back online`);
  }

  // Drain banked clips in order once we're back online. Stops (keeping the queue)
  // the moment a send fails again, so nothing is lost across repeated dead zones.
  async function drainPendingClips() {
    if (drainingClipsRef.current) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (!pendingClipsRef.current.length) return;
    drainingClipsRef.current = true;
    try {
      while (pendingClipsRef.current.length && openRef.current && !(typeof navigator !== 'undefined' && navigator.onLine === false)) {
        const blob = pendingClipsRef.current[0];
        let txt = '';
        try { txt = await sendClipForText(blob); }
        catch { break; } // still unreachable — leave the queue for the next attempt
        pendingClipsRef.current.shift();
        setPendingClips(pendingClipsRef.current.length);
        handleTranscript(txt);
      }
      if (!pendingClipsRef.current.length) setErrText('');
    } finally { drainingClipsRef.current = false; }
  }

  async function transcribeChunk(blob: Blob) {
    // Known offline → bank immediately (don't even attempt the fetch).
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { enqueueClip(blob); return; }
    try {
      setTranscribing(true);
      const txt = await sendClipForText(blob);
      handleTranscript(txt);
    } catch (e: any) {
      // Network / transient failure (dead zone) → bank for retry on reconnect so
      // the call-out still "finishes out" instead of being lost.
      enqueueClip(blob);
      dbg(`stt queued ${String(e?.message || e).slice(0, 24)}`);
    } finally {
      setTranscribing(false);
      void drainPendingClips(); // opportunistic catch-up if service just returned
    }
  }

  // ---- voice room navigation ("go to kitchen", "walking into bedroom 1") ----
  function normalizeNav(s: string): string {
    return s.toLowerCase()
      .replace(/\bone\b/g, '1').replace(/\btwo\b/g, '2').replace(/\bthree\b/g, '3')
      .replace(/\bfour\b/g, '4').replace(/\bfive\b/g, '5').replace(/\bsix\b/g, '6')
      .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  // Words that mark an utterance as a WORK call-out, not a navigation command —
  // so "paint the kitchen wall" never gets mistaken for "go to Kitchen".
  const NAV_WORK_WORDS = new Set(['replace', 'paint', 'clean', 'repair', 'install', 'remove', 'fix', 'patch', 'trim', 'needs', 'need', 'broken', 'damaged', 'missing', 'stained', 'cracked', 'add', 'replacement', 'out', 'leaking', 'leak']);
  const NAV_STOPWORDS = new Set(['the', 'a', 'to', 'go', 'going', 'this', 'is', 'in', 'into', 'room', 'lets', 'let', 's', 'please', 'okay', 'ok', 'now', 'head', 'heading', 'over', 'back', 'move', 'moving', 'switch', 'um', 'uh', 'and', 'walk', 'walking', 'on']);
  function maybeNavigate(raw: string): boolean {
    const t = normalizeNav(raw);
    if (!t) return false;
    const list = roomsRef.current || [];
    if (list.length < 2) return false;
    const cur = getActiveRoomRef.current();
    const go = (id: string): boolean => {
      if (!id) return false;
      const r = list.find((x) => x.id === id);
      if (id === cur?.id) { dbg(`already in ${r?.name || id}`); return false; }
      navRef.current(id);
      if (r) { setHeardText(`→ ${r.name}`); dbg(`nav → ${r.name}`); }
      return true;
    };
    const roomTokens = (name: string) => normalizeNav(name).split(' ').filter((w) => w.length >= 2);

    // "next room" / "previous room" relative moves.
    if (/\bnext\s+room\b/.test(t)) {
      const i = list.findIndex((x) => x.id === cur?.id);
      if (i >= 0) return go(list[(i + 1) % list.length].id);
    }
    if (/\b(?:previous|prev|last)\s+room\b/.test(t)) {
      const i = list.findIndex((x) => x.id === cur?.id);
      if (i >= 0) return go(list[(i - 1 + list.length) % list.length].id);
    }

    // Cue-based: "go to / walk into / switch to / this is the … <room>".
    const cue = t.match(/(?:go(?:ing)?\s+(?:to|into|in)|walk(?:ing)?\s+(?:into|in|to)|head(?:ing)?\s+(?:to|into)|switch(?:ing)?\s+to|mov(?:e|ing)\s+(?:to|on\s+to)|over\s+to|now\s+(?:in|on)|let\s+s\s+(?:do|go\s+to)|back\s+to|this\s+is\s+(?:the\s+)?)/);
    if (cue && cue.index !== undefined) {
      const tail = t.slice(cue.index + cue[0].length).trim();
      if (tail) {
        let best: { id: string; score: number } | null = null;
        for (const r of list) {
          const tokens = roomTokens(r.name);
          if (!tokens.length) continue;
          let hit = 0;
          for (const tok of tokens) if (new RegExp(`\\b${tok}\\b`).test(tail)) hit++;
          const score = hit / tokens.length;
          if (hit > 0 && (!best || score > best.score)) best = { id: r.id, score };
        }
        if (best && best.score >= 0.5) return go(best.id);
      }
    }

    // Cue-less: the inspector just says a room name ("kitchen", "bedroom one").
    // Only when there's no work verb, and the spoken words are essentially a
    // room's name (so it can't swallow a call-out).
    const words = t.split(' ').filter(Boolean);
    if (!words.some((w) => NAV_WORK_WORDS.has(w))) {
      const core = words.filter((w) => !NAV_STOPWORDS.has(w));
      if (core.length >= 1 && core.length <= 3) {
        let best: { id: string; score: number } | null = null;
        for (const r of list) {
          const tokens = roomTokens(r.name);
          if (!tokens.length) continue;
          const allCoreInRoom = core.every((w) => tokens.includes(w));
          let hit = 0; for (const tok of tokens) if (core.includes(tok)) hit++;
          const score = hit / tokens.length;
          if (allCoreInRoom && score >= 0.5 && (!best || score > best.score)) best = { id: r.id, score };
        }
        if (best) return go(best.id);
        // Diagnostic: heard a short, room-like phrase but no room matched — show
        // the parsed words + the actual room names so we can see the mismatch.
        dbg(`no room: "${core.join(' ')}" | rooms: ${list.map((r) => r.name).join(', ').slice(0, 80)}`);
      }
    }
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

    // Persistent AudioContext for voice-activity detection (endpointing).
    const AC: any = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (AC && !audioCtxRef.current) { try { audioCtxRef.current = new AC(); } catch { /* noop */ } }
    try { if (audioCtxRef.current?.state === 'suspended') audioCtxRef.current.resume().catch(() => {}); } catch { /* noop */ }

    // Per-utterance mutable state (shared by beginUtterance / endUtterance / monitor).
    let analyser: AnalyserNode | null = null;
    let srcNode: MediaStreamAudioSourceNode | null = null;
    let parts: BlobPart[] = [];
    let hadSpeech = false;
    let pendingSend = true;
    let recStart = 0;
    let lastLoud = 0;
    const buf = new Uint8Array(512);
    const teardownNodes = () => { try { srcNode?.disconnect(); analyser?.disconnect(); } catch { /* noop */ } srcNode = null; analyser = null; };

    const beginUtterance = () => {
      if (!audioLoopRef.current || !openRef.current) return;
      const tracks = liveAudioTracks();
      if (!tracks.length) {
        // The audio source vanished — the camera's shared stream can get
        // reconfigured/stopped when the video track changes (zoom / lens), which
        // would otherwise leave the mic permanently deaf. RE-ACQUIRE our own mic
        // and resume instead of giving up. If re-acquire also fails, then stop.
        dbg('mic tracks lost — recovering');
        void (async () => {
          let ok = false;
          try {
            const own = await navigator.mediaDevices.getUserMedia({ audio: true });
            if (!openRef.current) { own.getTracks().forEach((t) => t.stop()); return; }
            ownAudioRef.current?.getTracks().forEach((t) => t.stop());
            ownAudioRef.current = own;
            ok = own.getAudioTracks().some((t) => t.readyState === 'live');
            dbg('mic re-acquired (own)');
          } catch { dbg('mic re-acquire failed'); }
          if (ok && audioLoopRef.current && openRef.current) {
            setListening(true);
            setTimeout(beginUtterance, 120);
          } else {
            setListening(false);
            setErrText('Mic blocked — allow microphone');
          }
        })();
        return;
      }
      try {
        const audioStream = new MediaStream(tracks);
        if (audioCtxRef.current) {
          try {
            srcNode = audioCtxRef.current.createMediaStreamSource(audioStream);
            analyser = audioCtxRef.current.createAnalyser(); analyser.fftSize = 512;
            srcNode.connect(analyser);
          } catch { analyser = null; srcNode = null; }
        }
        const rec = mime ? new MediaRecorder(audioStream, { mimeType: mime }) : new MediaRecorder(audioStream);
        audioRecRef.current = rec;
        parts = []; hadSpeech = false; pendingSend = true; recStart = Date.now(); lastLoud = Date.now();
        rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
        rec.onstop = () => {
          teardownNodes();
          if (pendingSend && hadSpeech && parts.length) {
            const blob = new Blob(parts, { type: rec.mimeType || mime || 'audio/mp4' });
            if (blob.size > 1200) { dbg(`utterance ${Math.round(blob.size / 1024)}KB`); void transcribeChunk(blob); }
          }
          if (audioLoopRef.current && openRef.current) beginUtterance();
        };
        rec.onerror = (ev: any) => dbg(`rec err ${String(ev?.error?.name || '')}`);
        rec.start();
      } catch (e: any) { dbg(`rec start err ${String(e?.message || e).slice(0, 24)}`); setListening(false); }
    };
    const endUtterance = (send: boolean) => {
      pendingSend = send;
      try { if (audioRecRef.current && audioRecRef.current.state !== 'inactive') audioRecRef.current.stop(); } catch { /* noop */ }
    };

    // Monitor: cut the utterance at end-of-speech (after a short pause buffer) so
    // a 2-word call-out fires fast while "umm… it's… 1200 sqft" stays one phrase.
    // Falls back to fixed-length clips when VAD (AudioContext) isn't running (iOS).
    monitorRef.current = setInterval(() => {
      if (!audioLoopRef.current || !openRef.current) return;
      const rec = audioRecRef.current;
      if (!rec || rec.state === 'inactive') return;
      const now = Date.now();
      const dur = now - recStart;
      const vadActive = audioCtxRef.current?.state === 'running' && !!analyser;
      if (vadActive && analyser) {
        analyser.getByteTimeDomainData(buf);
        let m = 0; for (let i = 0; i < buf.length; i++) { const d = Math.abs(buf[i] - 128); if (d > m) m = d; }
        if (m >= VAD_PEAK_MIN) { lastLoud = now; hadSpeech = true; }
        const sinceLoud = now - lastLoud;
        if (hadSpeech && sinceLoud >= SILENCE_HANG_MS) endUtterance(true);   // end after the pause buffer
        else if (!hadSpeech && dur >= IDLE_RESTART_MS) endUtterance(false);  // drop a silence-only buffer
        else if (dur >= MAX_UTTER_MS) endUtterance(true);                    // safety cap
      } else if (dur >= AUDIO_CHUNK_MS) {
        hadSpeech = true; endUtterance(true);                               // no VAD → fixed clips
      }
    }, 100);

    beginUtterance();
  }
  function stopAudioLoop() {
    audioLoopRef.current = false;
    setListening(false);
    if (monitorRef.current) { clearInterval(monitorRef.current); monitorRef.current = null; }
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
    drawZoomedFrame(ctx, v, w, h);
    return c.toDataURL('image/jpeg', 0.6).split(',')[1] || null;
  }
  // addToRoom=false → capture a still ONLY for a call-out card (uploaded, tags
  // to the line on Add) WITHOUT adding it to the room's section photos, bumping
  // the room count, flashing the shutter, or popping the saved toast. Used for
  // per-call-out evidence so call-outs don't flood the room's section photos.
  async function captureStill(force: boolean, reason = 'still', addToRoom = true): Promise<string | undefined> {
    const v = videoRef.current;
    const room = getActiveRoomRef.current();
    if (!openRef.current || !v || !v.videoWidth || !room) return undefined;
    if (addToRoom && !force && (roomStillCountRef.current[room.id] || 0) >= MAX_ROOM_STILLS) return undefined;
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
    const ctx = c.getContext('2d'); if (!ctx) return undefined;
    drawZoomedFrame(ctx, v, c.width, c.height);
    drawEvidenceStamp(ctx, c.width, c.height, stampLinesRef.current);
    if (addToRoom) {
      // Fire the shutter flash the instant we grab the frame — immediate feedback.
      setFlashKey((k) => k + 1);
      lastAiStillAtRef.current = Date.now(); // counts as activity → throttles fallback
    }
    const blob = await new Promise<Blob | null>((res) => c.toBlob((b) => res(b), 'image/jpeg', 0.8));
    if (!blob) return undefined;
    try {
      const url = await uploadPhotoRef.current(new File([blob], `ai_${Date.now()}.jpg`, { type: 'image/jpeg' }));
      if (!openRef.current) return undefined;
      if (!addToRoom) { dbg(`📸 ${reason} (card only)`); return url; }
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
    // Offline: don't burn the periodic vision tick on a fetch that will fail —
    // voice call-outs are banked as clips (transcribeChunk) and replayed on
    // reconnect, so nothing is lost. Try to drain anything already queued.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { void drainPendingClips(); return; }
    const room = getActiveRoomRef.current();
    if (!room) { setErrText('No active room'); return; }
    const newText = transcriptBufRef.current.trim();
    const hasNewVoice = newText.length > 0;
    // VOICE ticks run TEXT-ONLY on the server (the frame is ignored), so don't
    // pay to grab + base64-encode + upload a keyframe we won't use — that's
    // ~30-50KB and a canvas readback off the hot call-out path. Only grab the
    // frame on SILENT (vision) ticks.
    const b64 = hasNewVoice ? '' : grabKeyframeB64(KEYFRAME_EDGE);
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
          // Stream the response (SSE) so each call-out chip pops in the instant
          // the model finishes that item — like the home-screen mic — instead of
          // waiting for the whole batch.
          stream: true,
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
      setErrText('');

      // One supporting still per inference cycle, shared across its call-outs —
      // captured lazily on the FIRST suggestion so silent/no-op ticks cost nothing.
      let cycleStillP: Promise<string | undefined> | null = null;
      const ensureStill = () => (cycleStillP ??= captureStill(true, 'call-out', false));

      let nSugg = 0, nEdit = 0;
      const unmatchedList: string[] = [];

      // Add a single streamed suggestion as soon as it arrives.
      const applySuggestion = (s: LiveSuggestion) => {
        if (!s || !s.lineItemCode || seen.codes.has(s.lineItemCode)) return;
        seen.codes.add(s.lineItemCode);
        seen.descs.add(s.description);
        s.roomId = room.id;
        nSugg++;
        setEditById((m) => ({ ...m, [s.id]: seedEdit(s) }));
        setChips((cur) => [...cur, s]);
        // Attach the call-out still in the BACKGROUND; the chip is the deliverable.
        const p = ensureStill().then((url) => {
          if (url && openRef.current) {
            s.stillUrl = url;
            setChips((cur) => cur.map((c) => (c.id === s.id ? { ...c, stillUrl: url } : c)));
          }
          return url;
        });
        stillUploadRef.current[s.id] = p;
      };

      // Apply a single streamed voice edit to its pending chip.
      const applyEdit = (e: any) => {
        if (!e || !e.targetId) return;
        nEdit++;
        setChips((cur) => cur.map((c) => {
          if (e.targetId !== c.id) return c;
          const nc = { ...c };
          if (e.lineItemCode) { nc.lineItemCode = e.lineItemCode; nc.description = e.description || nc.description; nc.category = e.category || nc.category; nc.subcategory = e.subcategory ?? nc.subcategory; nc.unit = e.unit || nc.unit; nc.needsMeasurement = !!e.needsMeasurement; nc.measurementUnit = e.measurementUnit || ''; }
          return nc;
        }));
        setEditById((m) => {
          const cur = m[e.targetId] || EMPTY_EDIT;
          const patch: ChipEdit = { ...cur };
          if (e.vendor) patch.vendor = e.vendor;
          if (typeof e.tenantBillBackPercent === 'number') patch.tenantPct = String(e.tenantBillBackPercent);
          if (typeof e.quantity === 'number') patch.qty = String(e.quantity);
          return { ...m, [e.targetId]: patch };
        });
        dbg(`edit ${e.vendor ? `vendor=${e.vendor}` : ''}${typeof e.quantity === 'number' ? ` qty=${e.quantity}` : ''}${typeof e.tenantBillBackPercent === 'number' ? ` tenant=${e.tenantBillBackPercent}` : ''}`.trim());
      };

      // ---- read the SSE stream, dispatching events as they land ----
      const reader = r.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        let buffer = '';
        let evName = '';
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!openRef.current) { try { await reader.cancel(); } catch { /* noop */ } break; }
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).replace(/\r$/, '');
            buffer = buffer.slice(nl + 1);
            if (line.startsWith('event:')) { evName = line.slice(6).trim(); continue; }
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            let obj: any;
            try { obj = JSON.parse(payload); } catch { continue; }
            if (evName === 'suggestion') applySuggestion(obj as LiveSuggestion);
            else if (evName === 'edit') applyEdit(obj);
            else if (evName === 'unmatched') { if (obj?.query) unmatchedList.push(String(obj.query)); }
          }
        }
      } else {
        // Defensive fallback: no stream body (shouldn't happen) — parse as JSON.
        const d = await r.json().catch(() => ({}));
        for (const e of (Array.isArray(d.edits) ? d.edits : [])) applyEdit(e);
        for (const s of (Array.isArray(d.suggestions) ? d.suggestions : [])) applySuggestion(s);
        for (const u of (Array.isArray(d.unmatched) ? d.unmatched : [])) unmatchedList.push(String(u));
      }

      // Stream finished cleanly — commit this utterance to context for the next
      // tick and report the tally.
      commitContext();
      dbg(`vision ✓${delta ? ` +voice` : ''} sugg:${nSugg} edit:${nEdit} unmatch:${unmatchedList.length}`);

      // The model heard/saw something but it didn't map to a catalog item — tell
      // the inspector instead of silently dropping it.
      if (!nSugg && !nEdit && unmatchedList.length) {
        setHeardText(`No catalog match for “${unmatchedList[0]}” — try naming the work`);
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
  // The call-out still uploads in the background; if Add fires before it lands,
  // briefly await the in-flight upload so the photo is tagged to the line. Resolves
  // immediately once the URL is already on the suggestion (the common case).
  async function resolveStill(s: LiveSuggestion): Promise<string | undefined> {
    if (s.stillUrl) return s.stillUrl;
    const p = stillUploadRef.current[s.id];
    if (!p) return undefined;
    try { const url = await p; if (url) s.stillUrl = url; return url; } catch { return undefined; }
  }
  async function addChip(s: LiveSuggestion) {
    const e = editOf(s);
    let qty: number;
    if (s.needsMeasurement) { const v = Number(e.qty); if (!isFinite(v) || v <= 0) return; qty = v; }
    else { const v = Number(e.qty); qty = isFinite(v) && v > 0 ? v : (s.quantity ?? 1); }
    const tenant = Math.max(0, Math.min(100, Math.round(Number(e.tenantPct))));
    const vCost = Number(e.vendorCost);
    const still = await resolveStill(s);
    const line: RateCardLineInput = {
      externalId: genId(), section: '', location: '',
      lineItemCode: s.lineItemCode, quantity: qty,
      tenantBillBackPercent: isFinite(tenant) ? tenant : (s.tenantBillBackPercent ?? 100),
      assignedTo: e.vendor || s.suggestedVendor || 'Vendor 1',
      note: '', customLaborRate: null, customAdjustedMaterialCost: null,
      customVendorCost: (isFinite(vCost) && e.vendorCost.trim() !== '') ? vCost : null,
      photoUrls: still ? [still] : [],
    };
    onAddLineRef.current(s.roomId, line);
    dbg(`✚ added ${s.lineItemCode} q${qty} ${line.assignedTo}`);
    // Quick visual confirmation that fizzles out.
    setAddedFx({ key: Date.now(), label: s.description });
    if (addedTimer.current) clearTimeout(addedTimer.current);
    addedTimer.current = setTimeout(() => setAddedFx(null), 1150);
    setChips((cur) => cur.filter((c) => c.id !== s.id));
    delete stillUploadRef.current[s.id];
  }
  function dismissChip(s: LiveSuggestion) {
    setChips((cur) => cur.filter((c) => c.id !== s.id));
    delete stillUploadRef.current[s.id];
  }

  // Build the line a tapped suggestion seeds the full editor with — using the
  // chip's CURRENT edited values (qty / vendor / tenant % / vendor $) so anything
  // already tweaked on the card (or by voice) carries into the editor. Mirrors
  // addChip's line shape; section/location are left blank and stamped by the
  // parent's onAddLine (routes by roomId), same as the inline Add.
  function chipToSeedLine(s: LiveSuggestion): RateCardLineInput {
    const e = editOf(s);
    const qn = Number(e.qty);
    const qty = isFinite(qn) && qn > 0 ? qn : (s.quantity ?? 1);
    const tenant = Math.max(0, Math.min(100, Math.round(Number(e.tenantPct))));
    const vCost = Number(e.vendorCost);
    return {
      externalId: genId(), section: '', location: '',
      lineItemCode: s.lineItemCode, quantity: qty,
      tenantBillBackPercent: isFinite(tenant) ? tenant : (s.tenantBillBackPercent ?? 100),
      assignedTo: e.vendor || s.suggestedVendor || 'Vendor 1',
      note: '', customLaborRate: null, customAdjustedMaterialCost: null,
      customVendorCost: (isFinite(vCost) && e.vendorCost.trim() !== '') ? vCost : null,
      photoUrls: s.stillUrl ? [s.stillUrl] : [],
    };
  }
  // Tap a suggestion's title/subtext → open the full manual add-line editor,
  // seeded once (stable externalId) from the chip.
  function openFullEditor(s: LiveSuggestion) {
    setEditorState({ chip: s, line: chipToSeedLine(s) });
  }
  // Commit from the full editor: add to the chip's room, confirm, drop the chip.
  async function commitEditor(chip: LiveSuggestion, line: RateCardLineInput) {
    // The editor seeds its line at open time; if the call-out still hadn't
    // uploaded yet, attach it now so the photo isn't lost.
    if (!line.photoUrls || line.photoUrls.length === 0) {
      const still = await resolveStill(chip);
      if (still) line = { ...line, photoUrls: [still] };
    }
    onAddLineRef.current(chip.roomId, line);
    dbg(`✚ added (editor) ${line.lineItemCode} q${line.quantity} ${line.assignedTo}`);
    // Reflect the ACTUAL item added (the editor may have changed it), not the
    // original suggestion's text.
    const addedItem = catalog.find((c) => c.lineItemCode === line.lineItemCode);
    setAddedFx({ key: Date.now(), label: addedItem?.laborShortDescription || chip.description });
    if (addedTimer.current) clearTimeout(addedTimer.current);
    addedTimer.current = setTimeout(() => setAddedFx(null), 1150);
    setChips((cur) => cur.filter((c) => c.id !== chip.id));
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
      {/* Dead-zone indicator: voice call-outs banked offline, auto-finished on reconnect. */}
      {pendingClips > 0 && (
        <div className="fixed left-1/2 -translate-x-1/2 top-20 z-40 pointer-events-none">
          <div className="flex items-center gap-1.5 bg-amber-500/90 text-black rounded-full px-3 py-1 text-[11px] font-heading font-semibold shadow">
            <span className="w-1.5 h-1.5 rounded-full bg-black/70 animate-pulse" />
            {pendingClips} voice call-out{pendingClips === 1 ? '' : 's'} saved · finishing when back online
          </div>
        </div>
      )}
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
        <div className="absolute left-2 top-[84px] z-40 w-[190px] bg-black/78 rounded-lg p-2 text-[9px] leading-[1.35] text-emerald-200 font-mono pointer-events-auto shadow-lg">
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
        <button onClick={() => setDbgOn(true)} className="absolute left-2 top-[84px] z-40 pointer-events-auto bg-black/60 rounded-full w-7 h-7 text-sm">🐞</button>
      )}

      {/* Chip tray — floats above the camera controls. Each card has inline
          qty / vendor / tenant% / vendor$ controls so the inspector (or voice)
          can adjust BEFORE adding. */}
      <div
        className={`pointer-events-none absolute space-y-2 overflow-y-auto ${
          isLandscape
            // Landscape: exact viewport box (inline style below). Until the first
            // measurement lands, fall back to a safe inset for one frame.
            ? (vpInsets ? '' : 'left-2 right-[184px] bottom-2 max-h-[78vh]')
            // Portrait: full-width tray floating above the bottom control bar.
            : 'left-0 right-0 bottom-28 px-3 max-h-[52vh]'
        }`}
        style={isLandscape && vpInsets ? {
          left: Math.round(vpInsets.left) + 8,
          width: Math.max(160, Math.round(vpInsets.width) - 16),
          bottom: Math.max(0, Math.round(vpInsets.bottom)) + 8,
          maxHeight: Math.max(120, Math.round(vpInsets.height) - 16),
        } : undefined}
      >
        {visibleChips.map((s) => {
          const e = editOf(s);
          const addDisabled = s.needsMeasurement && !(Number(e.qty) > 0);
          const item = catalog.find((c) => c.lineItemCode === s.lineItemCode);
          const subtext = (item?.laborSubtext || item?.laborFullDescription || '').trim();
          const unitAbbr = s.measurementUnit ? s.unit : ''; // SF / LF / SY (compact)
          return (
          <div key={s.id} className="pointer-events-auto bg-white rounded-xl p-3 shadow-xl ring-1 ring-black/5">
            {/* Tap the title/subtext (not the controls below) to open the full
                manual add-line editor, seeded from this suggestion. */}
            <button
              type="button"
              onClick={() => openFullEditor(s)}
              aria-label={`Edit and add ${s.description} as a line item`}
              title="Tap to open the full add-line editor"
              className="flex items-start gap-2 w-full text-left -m-1 p-1 rounded-lg hover:bg-gray-50 active:bg-gray-100"
            >
              {s.stillUrl && (
                <button type="button" onClick={(e) => { e.stopPropagation(); setZoomUrl(s.stillUrl!); }} className="shrink-0" aria-label="View the photo for this call-out">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={displayImageSrc(s.stillUrl)} alt="" className="w-11 h-11 object-cover rounded border border-gray-200" />
                </button>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${confColor(s.confidence)}`} />
                  <span className="text-sm font-semibold text-ink leading-tight">{s.description}</span>
                  <span className="ml-auto shrink-0 inline-flex items-center gap-0.5 text-[10px] font-semibold text-brand/80">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                    Edit
                  </span>
                </div>
                {/* Indented to start under the title text (past the status dot). */}
                <div className="pl-4 text-[11px] text-gray-600">{s.category}{s.subcategory ? ` · ${s.subcategory}` : ''}</div>
                {subtext && (
                  <div className="pl-4 text-[11px] text-gray-600 mt-0.5" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{subtext}</div>
                )}
              </div>
            </button>

            {/* Editable fields — one row. Qty + Vendor $ are tap-to-edit text;
                Vendor + Tenant % use the branded ListPicker / WheelPicker (same
                as the manual line card). Vendor $ shows the live formula cost. */}
            {(() => { const vc = vendorCostFor(s, e); const vcFormula = vendorCostFor(s, { ...e, vendorCost: '' }); const overridden = e.vendorCost.trim() !== ''; return (
            <div className="mt-2 flex flex-nowrap items-center justify-between gap-x-1.5 text-[11px] whitespace-nowrap overflow-hidden">
              {/* Qty — tap to edit; full value pre-selected; Done/Enter or blur keeps it. */}
              {editing && editing.id === s.id && editing.field === 'qty' ? (
                <input autoFocus type="text" inputMode="decimal" enterKeyHint="done" value={draft}
                  onFocus={(ev) => ev.currentTarget.select()}
                  onChange={(ev) => setDraft(ev.target.value.replace(/[^0-9.]/g, ''))}
                  onBlur={() => { setEdit(s.id, { qty: draft }); setEditing(null); }}
                  onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); setEdit(s.id, { qty: draft }); setEditing(null); } else if (ev.key === 'Escape') { setEditing(null); } }}
                  className="h-7 w-14 bg-gray-100 rounded-lg px-2 text-[11px] outline-none ring-2 ring-brand/40 shrink-0" />
              ) : (
                <button onClick={() => openEdit(s.id, 'qty', e.qty)} className="text-gray-500 shrink-0">
                  Qty <span className="text-gray-900 font-semibold tabular-nums">{e.qty ? (formatQty(Number(e.qty)) || e.qty) : (s.needsMeasurement ? '—' : '1')}</span>{unitAbbr ? ` ${unitAbbr}` : ''}
                </button>
              )}
              {/* Vendor — branded ListPicker */}
              <ListPicker value={e.vendor} options={VENDORS.map((v) => ({ value: v, label: v }))}
                onChange={(v) => setEdit(s.id, { vendor: v })} ariaLabel="Vendor" large
                className="inline-flex items-center gap-0.5 text-gray-900 font-semibold max-w-[88px] shrink" />
              {/* Tenant % — branded WheelPicker */}
              <span className="inline-flex items-center text-gray-500 shrink-0">Tenant&nbsp;
                <WheelPicker value={e.tenantPct || '100'} options={TENANT_PCT_OPTIONS.map((p) => ({ value: String(p), label: `${p}%` }))}
                  onChange={(v) => setEdit(s.id, { tenantPct: v })} ariaLabel="Tenant %" large
                  className="inline-flex items-center gap-0.5 text-gray-900 font-semibold" />
              </span>
              {/* Vendor $ — live formula cost; tap to override. Done/Enter keeps the
                  override; tapping out (blur) reverts to the formula value. */}
              {editing && editing.id === s.id && editing.field === 'vendorCost' ? (
                <input autoFocus type="text" inputMode="decimal" enterKeyHint="done" value={draft}
                  onFocus={(ev) => ev.currentTarget.select()}
                  onChange={(ev) => setDraft(ev.target.value.replace(/[^0-9.]/g, ''))}
                  onBlur={() => setEditing(null)} /* revert: don't commit on tap-out */
                  onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); setEdit(s.id, { vendorCost: draft }); setEditing(null); } else if (ev.key === 'Escape') { setEditing(null); } }}
                  placeholder={vcFormula != null ? money2(vcFormula) : 'auto'}
                  className="h-7 w-20 bg-gray-100 rounded-lg px-2 text-[11px] outline-none ring-2 ring-brand/40 shrink-0" />
              ) : (
                <button onClick={() => openEdit(s.id, 'vendorCost', e.vendorCost)} className="text-gray-500 shrink-0">
                  Vendor <span className="text-gray-900 font-semibold">{vc != null ? `$${money2(vc)}` : '—'}</span>
                  {overridden && <span className="text-brand"> ✎</span>}
                </button>
              )}
            </div>
            ); })()}
            {s.needsMeasurement && s.estimatedQuantity && s.estimatedQuantity > 0 && (
              <div className="pl-4 text-[11px] text-amber-700 mt-1">≈ AI estimate ({formatQty(s.estimatedQuantity)} {s.unit}) — confirm, edit, or say the size.</div>
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

      {/* Tap a call-out's photo to validate it full-screen; tap anywhere to close. */}
      {zoomUrl && (
        <div className="pointer-events-auto fixed inset-0 z-[70] bg-black/90 flex items-center justify-center" onClick={() => setZoomUrl(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={displayImageSrc(zoomUrl)} alt="" className="max-w-full max-h-full object-contain" />
          <button type="button" onClick={() => setZoomUrl(null)} aria-label="Close"
            className="absolute top-4 right-4 w-10 h-10 rounded-full bg-black/60 text-white text-2xl leading-none flex items-center justify-center">×</button>
        </div>
      )}

      {/* Full "Add Line Item" editor — the SAME component the manual rate-card
          form uses (category / sub / item / qty / vendor / tenant % / vendor $),
          seeded from the tapped suggestion. It renders its own full-screen
          overlay; Save Line adds to the chip's room and clears the chip, Cancel
          just closes. Wrapped in a table because EditableLineRow is a <tr>. */}
      {editorState && (
        <div className="pointer-events-auto">
          <table className="absolute w-0 h-0 overflow-hidden">
            <tbody>
              <EditableLineRow
                mobile
                startInEditMode
                line={editorState.line}
                catalog={catalog}
                regions={regions}
                inspectionRegion={region}
                section={editorState.line.section}
                location={editorState.line.location}
                tenantMonths={tenantMonths}
                onSave={(line) => commitEditor(editorState.chip, line)}
                onDelete={() => setEditorState(null)}
                onDiscardNew={() => setEditorState(null)}
                onEditingChange={(isEditing) => { if (!isEditing) setEditorState(null); }}
              />
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
