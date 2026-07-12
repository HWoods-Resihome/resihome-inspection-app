import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppDialog } from '@/components/AppDialog';
import { PhotoAnnotator } from '@/components/PhotoAnnotator';
import { PhotoLightbox } from '@/components/PhotoLightbox';
import { uploadVideo } from '@/lib/photoUpload';
import { makeVideoEntry } from '@/lib/media';
import { CameraAILayer } from '@/components/CameraAILayer';
import { SyncingBadge } from '@/components/SyncingBadge';
import { SelfHealingImg } from '@/components/PhotoThumb';
import { displayImageSrc } from '@/lib/photoDisplay';
import { onPhotoSynced, discardQueuedByUrls } from '@/lib/offlinePhotoStore';
import { removePhotoAttachByUrl } from '@/lib/photoAttachOutbox';
import { pushCameraOpen, popCameraOpen } from '@/lib/cameraOpenState';
import { KnowledgeTrainerModal } from '@/components/KnowledgeTrainerModal';
import { useBackToClose } from '@/lib/useBackToClose';
import { setNativeStatusBarColor } from '@/lib/nativeBridge';
import type { RateCardLineInput, RateCardLineItem, RegionRate } from '@/lib/types';

/**
 * State of each photo in the capture session.
 *
 * Lifecycle:
 *   pending -> uploading -> uploaded (success)
 *                       -> failed (with retry option)
 *   pending -> cancelled (user deleted before upload finished)
 */
interface CaptureItem {
  id: string;                    // local unique id
  blobUrl: string;               // object URL for the FULL-RES image (viewer/markup)
  // Small (~400px) data-URL thumbnail for the capture strip, so the strip shows a
  // tiny tile instead of decoding the full-res blob per photo. Falls back to
  // blobUrl when a thumb wasn't generated.
  thumbUrl?: string;
  file: File;                    // the captured file
  status: 'uploading' | 'uploaded' | 'failed';
  hubspotUrl?: string;           // populated when upload succeeds (videos: poster#v=video entry)
  error?: string;                // populated when upload fails
  abortController?: AbortController;
  kind?: 'photo' | 'video';      // 'video' = press-and-hold clip (blobUrl is its poster)
  videoUrl?: string;             // video only: object URL of the clip, for in-gallery playback
}

interface CameraRoom {
  id: string;
  name: string;
  photoCount: number;
  needsPhotos: boolean;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onComplete: (hubspotUrls: string[]) => void;
  // Reuses the parent's upload helper (compression + HubSpot Files API).
  // Returning the HubSpot URL on success.
  uploadPhoto: (file: File) => Promise<string>;
  // Optional queue-aware video uploader: uploads poster + clip and returns the
  // composite `poster#v=video` entry (offline -> a local-draft composite). When
  // omitted, falls back to the direct uploadPhoto(poster) + uploadVideo(clip).
  uploadVideoEntry?: (videoFile: File, posterFile: File) => Promise<string>;
  // Optional cap on number of photos in a single session
  maxPhotos?: number;
  // --- Multi-room mode (optional) -----------------------------------------
  // When provided, the camera shows a room switcher in the top bar so the
  // inspector can photograph the whole house without leaving the camera.
  // Switching rooms (or pressing Done) flushes the current room's captures back
  // to the inspection via onRoomChange / onComplete.
  rooms?: CameraRoom[];
  currentRoomId?: string;
  // Called when the user switches rooms. Receives the URLs captured for the
  // room being LEFT, and the id of the room being entered. The parent should
  // persist the urls to the left room and update currentRoomId.
  onRoomChange?: (leavingRoomId: string, capturedUrls: string[], enteringRoomId: string) => void;
  // Optional room management from inside the camera. If provided, the room list
  // dropdown gains rename / delete / add controls.
  onRenameRoom?: (roomId: string, newName: string) => void;
  onDeleteRoom?: (roomId: string) => void;        // parent handles confirm-if-has-lines
  onAddRoom?: (name: string) => void;
  // Address burned into the corner of each in-app capture (with date/time +
  // GPS) for evidentiary value on chargeback disputes.
  addressSnapshot?: string;
  // Property record id — lets the GPS check use the property's stored
  // coordinates first, before falling back to geocoding the address.
  propertyRecordId?: string;
  // Optional voice line-item assistant rendered inside the camera, so the
  // inspector can dictate line items while shooting. No-op on browsers without
  // the Web Speech API (e.g. iOS Safari).
  voiceSlot?: React.ReactNode;
  // Line items for the active room — when non-empty, the in-camera photo viewer
  // shows a "Tag to line item" control (mirrors the inspection view).
  tagLines?: { externalId: string; label: string }[];
  // Tag a captured photo (by its uploaded URL) to a line; returns the new
  // (stamped) URL so the camera keeps the stamped version.
  onTagPhotoToLine?: (hubspotUrl: string, lineExternalId: string) => Promise<string>;
  // Reports when an in-camera overlay (photo viewer or markup editor) is open, so
  // the parent can hide the floating mic over it (unless a conversation is engaged).
  onOverlayChange?: (open: boolean) => void;
  // --- AI assist (Beta) — the all-in-one layer ---------------------------------
  // When true, an AI overlay rides on top of the camera: always-listening voice,
  // periodic vision call-outs, and add/decline chips that commit lines to the
  // CURRENT room. Off => the camera behaves exactly as before.
  aiAssist?: boolean;
  aiRegion?: string;
  aiTenantMonths?: number | null;
  aiCatalog?: RateCardLineItem[];
  aiRegions?: RegionRate[];
  onAiAddLine?: (sectionId: string, line: RateCardLineInput) => void;
  onAiStill?: (sectionId: string, url: string) => void;
}

// A stamp line; `mark` appends a colored ✓ (location matches the property) or
// ✗ (GPS is far from the property address) after the text.
type StampLine = { text: string; mark?: 'ok' | 'bad' };

// Burn an evidence stamp (address / timestamp / GPS) into the bottom-left of a
// captured frame. Drawn straight onto the canvas BEFORE encoding, so it's part
// of the image pixels — not strippable metadata.
function drawEvidenceStamp(ctx: CanvasRenderingContext2D, w: number, h: number, lines: StampLine[]) {
  const rows = lines.filter((l) => l.text);
  if (!rows.length) return;
  const pad = Math.round(w * 0.014);
  // Width-scaled (trimmed w/54 → w/72) but CAPPED by height so a low-res capture
  // can't let the bar balloon to dominate the photo. Budget ≤ ~16% of height.
  const lf = 1.34;
  const fontByWidth = Math.round(w / 72);
  const fontByHeight = Math.floor((h * 0.16 - pad * 2) / (rows.length * lf));
  const fontSize = Math.max(11, Math.min(fontByWidth, fontByHeight));
  const lineH = Math.round(fontSize * lf);
  const barH = lineH * rows.length + pad * 2;
  // Translucent backdrop for legibility over any photo.
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.42)';
  ctx.fillRect(0, h - barH, w, barH);
  ctx.font = `600 ${fontSize}px -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.shadowColor = 'rgba(0,0,0,0.85)';
  ctx.shadowBlur = Math.round(fontSize * 0.3);
  let y = h - barH + pad;
  for (const row of rows) {
    // Ellipsize to fit the bar width so a long address isn't hard-clipped by the
    // canvas edge (the text is baked into the saved evidence pixels).
    const markW = row.mark ? ctx.measureText('  ✓').width : 0;
    const maxTextW = w - pad * 2 - markW;
    let text = row.text;
    if (ctx.measureText(text).width > maxTextW) {
      while (text.length > 1 && ctx.measureText(text + '…').width > maxTextW) text = text.slice(0, -1);
      text += '…';
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, pad, y);
    if (row.mark) {
      const x = pad + ctx.measureText(text + '  ').width;
      ctx.fillStyle = row.mark === 'ok' ? '#34d399' : '#f87171';
      ctx.fillText(row.mark === 'ok' ? '✓' : '✗', x, y);
    }
    y += lineH;
  }
  ctx.restore();
}

// Target capture resolution (4:3). Requested HIGH so BOTH the live preview and
// the captured frame are as sharp/zoomable as possible (the browser negotiates
// down per device). We grab the live frame on capture (instant — no freeze, no
// ImageCapture.takePhoto), so the higher track resolution directly raises final
// photo quality.
const CAPTURE_WIDTH = 3840;
const CAPTURE_HEIGHT = 2880;

// JPEG quality (0..1). 0.92 keeps evidence photos crisp (esp. when digitally
// zoomed/cropped) at a still-reasonable file size.
const JPEG_QUALITY = 0.92;
// Saved-photo ceiling (long edge) = the uploaded size. 1600px @ q0.80 — sharper
// than the previous 1200 @ 0.68 while staying well under the old 4096 @ 0.9 that
// bogged down field sync. Kept in step with the Modern camera. The PDF is
// unaffected (it embeds a 520px thumbnail).
const MAX_SAVE_EDGE = 1920;
const PHOTO_SAVE_QUALITY = 0.82;

// Photo geostamp proximity check: how close (meters) the device GPS must be to
// the property's reference location to stamp a ✓ rather than a ✗. Generous by
// default to absorb GPS drift and rooftop-vs-parcel geocode offset; overridable.
const PROXIMITY_THRESHOLD_M = Number(process.env.NEXT_PUBLIC_PROXIMITY_THRESHOLD_M) || 250;

// A GPS fix older than this (ms) is treated as stale, so killing location (or a
// silent watch stall) flips the verdict to "unverified" instead of freezing the
// last distance.
const FIX_TTL_MS = 15000;
// Battery: we DON'T keep a continuous high-accuracy watchPosition (that pins the
// GPS radio on for the whole camera session). Instead we take a fresh one-shot
// high-accuracy fix this often — just under FIX_TTL_MS so the badge/stamp never
// actually go stale in normal use, while letting the GPS sleep between fixes.
const GEO_REFRESH_MS = 12000;

// Great-circle distance between two lat/lng points, in meters.
function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Human-friendly distance: "42 m" / "1.3 km".
function fmtDistance(m: number): string {
  // Imperial units: feet up close, miles farther out.
  const ft = m * 3.28084;
  return ft < 1000 ? `${Math.round(ft)} ft` : `${(m / 1609.344).toFixed(1)} mi`;
}

// Press-and-hold video clips: hold the shutter > HOLD_MS to start recording;
// clips auto-stop at MAX_CLIP_MS. Bitrate-capped so a 10s clip stays small.
const HOLD_MS = 260;
const MAX_CLIP_MS = 20000; // cap clips at 20s to keep upload sizes/durations sane
const CLIP_BITRATE = 2_500_000;
// Digital zoom while recording: drag the thumb up to zoom in, down to zoom out.
// (Done in-canvas so it works on iOS Safari, which doesn't support the hardware
// `zoom` track constraint.)
const MAX_ZOOM = 4;
const ZOOM_DRAG_PX = 520; // thumb travel (px) for the full 1x→MAX_ZOOM range (higher = gentler)
const ZOOM_DEADZONE_PX = 18; // ignore tiny thumb wobble before zoom kicks in

// Pick the best MediaRecorder mime type this browser supports, strongly
// preferring H.264-in-mp4 — the ONE container/codec both iOS Safari AND
// Android/Chrome can play. A clip recorded as webm (vp8/vp9) plays on Android
// but is undecodable on iOS Safari (no webm support at all), which is why
// Android-recorded clips showed a black frame + dead play button on iPhones.
// Bare 'video/mp4' returns false on Android Chrome — it needs an explicit avc1
// codec string — so we try those first; modern Android Chrome (~116+) supports
// them and produces an iOS-playable file. Returns '' if recording is
// unsupported entirely. Order = most-compatible → least.
function pickClipMime(): string {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2', // H.264 baseline + AAC (universal)
    'video/mp4;codecs=avc1.4D401E,mp4a.40.2', // H.264 main + AAC
    'video/mp4;codecs=h264,aac',
    'video/mp4',                              // Safari reports this directly
    'video/webm;codecs=h264,opus',            // H.264 in webm (some Android)
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) || '';
}

export function CameraCaptureLegacy({
  isOpen, onClose, onComplete, uploadPhoto, uploadVideoEntry, maxPhotos = 30,
  rooms, currentRoomId, onRoomChange, onRenameRoom, onDeleteRoom, onAddRoom,
  addressSnapshot, propertyRecordId, voiceSlot, tagLines, onTagPhotoToLine, onOverlayChange,
  aiAssist, aiRegion, aiTenantMonths, aiCatalog, aiRegions, onAiAddLine, onAiStill,
}: Props) {
  const dialog = useAppDialog();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // The camera viewport container (untransformed) — tap-to-focus measures
  // against this, not the CSS-zoom-scaled <video>, so focus + the reticle stay
  // correct at any zoom level.
  const viewportRef = useRef<HTMLDivElement | null>(null);
  // The full-screen camera root — used to request the Fullscreen API so the
  // mobile browser's URL bar gets out of the way in landscape.
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Last time the inspector pressed the shutter (manual capture). The AI auto-
  // still fallback reads this so it only fills gaps when nobody's shooting.
  const lastManualCaptureRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  // Latest GPS fix, kept fresh while the camera is open, burned into captures.
  const geoRef = useRef<GeolocationPosition | null>(null);
  const geoWatchRef = useRef<number | null>(null);
  // Guards against stacking overlapping one-shot fixes (the periodic refresh
  // replaces the old continuous watch — see startWatch).
  const geoFixInFlightRef = useRef(false);
  // Property reference location + the latest fix as state, so the live
  // proximity badge re-renders and captures can stamp a ✓/✗ verdict.
  const [refCoords, setRefCoords] = useState<{ lat: number; lng: number; source: string } | null>(null);
  const [geoFix, setGeoFix] = useState<{ lat: number; lng: number; acc: number; ts: number } | null>(null);
  const [geoError, setGeoError] = useState(false);
  // Ticks every few seconds while open so the proximity verdict re-evaluates
  // staleness even when no new GPS events arrive (e.g. location switched off).
  const [geoTick, setGeoTick] = useState(0);
  const refCoordsRef = useRef<typeof refCoords>(null);
  const geoTsRef = useRef(0);
  const geoErrorRef = useRef(false);

  // ----- Video clip recording (press-and-hold the shutter) -----
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordAudioStreamRef = useRef<MediaStream | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxClipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingRef = useRef(false);
  const clipSupported = useRef<boolean>(false);
  const [recording, setRecording] = useState(false);
  const [recordSecs, setRecordSecs] = useState(0);
  // Digital-zoom-while-recording state.
  const zoomRef = useRef(1);
  const recordCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const recordRafRef = useRef<number | null>(null);
  const canvasStreamRef = useRef<MediaStream | null>(null);
  const shutterStartYRef = useRef<number | null>(null);
  // Zoom-drag smoothing: anchor to the zoom at drag start (so a tiny finger
  // drift on press-and-hold can't snap to the ultrawide lens), coalesce moves to
  // one update per animation frame, and throttle the (slow) hardware zoom calls.
  const dragStartZoomRef = useRef(1);
  const zoomTargetRef = useRef<number | null>(null);
  const zoomDragRafRef = useRef<number | null>(null);
  const lastHwZoomApplyRef = useRef(0);
  const [zoom, setZoom] = useState(1);
  // Hardware (sensor) zoom capability. On phones with an ultra-wide lens the
  // reported zoom.min is BELOW 1, so applying it switches to the WIDE lens.
  // When present we drive the whole zoom range through the hardware track —
  // giving true optical/sensor zoom AND wide — and skip the CSS digital crop.
  // iOS Safari doesn't expose it → digital fallback (zoom IN only).
  const zoomCapsRef = useRef<{ min: number; max: number } | null>(null);
  const hwZoomRef = useRef(false);
  const [hwZoom, setHwZoom] = useState(false);
  // The DIGITAL crop factor the preview/capture/focus should apply: always 1
  // when the sensor is doing the zoom (so we never double-zoom), else the
  // current digital zoom.
  const effZoom = useCallback(() => (hwZoomRef.current ? 1 : (zoomRef.current || 1)), []);
  // Single zoom setter: clamp to the live range and, when hardware zoom is
  // available, push it to the sensor (this is what reaches the wide lens).
  const applyZoom = useCallback((z: number, opts?: { immediateHw?: boolean }) => {
    const caps = zoomCapsRef.current;
    const zMin = caps ? caps.min : 1;
    const zMax = caps ? caps.max : MAX_ZOOM;
    const nz = Math.max(zMin, Math.min(zMax, z));
    zoomRef.current = nz;
    setZoom(nz);
    if (caps) {
      // Hardware (sensor) zoom via applyConstraints is comparatively slow and
      // chokes if called on every pointermove — throttle to ~12/s during a drag
      // (the digital preview + label still update every frame for smoothness).
      const now = Date.now();
      if (opts?.immediateHw || now - lastHwZoomApplyRef.current >= 80) {
        lastHwZoomApplyRef.current = now;
        const track = streamRef.current?.getVideoTracks?.()[0];
        try { (track?.applyConstraints as any)?.({ advanced: [{ zoom: nz }] }); } catch { /* unsupported */ }
      }
    }
  }, []);

  const [items, setItems] = useState<CaptureItem[]>([]);
  // Mirror items in a ref so async code (handleDone polling) can read the
  // latest value without depending on state closures.
  const itemsRef = useRef<CaptureItem[]>([]);
  useEffect(() => { itemsRef.current = items; }, [items]);

  // Tell every form a camera is open (so they free their photo grids — iOS memory),
  // and so the offline store engages its camera-open safeguards AND kicks the flush
  // the instant the camera closes. The 026c935 base this file is restored from
  // never wired this up, so on iOS isAnyCameraOpen() was permanently false.
  useEffect(() => {
    if (!isOpen) return;
    pushCameraOpen();
    return () => { popCameraOpen(); };
  }, [isOpen]);

  // draft→real URL map (from photo-sync events) so an item that synced before its
  // hubspotUrl was assigned still resolves to the real URL — prevents duplicates.
  const syncedUrlMapRef = useRef<Map<string, string>>(new Map());
  const resolveSyncedUrl = (u?: string): string | undefined => (u ? (syncedUrlMapRef.current.get(u) || u) : u);
  // True between hold-engaged and release; lets an async startRecording() abort if
  // the finger lifts mid-setup (prevents the stuck-"recording" freeze).
  const recordingIntentRef = useRef(false);

  // CRITICAL: when a queued photo finishes uploading in the background, swap THIS
  // camera item's draft (blob:) URL for the real HubSpot URL. That clears the
  // "Syncing…" badge AND means Done hands the inspection the REAL url instead of an
  // orphaned draft. The 026c935 base lacked this subscription entirely — which is
  // why iOS photos stuck on "Syncing…" forever and the uploaded file's real url
  // never reached the inspection (the root cause of the whole sync hang on iOS).
  useEffect(() => {
    if (!isOpen) return;
    syncedUrlMapRef.current.clear();
    const unsub = onPhotoSynced(({ oldUrl, newUrl }) => {
      // Record draft→real so an item that synced before its hubspotUrl was
      // assigned still resolves to the real URL (prevents the "duplicates after
      // Done" bug — see the Modern camera for the full explanation).
      syncedUrlMapRef.current.set(oldUrl, newUrl);
      setItems((prev) => prev.map((it) => {
        if (it.hubspotUrl !== oldUrl) return it;
        // Synced → swap to the real URL and free the full-res object URL + File
        // bytes (the small strip thumb stays; the viewer loads the real url).
        try { if (it.blobUrl.startsWith('blob:')) URL.revokeObjectURL(it.blobUrl); } catch { /* noop */ }
        return { ...it, hubspotUrl: newUrl, blobUrl: newUrl, file: new File([], it.file.name, { type: it.file.type || 'image/jpeg' }) };
      }));
    });
    return () => { unsub(); };
  }, [isOpen]);

  // Resume a paused preview when returning to the tab (app-switch, lock/unlock) or
  // on regaining focus. PROMPT-FREE: replays the SAME stream, never getUserMedia —
  // so it recovers a stalled/black preview without re-asking for camera permission.
  useEffect(() => {
    if (!isOpen) return;
    const resume = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (recordingRef.current) return;
      const v = videoRef.current;
      if (v && v.paused) v.play().catch(() => { /* non-fatal */ });
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    window.addEventListener('pageshow', resume);
    return () => {
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('focus', resume);
      window.removeEventListener('pageshow', resume);
    };
  }, [isOpen]);
  // Captured-photo strip auto-scroll: always reveal the LATEST shot (appended at
  // the end) as photos come in — horizontally in portrait, vertically in
  // landscape. Setting both axes is safe; the non-scrollable one clamps to 0.
  const stripRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    el.scrollTo({ left: el.scrollWidth, top: el.scrollHeight, behavior: 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);

  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  // Pinned back lens by deviceId (null = OS default for `facing`). Some phones
  // default `facingMode:environment` to the ULTRA-WIDE; when there are multiple
  // back cameras we auto-pin the 2nd (the main lens on those phones). No UI.
  const [lensDeviceId, setLensDeviceId] = useState<string | null>(null);
  const lensDeviceIdRef = useRef<string | null>(null);
  useEffect(() => { lensDeviceIdRef.current = lensDeviceId; }, [lensDeviceId]);
  const lensPinnedRef = useRef(false); // auto-pick the main lens once per session
  const [permissionState, setPermissionState] = useState<'pending' | 'granted' | 'denied' | 'unsupported'>('pending');
  const [permissionError, setPermissionError] = useState<string>('');
  const [busy, setBusy] = useState(false);
  // Id of the captured photo currently open in the annotator (null = closed).
  const [annotatingId, setAnnotatingId] = useState<string | null>(null);
  // Index (within photo-only items) of the photo open in the swipeable viewer.
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  // Tell the parent when a photo viewer/markup editor is open over the camera
  // (so it can hide the floating mic). Report closed on unmount.
  const onOverlayChangeRef = useRef(onOverlayChange);
  onOverlayChangeRef.current = onOverlayChange;
  useEffect(() => {
    onOverlayChangeRef.current?.(viewerIndex !== null || annotatingId !== null);
  }, [viewerIndex, annotatingId]);
  useEffect(() => () => { onOverlayChangeRef.current?.(false); }, []);
  // Flash / torch. Only supported on some devices (typically Android Chrome,
  // back camera). torchSupported gates the button so we don't show a control
  // that does nothing (e.g. iOS Safari, front camera).
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [torchError, setTorchError] = useState('');

  // ----- Camera lifecycle -----

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  const startStream = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setPermissionState('unsupported');
      setPermissionError('This browser does not support in-app camera capture.');
      return;
    }
    try {
      // Stop any existing stream before starting a new one (e.g., when switching facing)
      stopStream();
      // Reset zoom for the new stream; detectZoom() below re-reads the new
      // track's capabilities (e.g. the front camera usually has no wide/zoom).
      zoomCapsRef.current = null; hwZoomRef.current = false; setHwZoom(false);
      zoomRef.current = 1; setZoom(1);
      // When a specific back lens is chosen, pin it by deviceId; otherwise let
      // the OS pick the default for the facing direction.
      const videoConstraint: MediaTrackConstraints = {
        ...(lensDeviceId && facing === 'environment'
          ? { deviceId: { exact: lensDeviceId } }
          : { facingMode: { ideal: facing } }),
        width: { ideal: CAPTURE_WIDTH },
        height: { ideal: CAPTURE_HEIGHT },
      };
      // IMPORTANT: do NOT put `advanced` focus/exposure constraints or a
      // frameRate here. The browser tries to satisfy them and will switch to
      // whatever lens can — frequently the ULTRA-WIDE — which made the camera
      // open on the wide lens. The continuous AF/AE/AWB is applied AFTER
      // acquisition (applyAutoFocus below) where it can't change the lens.
      // Open the camera VIDEO-ONLY — never request the mic on this shared preview
      // stream. The AI layer opens its OWN mic only when the inspector turns AI
      // ON, and releases it the instant they turn AI OFF. So (a) we never prompt
      // for the microphone until AI is actually engaged, and (b) the mic is freed
      // for phone calls whenever AI is off — the inspector can keep snapping
      // photos during a call. (Previously this requested `audio:!!aiAssist`, which
      // grabbed the mic the moment the AI camera opened and HELD it for the whole
      // session — even with AI toggled off — because the AI layer deliberately
      // never stops the shared stream. That blocked taking a call on iOS.)
      const tryGUM = (vc: MediaTrackConstraints) =>
        navigator.mediaDevices.getUserMedia({ video: vc });
      let stream: MediaStream;
      try {
        stream = await tryGUM(videoConstraint);
      } catch (e) {
        // A pinned lens deviceId can fail (busy / removed) — fall back to the OS
        // default for this facing so the camera never just breaks.
        if ((videoConstraint as any).deviceId) {
          if (lensDeviceIdRef.current) { lensPinnedRef.current = true; setLensDeviceId(null); }
          stream = await tryGUM({ facingMode: { ideal: facing }, width: { ideal: CAPTURE_WIDTH }, height: { ideal: CAPTURE_HEIGHT } });
        } else {
          throw e;
        }
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => { /* play() may reject silently if autoplay is blocked; not fatal */ });
      }
      // Keep the live preview continuously autofocused + auto-exposed so every
      // grabbed frame is sharp — this same <video> feeds BOTH the manual shutter
      // and the AI layer's stills. Continuous AF (vs. a per-shot focus pass)
      // keeps rapid capture instant while minimizing soft/blurry frames.
      // Capabilities populate late on some Android devices (like torch), so we
      // apply now, on metadata, and on a couple of short delays. Best-effort.
      const applyAutoFocus = () => {
        try {
          const track = streamRef.current?.getVideoTracks?.()[0];
          if (!track) return;
          const caps = (track.getCapabilities?.() as any) || {};
          const advanced: any[] = [];
          if (Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) advanced.push({ focusMode: 'continuous' });
          if (Array.isArray(caps.exposureMode) && caps.exposureMode.includes('continuous')) advanced.push({ exposureMode: 'continuous' });
          if (Array.isArray(caps.whiteBalanceMode) && caps.whiteBalanceMode.includes('continuous')) advanced.push({ whiteBalanceMode: 'continuous' });
          if (advanced.length) (track.applyConstraints as any)({ advanced }).catch(() => { /* unsupported on this device */ });
        } catch { /* best-effort */ }
      };
      applyAutoFocus();
      [500, 1500].forEach((ms) => setTimeout(applyAutoFocus, ms));
      if (videoRef.current) videoRef.current.addEventListener('loadedmetadata', applyAutoFocus, { once: true });
      // Detect torch/flash support on the active video track. getCapabilities()
      // is unreliable immediately after getUserMedia — on many Android devices
      // .torch is undefined until the video has loaded metadata, and sometimes
      // a moment after. So we re-check on a short delay. We also optimistically
      // show the control on mobile back-cameras even if the capability flag is
      // missing, then confirm/disable on the first apply attempt (some devices
      // support torch via applyConstraints without reporting the capability).
      setTorchOn(false);
      setTorchError('');
      const checkTorch = () => {
        try {
          const track = streamRef.current?.getVideoTracks?.()[0];
          const caps = (track?.getCapabilities?.() as any) || {};
          if (caps.torch) { setTorchSupported(true); return; }
        } catch { /* ignore */ }
        // Optimistic fallback: on a mobile device using the back camera, allow
        // an attempt even when the capability isn't reported.
        const isMobile = typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
        setTorchSupported(isMobile && facing === 'environment');
      };
      // Check now, after metadata, and on several delays — some Android devices
      // only report the torch capability a second or two after the stream starts.
      checkTorch();
      [600, 1500, 2800].forEach((ms) => setTimeout(checkTorch, ms));
      if (videoRef.current) {
        videoRef.current.addEventListener('loadedmetadata', () => { checkTorch(); }, { once: true });
      }
      setTimeout(checkTorch, 800);
      // Detect the sensor's zoom range (capabilities populate late on Android,
      // like torch). Runs on a few delays to catch the late capability, but
      // INITIALIZES ONLY ONCE — re-running must never reset the inspector's
      // current zoom (that caused the "pinch in → snaps back to 1×" glitch,
      // which also dropped auto-HD since it's zoom-driven).
      const detectZoom = () => {
        if (zoomCapsRef.current) return; // already initialized — leave zoom alone
        try {
          const track = streamRef.current?.getVideoTracks?.()[0];
          const caps: any = track?.getCapabilities?.() || {};
          const z = caps.zoom;
          if (z && typeof z.min === 'number' && typeof z.max === 'number' && z.max > z.min) {
            zoomCapsRef.current = { min: z.min, max: z.max };
            hwZoomRef.current = true;
            setHwZoom(true);
            // CAPABILITY-BASED main-lens fix (not lens-index): a wide/ultra-wide-
            // capable lens reports zoom.min < 1. On those, normalize to 1.0× —
            // the standard (main) field of view — so the camera doesn't open
            // wide. 1.0 is the native FOV for a normal lens (min ≈ 1), so this is
            // a no-op there → fleet-safe. It's a zoom constraint (smooth), not a
            // camera switch, and runs ONCE (the early-return above prevents any
            // later reset of the inspector's zoom).
            const start = z.min < 1 ? Math.min(z.max, 1) : Math.max(z.min, Math.min(z.max, Number((track?.getSettings?.() as any)?.zoom) || 1));
            zoomRef.current = start; setZoom(start);
            if (z.min < 1) {
              try { (track!.applyConstraints as any)({ advanced: [{ zoom: start }] }); } catch { /* noop */ }
            }
          }
          // No caps yet → leave hwZoom as-is; a later delayed call may find them.
        } catch { /* best-effort */ }
      };
      detectZoom();
      [600, 1500, 2800].forEach((ms) => setTimeout(detectZoom, ms));
      // (We intentionally do NOT applyConstraints a higher resolution mid-stream
      // — that reconfigure stutters the live preview. The resolution requested
      // in getUserMedia above is what we keep.) The ultra-wide-default fix is
      // capability-based (zoom normalization in detectZoom), not lens-index.
      setPermissionState('granted');
      setPermissionError('');
    } catch (e: any) {
      const name = e?.name || '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setPermissionState('denied');
        setPermissionError('Camera permission was denied. Please grant access in your browser settings or use the Choose Files option instead.');
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setPermissionState('denied');
        setPermissionError('No camera was found on this device.');
      } else if (name === 'NotReadableError' || name === 'TrackStartError') {
        setPermissionState('denied');
        setPermissionError('Camera is already in use by another app. Close the other app and try again.');
      } else {
        setPermissionState('denied');
        setPermissionError(`Could not access camera: ${e?.message || String(e)}`);
      }
    }
  }, [facing, lensDeviceId, stopStream, aiAssist]);

  // Mount/unmount: start/stop the camera stream
  useEffect(() => {
    if (isOpen) {
      startStream();
    } else {
      stopStream();
    }
    return () => stopStream();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, facing, lensDeviceId]);

  // iOS pinch-zoom guard. While the camera is open, iOS Safari / WKWebView
  // treats a pinch as a PAGE zoom — it scales the whole screen, pushing the
  // shutter out of reach so the inspector can't take a photo (and the same
  // happens over the video recorder, and over the AI-camera overlay this hosts).
  // Two layers, because neither alone is reliable on iOS:
  //   1. preventDefault the Safari gesture* events + any multi-touch move.
  //   2. Lock the viewport to maximum-scale=1 ONLY while open (the native
  //      WKWebView honors this even when (1) doesn't), then restore it on close
  //      so global pinch-zoom / accessibility is unaffected elsewhere.
  // Single-finger taps/drags (shutter, slide-to-zoom, the reference-photo strip's
  // horizontal scroll) are untouched.
  // The PAGE must never zoom while the camera is open — a pinch should zoom the
  // CAMERA (handled by the pinch handler below), not scale the whole screen out
  // of reach. Every browser engine needs a different lever, so we pull them all:
  //   • iOS WebKit (Safari AND Chrome — Chrome on iOS is WebKit): preventDefault
  //     the gesture* events (pinch) and a fast second tap (double-tap zoom).
  //   • Android Chrome: pinch is a 2-finger touchmove — preventDefault it; and
  //     `user-scalable=no` in the viewport is honored here (and in the native
  //     WKWebView), so lock it while open and restore on close.
  // One-finger scrolling (the reference-photo strip) is untouched: we only block
  // multi-touch moves and rapid double-taps.
  useEffect(() => {
    if (!isOpen) return;
    const opts = { passive: false } as AddEventListenerOptions;
    const preventGesture = (e: Event) => { e.preventDefault(); };
    const preventMultiTouch = (e: TouchEvent) => { if (e.touches.length > 1) e.preventDefault(); };
    let lastTouchEnd = 0;
    const preventDoubleTap = (e: TouchEvent) => {
      const now = Date.now();
      if (now - lastTouchEnd <= 300) e.preventDefault(); // swallow the 2nd tap of a double-tap-zoom
      lastTouchEnd = now;
    };
    document.addEventListener('gesturestart', preventGesture as EventListener, opts);
    document.addEventListener('gesturechange', preventGesture as EventListener, opts);
    document.addEventListener('gestureend', preventGesture as EventListener, opts);
    document.addEventListener('touchstart', preventMultiTouch, opts);
    document.addEventListener('touchmove', preventMultiTouch, opts);
    document.addEventListener('touchend', preventDoubleTap, opts);
    const vp = typeof document !== 'undefined' ? document.querySelector('meta[name=viewport]') : null;
    const prevVp = vp?.getAttribute('content') ?? null;
    if (vp) vp.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no');
    return () => {
      document.removeEventListener('gesturestart', preventGesture as EventListener);
      document.removeEventListener('gesturechange', preventGesture as EventListener);
      document.removeEventListener('gestureend', preventGesture as EventListener);
      document.removeEventListener('touchstart', preventMultiTouch);
      document.removeEventListener('touchmove', preventMultiTouch);
      document.removeEventListener('touchend', preventDoubleTap);
      if (vp) vp.setAttribute('content', prevVp ?? 'width=device-width, initial-scale=1');
    };
  }, [isOpen]);

  // Pinch-to-zoom the CAMERA (digital zoom, driven into the same `zoom` state the
  // slide-to-zoom uses). Reading the two-finger distance works identically on iOS
  // Safari/Chrome and Android Chrome; the page-zoom guard above stops the browser
  // from also zooming. capturePhoto / video record / the AI still all crop to this
  // factor so the captured image matches the zoomed preview.
  const pinchRef = useRef<{ startDist: number; startZoom: number } | null>(null);
  // Single-finger tap tracking for tap-to-focus (distinct from pinch + slides).
  const tapRef = useRef<{ x: number; y: number; t: number; moved: boolean; target: EventTarget | null } | null>(null);
  // Brief focus reticle at the tapped point (screen coords within the viewport).
  const [focusPt, setFocusPt] = useState<{ x: number; y: number; key: number } | null>(null);
  const touchDist = (t: React.TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

  // Tap-to-focus. Drives the camera's focus (and exposure) to the tapped point
  // via the non-standard `pointsOfInterest` constraint — supported on Android
  // Chrome; iOS Safari/Chrome ignore it but autofocus continuously anyway, so
  // the reticle still gives feedback there. Reverts to continuous AF after a
  // moment so the preview doesn't stay locked on that spot.
  const focusAt = useCallback((clientX: number, clientY: number) => {
    // Measure against the viewport container (NOT the <video>, which is scaled by
    // the CSS digital zoom — its bounding box would throw off both the focus
    // point and the reticle).
    const box = viewportRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    // Viewport-normalized tap (0..1).
    const vx = Math.max(0, Math.min(1, px / rect.width));
    const vy = Math.max(0, Math.min(1, py / rect.height));
    // Correct for digital zoom: the preview is scaled about its center, so the
    // viewport shows only the central 1/zoom of the frame. Map the tap back into
    // full-frame coordinates so focus lands where the inspector actually tapped.
    const z = effZoom();
    const nx = Math.max(0, Math.min(1, 0.5 + (vx - 0.5) / z));
    const ny = Math.max(0, Math.min(1, 0.5 + (vy - 0.5) / z));
    const key = Date.now();
    setFocusPt({ x: px, y: py, key });
    window.setTimeout(() => setFocusPt((p) => (p && p.key === key ? null : p)), 900);
    const track = streamRef.current?.getVideoTracks?.()[0];
    if (!track) return;
    try {
      const caps: any = track.getCapabilities?.() || {};
      const adv: any[] = [];
      if ('pointsOfInterest' in caps) adv.push({ pointsOfInterest: [{ x: nx, y: ny }] });
      if (Array.isArray(caps.focusMode) && caps.focusMode.includes('single-shot')) adv.push({ focusMode: 'single-shot' });
      else if (Array.isArray(caps.focusMode) && caps.focusMode.includes('manual')) adv.push({ focusMode: 'manual' });
      if (Array.isArray(caps.exposureMode) && caps.exposureMode.includes('continuous')) adv.push({ exposureMode: 'continuous' });
      if (!adv.length) return; // device exposes no focus controls — iOS path
      (track.applyConstraints as any)({ advanced: adv }).catch(() => { /* unsupported */ });
      // Return to continuous AF so a later scene change still refocuses.
      window.setTimeout(() => {
        if (Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
          (track.applyConstraints as any)({ advanced: [{ focusMode: 'continuous' }] }).catch(() => { /* noop */ });
        }
      }, 2500);
    } catch { /* best-effort */ }
  }, []);

  const onViewportTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      pinchRef.current = { startDist: touchDist(e.touches) || 1, startZoom: zoomRef.current };
      tapRef.current = null; // a two-finger gesture is never a focus tap
    } else if (e.touches.length === 1) {
      const t = e.touches[0];
      tapRef.current = { x: t.clientX, y: t.clientY, t: Date.now(), moved: false, target: e.target };
    }
  };
  const onViewportTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && pinchRef.current) {
      // Pinch maps to the live range — below 1 reaches the wide lens when the
      // hardware supports it (applyZoom clamps + pushes to the sensor).
      applyZoom(pinchRef.current.startZoom * (touchDist(e.touches) / pinchRef.current.startDist));
    } else if (tapRef.current && e.touches.length === 1) {
      const t = e.touches[0];
      if (Math.hypot(t.clientX - tapRef.current.x, t.clientY - tapRef.current.y) > 12) tapRef.current.moved = true;
    }
  };
  const onViewportTouchEnd = (e: React.TouchEvent) => {
    if (e.touches.length < 2) pinchRef.current = null;
    const tp = tapRef.current;
    tapRef.current = null;
    if (!tp || e.touches.length !== 0) return;
    const ct = e.changedTouches[0];
    if (ct) {
      const dx = ct.clientX - tp.x;
      const dy = ct.clientY - tp.y;
      // Horizontal swipe across the preview → change rooms (multi-room only).
      // Must be clearly horizontal, far enough, and quick — so it never fires on
      // a tap-to-focus or a vertical drag. Swipe LEFT → next room, RIGHT → prev.
      if (multiRoom && Math.abs(dx) >= 60 && Math.abs(dx) > Math.abs(dy) * 1.3 && (Date.now() - tp.t) < 700) {
        goAdjacentRoom(dx < 0 ? 1 : -1);
        return;
      }
    }
    // A clean single tap directly on the preview (not a control button, not a
    // drag/swipe, not the tail of a pinch) → focus there.
    if (!tp.moved && (Date.now() - tp.t) < 400 && tp.target === videoRef.current) {
      if (ct) focusAt(ct.clientX, ct.clientY);
    }
  };

  // Resume after backgrounding. When the tab is hidden (user switches apps /
  // locks the phone / changes tabs), the browser stops the camera tracks, so on
  // return the <video> is frozen and won't capture. Re-acquire the stream (or
  // just replay a merely-paused video) when the page becomes visible again.
  useEffect(() => {
    if (!isOpen) return;
    const resume = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (recordingRef.current) return; // don't clobber an in-progress recording
      const track = streamRef.current?.getVideoTracks?.()[0];
      const dead = !streamRef.current || !track || track.readyState === 'ended';
      if (dead) {
        startStream();
      } else if (videoRef.current?.paused) {
        videoRef.current.play().catch(() => { /* autoplay rejection is non-fatal */ });
      }
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    window.addEventListener('pageshow', resume);
    return () => {
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('focus', resume);
      window.removeEventListener('pageshow', resume);
    };
  }, [isOpen, startStream]);

  // Lock the page behind the camera while it's open. Without this the
  // inspection underneath stays scrollable, so on mobile it scrolls up through
  // the full-screen camera (you could see the form below it). Freezing the
  // body + html overflow keeps the camera the only thing on screen.
  useEffect(() => {
    if (!isOpen || typeof document === 'undefined') return;
    const body = document.body;
    const html = document.documentElement;
    // Remember where the inspector was so closing the camera (Done/Cancel) leaves
    // them exactly there — toggling body overflow / tearing down the <video> can
    // otherwise snap the page back to the top (seen on iOS especially).
    const scrollY = window.scrollY || window.pageYOffset || 0;
    const prev = {
      bodyOverflow: body.style.overflow,
      bodyTouch: body.style.touchAction,
      bodyPos: body.style.position,
      bodyW: body.style.width,
      htmlOverflow: html.style.overflow,
      overscroll: (html.style as any).overscrollBehavior,
    };
    body.style.overflow = 'hidden';
    body.style.touchAction = 'none';
    html.style.overflow = 'hidden';
    (html.style as any).overscrollBehavior = 'none';
    return () => {
      body.style.overflow = prev.bodyOverflow;
      body.style.touchAction = prev.bodyTouch;
      body.style.position = prev.bodyPos;
      body.style.width = prev.bodyW;
      html.style.overflow = prev.htmlOverflow;
      (html.style as any).overscrollBehavior = prev.overscroll;
      // Restore the saved scroll position after layout settles.
      requestAnimationFrame(() => { try { window.scrollTo(0, scrollY); } catch { /* noop */ } });
    };
  }, [isOpen]);

  // While the camera is open, recolor the status bar from brand pink to black so
  // it blends into the black camera chrome instead of showing as a wasted pink
  // band above the header. Handles BOTH surfaces: the PWA/browser theme-color
  // meta AND the native (Capacitor) status bar. Restored on close.
  useEffect(() => {
    if (!isOpen || typeof document === 'undefined') return;
    const meta = document.querySelector('meta[name="theme-color"]');
    const prev = meta?.getAttribute('content') || '#ff0060';
    meta?.setAttribute('content', '#000000');
    setNativeStatusBarColor('#000000');
    return () => {
      meta?.setAttribute('content', prev);
      setNativeStatusBarColor(prev);
    };
  }, [isOpen]);

  // NOTE: fullscreen is intentionally NOT used on web (it caused the browser's
  // "you are in full screen" toast and made the back gesture exit fullscreen
  // instead of closing the camera). Back closes the camera via useBackToClose's
  // history entry; a chrome-free experience comes from installing the PWA.

  // Re-fit the live preview on rotation / resize. Several mobile browsers
  // (notably iOS Safari + iOS Chrome, and some Android WebViews / the native
  // shell) DON'T recompute a <video>'s object-fit paint box when the device
  // rotates — they keep the pre-rotation sizing, which leaves the picture as a
  // thin sliver down the middle in landscape. Toggling object-fit forces the UA
  // to recompute the painted box; a follow-up play() covers browsers that pause
  // the track across the orientation change. Cross-platform, no visual flash.
  useEffect(() => {
    if (!isOpen) return;
    let raf = 0;
    const refit = () => {
      const el = videoRef.current;
      if (!el) return;
      cancelAnimationFrame(raf);
      el.style.objectFit = 'fill';
      raf = requestAnimationFrame(() => {
        const v = videoRef.current;
        if (!v) return;
        v.style.objectFit = ''; // revert to the Tailwind `object-cover` class
        if (v.paused) v.play().catch(() => { /* autoplay rejection is non-fatal */ });
      });
    };
    window.addEventListener('orientationchange', refit);
    window.addEventListener('resize', refit);
    // Some browsers fire only one of the two, and a touch late — also nudge once
    // shortly after open so the very first paint is correct.
    const t = setTimeout(refit, 250);
    return () => {
      window.removeEventListener('orientationchange', refit);
      window.removeEventListener('resize', refit);
      clearTimeout(t);
      cancelAnimationFrame(raf);
    };
  }, [isOpen]);

  // Track landscape so the header can collapse its two rows into ONE slim bar
  // (Cancel · nav · AI status · controls) — in landscape vertical space is
  // precious, and there's plenty of width to hold it all on a single line.
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

  // While the camera is open, keep a fresh GPS fix so each shot can be stamped.
  // Best-effort: if the user denies location or it's unavailable, we just stamp
  // address + time without coordinates.
  //
  // (Re)acquire a GPS fix: requests a one-shot position (this triggers the OS
  // permission prompt when allowed) and (re)starts the watch. Safe to call
  // repeatedly — it clears any prior watch first — so it doubles as the recovery
  // path when the user turns location back on, and as the manual "re-check"
  // action behind the badge.
  const startWatch = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;
    if (geoFixInFlightRef.current) return; // a fix is already being acquired
    const onPos = (pos: GeolocationPosition) => {
      geoFixInFlightRef.current = false;
      geoRef.current = pos;
      geoTsRef.current = Date.now();
      geoErrorRef.current = false;
      const { latitude, longitude, accuracy } = pos.coords;
      setGeoFix({ lat: latitude, lng: longitude, acc: accuracy, ts: geoTsRef.current });
      setGeoError(false);
    };
    const onErr = () => {
      // Denied / location services off / position unavailable: drop the stale
      // fix so the verdict can't keep showing a frozen distance.
      geoFixInFlightRef.current = false;
      geoErrorRef.current = true;
      geoRef.current = null;
      setGeoError(true);
    };
    // BATTERY: a single high-accuracy one-shot fix, re-taken periodically by the
    // tick below — NOT a continuous watchPosition. A high-accuracy watch keeps
    // the GPS radio powered for the entire camera session; since the inspector
    // is stationary at one property, periodic one-shots keep the stamp precise
    // and the proximity verdict current while letting GPS sleep between fixes.
    // maximumAge:0 forces a current reading so recovery never returns a cached
    // "off" result.
    geoFixInFlightRef.current = true;
    navigator.geolocation.getCurrentPosition(onPos, onErr, {
      enableHighAccuracy: true, timeout: 8000, maximumAge: 0,
    });
  }, []);

  useEffect(() => {
    if (!isOpen || typeof navigator === 'undefined' || !navigator.geolocation) return;
    startWatch();
    // Re-evaluate staleness on a timer (no GPS events fire once location is off)
    // AND drive the periodic refresh: re-fix a little before the fix goes stale
    // so the badge/stamp stay current, and immediately when in a bad state so the
    // verdict recovers when the user turns location back on.
    const tick = setInterval(() => {
      setGeoTick((t) => t + 1);
      const age = Date.now() - geoTsRef.current;
      const bad = geoErrorRef.current || !geoRef.current || age > FIX_TTL_MS;
      if (bad || age > GEO_REFRESH_MS) startWatch();
    }, 3000);
    return () => {
      if (geoWatchRef.current != null) {
        try { navigator.geolocation.clearWatch(geoWatchRef.current); } catch { /* noop */ }
        geoWatchRef.current = null;
      }
      clearInterval(tick);
      geoRef.current = null;
      geoTsRef.current = 0;
      geoErrorRef.current = false;
      setGeoFix(null);
      setGeoError(false);
    };
  }, [isOpen, startWatch]);

  // Resolve the property's reference coordinates once per open, so each shot can
  // be checked for proximity. Prefers the property's stored lat/long (via
  // propertyRecordId), falling back to geocoding the address — see /api/geocode.
  useEffect(() => {
    if (!isOpen) { setRefCoords(null); refCoordsRef.current = null; return; }
    if (!propertyRecordId && !addressSnapshot) return;
    let cancelled = false;
    const params = new URLSearchParams();
    if (propertyRecordId) params.set('propertyId', propertyRecordId);
    if (addressSnapshot) params.set('address', addressSnapshot);
    fetch(`/api/geocode?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d || !isFinite(Number(d.lat)) || !isFinite(Number(d.lng))) return;
        const c = { lat: Number(d.lat), lng: Number(d.lng), source: String(d.source || 'unknown') };
        setRefCoords(c);
        refCoordsRef.current = c;
      })
      .catch(() => { /* no reference — captures stamp coords without a verdict */ });
    return () => { cancelled = true; };
  }, [isOpen, propertyRecordId, addressSnapshot]);

  // Live proximity verdict for the badge + the burned-in stamp.
  //   ok/far      → have a property reference AND a fresh GPS fix
  //   locating    → have a reference, still acquiring the first fix
  //   unverified  → can't validate (location off/denied, fix went stale, or no
  //                 property reference) — generic so any failure surfaces clearly
  // `within` credits the device's own GPS accuracy.
  const proximity = useMemo(() => {
    void geoTick; // re-run on the staleness timer
    if (!refCoords) return { status: 'unverified' as const, reason: 'No property location on file' };
    const stale = !geoFix || geoError || (Date.now() - geoFix.ts > FIX_TTL_MS);
    if (stale) {
      if (!geoFix && !geoError) return { status: 'locating' as const };
      return { status: 'unverified' as const, reason: 'Location unavailable' };
    }
    const distance = haversineMeters(geoFix.lat, geoFix.lng, refCoords.lat, refCoords.lng);
    const within = distance - (geoFix.acc || 0) <= PROXIMITY_THRESHOLD_M;
    return { status: within ? ('ok' as const) : ('far' as const), distance, source: refCoords.source };
  }, [refCoords, geoFix, geoError, geoTick]);

  // Build the GPS + proximity portion of the evidence stamp at capture time.
  // Only stamps coordinates/verdict when the fix is fresh; otherwise records
  // "Location unverified" so a photo never carries a stale or false ✓.
  const buildGeoStampLines = useCallback((): StampLine[] => {
    const lines: StampLine[] = [];
    const pos = geoRef.current;
    const fresh = !!pos && !geoErrorRef.current && Date.now() - geoTsRef.current <= FIX_TTL_MS;
    if (fresh && pos) {
      const { latitude, longitude, accuracy } = pos.coords;
      lines.push({ text: `${latitude.toFixed(5)}, ${longitude.toFixed(5)} (±${Math.round(accuracy)}m)` });
      const ref = refCoordsRef.current;
      if (ref) {
        const dist = haversineMeters(latitude, longitude, ref.lat, ref.lng);
        const within = dist - accuracy <= PROXIMITY_THRESHOLD_M;
        lines.push({ text: `${within ? 'At property' : 'Off-site'} · ${fmtDistance(dist)}`, mark: within ? 'ok' : 'bad' });
      }
    } else if (refCoordsRef.current) {
      // We expected to validate location but couldn't get a usable fix.
      lines.push({ text: 'Location unverified' });
    }
    return lines;
  }, []);

  // ----- Capture -----

  // Upload one File through the background pipeline + optimistic thumbnail.
  // Shared by the in-app shutter and the native-camera fallback.
  const enqueueFile = useCallback((file: File, thumbUrl?: string) => {
    const id = `${Date.now()}_${(typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 8)}`;
    const blobUrl = URL.createObjectURL(file);
    const abortController = new AbortController();
    const item: CaptureItem = { id, blobUrl, thumbUrl, file, status: 'uploading', abortController };
    setItems((prev) => [...prev, item]);
    uploadPhoto(file).then((hubspotUrl) => {
      if (abortController.signal.aborted) return;
      // Resolve through the sync map in case it already synced (draft→real) before
      // this resolved — else the stale draft would be handed back as a duplicate.
      const resolved = resolveSyncedUrl(hubspotUrl)!;
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, status: 'uploaded', hubspotUrl: resolved } : it)));
    }).catch((err) => {
      if (abortController.signal.aborted) return;
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, status: 'failed', error: err?.message || String(err) } : it)));
    });
  }, [uploadPhoto]);

  // ----- Video clips (press-and-hold the shutter) -----

  // Grab the current live frame as a JPEG poster for a clip (same evidence stamp
  // as photos, for consistency).
  const grabPoster = useCallback(async (): Promise<Blob | null> => {
    const video = videoRef.current;
    if (!video) return null;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const canvas = document.createElement('canvas');
    canvas.width = vw; canvas.height = vh;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, vw, vh);
    const stampLines: StampLine[] = [];
    if (addressSnapshot) stampLines.push({ text: addressSnapshot });
    stampLines.push({ text: new Date().toLocaleString() });
    stampLines.push(...buildGeoStampLines());
    drawEvidenceStamp(ctx, vw, vh, stampLines);
    return await new Promise((res) => canvas.toBlob((b) => res(b), 'image/jpeg', JPEG_QUALITY));
  }, [addressSnapshot, buildGeoStampLines]);

  // Upload the poster + video together and store them as one encoded photo_urls
  // entry (poster#v=video) so the clip rides the normal photo persistence.
  const enqueueVideo = useCallback((videoFile: File, posterBlob: Blob) => {
    const rid = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 8);
    const id = `${Date.now()}_${rid}`;
    const posterUrl = URL.createObjectURL(posterBlob);
    const abortController = new AbortController();
    const posterFile = new File([posterBlob], `clip_${id}_poster.jpg`, { type: 'image/jpeg' });
    const videoUrl = URL.createObjectURL(videoFile); // playable in the in-camera swipe gallery
    const item: CaptureItem = { id, blobUrl: posterUrl, file: videoFile, status: 'uploading', abortController, kind: 'video', videoUrl };
    setItems((prev) => [...prev, item]);
    // Prefer the queue-aware combined uploader (offline-capable); fall back to
    // the direct poster + clip uploads when not provided.
    const entryPromise = uploadVideoEntry
      ? uploadVideoEntry(videoFile, posterFile)
      : Promise.all([uploadPhoto(posterFile), uploadVideo(videoFile)]).then(([pUrl, vUrl]) => makeVideoEntry(pUrl, vUrl));
    entryPromise
      .then((entry) => {
        if (abortController.signal.aborted) return;
        setItems((prev) => prev.map((it) => (it.id === id ? { ...it, status: 'uploaded', hubspotUrl: entry } : it)));
      })
      .catch((err) => {
        if (abortController.signal.aborted) return;
        setItems((prev) => prev.map((it) => (it.id === id ? { ...it, status: 'failed', error: err?.message || String(err) } : it)));
      });
  }, [uploadPhoto, uploadVideoEntry]);

  function teardownCanvasPipeline() {
    if (recordRafRef.current != null) { cancelAnimationFrame(recordRafRef.current); recordRafRef.current = null; }
    if (canvasStreamRef.current) { canvasStreamRef.current.getTracks().forEach((t) => t.stop()); canvasStreamRef.current = null; }
    recordCanvasRef.current = null;
    // Also release the mic so a recorder-setup failure (early returns in
    // startRecording) never leaves the microphone live with the in-use
    // indicator stuck on.
    if (recordAudioStreamRef.current) {
      recordAudioStreamRef.current.getTracks().forEach((t) => t.stop());
      recordAudioStreamRef.current = null;
    }
  }

  function stopRecording() {
    if (maxClipTimerRef.current) { clearTimeout(maxClipTimerRef.current); maxClipTimerRef.current = null; }
    if (elapsedTimerRef.current) { clearInterval(elapsedTimerRef.current); elapsedTimerRef.current = null; }
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== 'inactive') { try { mr.stop(); } catch { /* noop */ } }
    recordingRef.current = false;
    setRecording(false);
  }

  async function finalizeClip(mime: string) {
    const chunks = recordedChunksRef.current;
    recordedChunksRef.current = [];
    // Grab the poster from the (zoomed) record canvas BEFORE tearing it down so
    // the still matches the clip; fall back to the raw frame.
    let poster: Blob | null = null;
    const canvas = recordCanvasRef.current;
    if (canvas) {
      poster = await new Promise<Blob | null>((res) => canvas.toBlob((b) => res(b), 'image/jpeg', JPEG_QUALITY));
    }
    teardownCanvasPipeline();
    // Stop the audio capture — but NOT the shared video track (it's the live preview).
    if (recordAudioStreamRef.current) {
      recordAudioStreamRef.current.getTracks().forEach((t) => t.stop());
      recordAudioStreamRef.current = null;
    }
    mediaRecorderRef.current = null;
    // Preserve a hardware/wide zoom across recording; only reset digital zoom.
    if (!hwZoomRef.current) { zoomRef.current = 1; setZoom(1); }
    if (!chunks.length) return;
    const type = (mime.split(';')[0] || 'video/mp4').toLowerCase();
    const ext = /mp4/.test(type) ? 'mp4' : /quicktime|mov/.test(type) ? 'mov' : 'webm';
    const blob = new Blob(chunks, { type });
    const file = new File([blob], `clip_${Date.now()}.${ext}`, { type });
    if (!poster) poster = await grabPoster();
    if (!poster) { void dialog.alert('Couldn’t save the clip preview frame. Please try again.'); return; }
    enqueueVideo(file, poster);
  }

  async function startRecording() {
    if (recordingRef.current || permissionState !== 'granted') return;
    const stream = streamRef.current;
    const video = videoRef.current;
    const videoTrack = stream?.getVideoTracks?.()[0];
    if (!video || !videoTrack) return;
    const mime = pickClipMime();
    if (!mime) { void dialog.alert('Video recording isn’t supported in this browser. Use the phone-camera button (top right) to record with your phone’s camera app.'); return; }
    if (items.length >= maxPhotos) { void dialog.alert(`You can capture up to ${maxPhotos} items per session. Tap Done to finish.`); return; }

    // Best-effort audio narration; fall back to a silent clip if the mic is denied.
    let audioTracks: MediaStreamTrack[] = [];
    try {
      const audio = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordAudioStreamRef.current = audio;
      audioTracks = audio.getAudioTracks();
    } catch { /* video-only */ }

    // Finger lifted while the mic prompt was pending → abort, don't start a
    // recording nobody is holding (the stuck-"recording" freeze).
    if (!recordingIntentRef.current) {
      if (recordAudioStreamRef.current) { recordAudioStreamRef.current.getTracks().forEach((t) => t.stop()); recordAudioStreamRef.current = null; }
      return;
    }

    // Render the camera into a canvas, center-cropped by the live zoom factor,
    // and record the canvas stream. This gives smooth digital zoom on every
    // platform (incl. iOS) and keeps the recording in sync with the preview.
    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;
    const canvas = document.createElement('canvas');
    canvas.width = vw; canvas.height = vh;
    const cctx = canvas.getContext('2d');
    if (!cctx) return;
    recordCanvasRef.current = canvas;
    if (!hwZoomRef.current) { zoomRef.current = 1; setZoom(1); }
    const drawFrame = () => {
      const z = effZoom();
      const sw = vw / z, sh = vh / z;
      const sx = (vw - sw) / 2, sy = (vh - sh) / 2;
      try { cctx.drawImage(video, sx, sy, sw, sh, 0, 0, vw, vh); } catch { /* not ready yet */ }
      recordRafRef.current = requestAnimationFrame(drawFrame);
    };
    drawFrame();

    let canvasStream: MediaStream;
    try { canvasStream = canvas.captureStream(30); } catch { teardownCanvasPipeline(); return; }
    canvasStreamRef.current = canvasStream;
    const tracks = [...canvasStream.getVideoTracks(), ...audioTracks];

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(new MediaStream(tracks), { mimeType: mime, videoBitsPerSecond: CLIP_BITRATE });
    } catch {
      try { recorder = new MediaRecorder(new MediaStream(tracks)); } catch { teardownCanvasPipeline(); return; }
    }
    recordedChunksRef.current = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) recordedChunksRef.current.push(e.data); };
    // Label the clip by what the recorder ACTUALLY produced (recorder.mimeType),
    // not just what we requested — the two can differ when the constructor falls
    // back to a default, and a mislabeled clip won't play on iOS.
    recorder.onstop = () => { void finalizeClip(recorder.mimeType || mime); };
    mediaRecorderRef.current = recorder;
    try { recorder.start(); } catch { teardownCanvasPipeline(); return; }
    recordingRef.current = true;
    setRecording(true);
    // Released during setup → stop now so the UI never sticks in "recording".
    if (!recordingIntentRef.current) { stopRecording(); return; }
    setRecordSecs(0);
    const startedAt = Date.now();
    elapsedTimerRef.current = setInterval(() => setRecordSecs(Math.floor((Date.now() - startedAt) / 1000)), 200);
    maxClipTimerRef.current = setTimeout(() => stopRecording(), MAX_CLIP_MS);
  }

  // Shutter: a quick tap takes a photo; press-and-hold (> HOLD_MS) records a clip.
  // While recording, sliding the thumb UP zooms in, DOWN zooms out.
  function onShutterDown(e: React.PointerEvent) {
    if (permissionState !== 'granted' || busy) return;
    shutterStartYRef.current = e.clientY;
    // Anchor the zoom drag to wherever zoom is NOW, so the gesture nudges from
    // the current level instead of snapping back to 1× (and a small downward
    // drift while holding can't dive to the ultrawide lens).
    dragStartZoomRef.current = zoomRef.current || 1;
    zoomTargetRef.current = null;
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* noop */ }
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      // Longer buzz to signal "hold engaged — now recording" (distinct from the
      // short photo-capture tick). No-op on iOS Safari.
      try { navigator.vibrate?.(35); } catch { /* unsupported */ }
      recordingIntentRef.current = true; // held → intend to record
      void startRecording();
    }, HOLD_MS);
  }
  function onShutterMove(e: React.PointerEvent) {
    if (!recordingRef.current || shutterStartYRef.current == null) return;
    const raw = shutterStartYRef.current - e.clientY; // up = positive = zoom in
    // Deadzone so a small wobble doesn't zoom; gentle ramp via ZOOM_DRAG_PX.
    const dy = raw > ZOOM_DEADZONE_PX ? raw - ZOOM_DEADZONE_PX
      : raw < -ZOOM_DEADZONE_PX ? raw + ZOOM_DEADZONE_PX : 0;
    // Linear from the drag-start zoom across the full range; up = in, down = out.
    const caps = zoomCapsRef.current;
    const zMin = caps ? caps.min : 1;
    const zMax = caps ? caps.max : MAX_ZOOM;
    zoomTargetRef.current = dragStartZoomRef.current + (dy / ZOOM_DRAG_PX) * (zMax - zMin);
    // Coalesce rapid pointermoves to ONE zoom update per frame (kills the jank
    // from setState + applyConstraints firing on every move).
    if (zoomDragRafRef.current == null) {
      zoomDragRafRef.current = requestAnimationFrame(() => {
        zoomDragRafRef.current = null;
        if (zoomTargetRef.current != null) applyZoom(zoomTargetRef.current);
      });
    }
  }
  function onShutterUp() {
    shutterStartYRef.current = null;
    // Signal release first so a startRecording() still in async setup aborts.
    recordingIntentRef.current = false;
    // Flush any pending zoom frame and push the final value to the sensor now.
    if (zoomDragRafRef.current != null) { cancelAnimationFrame(zoomDragRafRef.current); zoomDragRafRef.current = null; }
    if (zoomTargetRef.current != null) { applyZoom(zoomTargetRef.current, { immediateHw: true }); zoomTargetRef.current = null; }
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
      if (!recordingRef.current) void capturePhoto();
      return;
    }
    if (recordingRef.current) stopRecording();
  }

  // Tear down recording when the camera closes.
  useEffect(() => {
    if (isOpen) return;
    if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; }
    if (maxClipTimerRef.current) { clearTimeout(maxClipTimerRef.current); maxClipTimerRef.current = null; }
    if (elapsedTimerRef.current) { clearInterval(elapsedTimerRef.current); elapsedTimerRef.current = null; }
    try { if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') mediaRecorderRef.current.stop(); } catch { /* noop */ }
    if (recordRafRef.current != null) { cancelAnimationFrame(recordRafRef.current); recordRafRef.current = null; }
    if (zoomDragRafRef.current != null) { cancelAnimationFrame(zoomDragRafRef.current); zoomDragRafRef.current = null; }
    canvasStreamRef.current?.getTracks().forEach((t) => t.stop());
    canvasStreamRef.current = null;
    recordCanvasRef.current = null;
    recordAudioStreamRef.current?.getTracks().forEach((t) => t.stop());
    recordAudioStreamRef.current = null;
    recordingRef.current = false;
    setRecording(false);
    zoomRef.current = 1; setZoom(1);
  }, [isOpen]);

  // Native OS camera fallback. On iOS (no web torch) and as a universal
  // backup, this opens the phone's built-in camera — which has its own flash
  // control — via a file input with capture. Picked photos flow through the
  // same upload pipeline and thumbnails as in-app shots.
  const nativeInputRef = useRef<HTMLInputElement | null>(null);
  const openNativeCamera = useCallback(() => {
    nativeInputRef.current?.click();
  }, []);
  // Gallery picker — opens the device photo library (no `capture`, so it does
  // NOT launch the camera) for selecting one or more existing photos. This is
  // the in-camera "Upload" path; selected files flow through the same pipeline.
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const openGallery = useCallback(() => {
    galleryInputRef.current?.click();
  }, []);
  const handleNativeFiles = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;
    const room = Math.max(0, maxPhotos - itemsRef.current.length);
    const picked = Array.from(files).slice(0, room);
    if (picked.length < files.length) {
      void dialog.alert(`Only the first ${room} photo(s) were added (max ${maxPhotos} per session).`);
    }
    for (const f of picked) enqueueFile(f);
  }, [enqueueFile, maxPhotos]);

  const capturePhoto = useCallback(() => {
    // Count from the ref so rapid taps see the live total (state can lag a frame).
    if (itemsRef.current.length >= maxPhotos) {
      void dialog.alert(`You can capture up to ${maxPhotos} photos per session. Tap Done to finish.`);
      return;
    }
    const video = videoRef.current;
    if (!video || video.readyState < 2) return; // not ready; try again in a moment

    // Tactile "shot taken" confirmation (Android; a no-op on iOS Safari, which
    // ignores the Vibration API). Helps inspectors know the tap registered when
    // the shutter visual is brief and they're not looking closely.
    try { navigator.vibrate?.(15); } catch { /* unsupported */ }

    // Shared: draw a source (live frame OR full-sensor bitmap) to a capped canvas
    // with the digital-zoom crop + evidence stamp, then encode + enqueue in the
    // BACKGROUND (canvas.toBlob is off the main thread) so the shutter never
    // greys between shots.
    const buildAndEnqueue = (source: CanvasImageSource, srcW: number, srcH: number) => {
      try {
        if (!srcW || !srcH) return;
        const longEdge = Math.max(srcW, srcH);
        const scale = Math.min(1, MAX_SAVE_EDGE / longEdge);
        const vw = Math.max(1, Math.round(srcW * scale));
        const vh = Math.max(1, Math.round(srcH * scale));
        const canvas = document.createElement('canvas');
        canvas.width = vw; canvas.height = vh;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.imageSmoothingQuality = 'high';
        // effZoom()===1 when the sensor is zooming (hardware-zoomed frame used
        // as-is); otherwise crop the central 1/z (digital zoom).
        const z = effZoom();
        if (z > 1.001) {
          const sw = srcW / z, sh = srcH / z;
          ctx.drawImage(source, (srcW - sw) / 2, (srcH - sh) / 2, sw, sh, 0, 0, vw, vh);
        } else {
          ctx.drawImage(source, 0, 0, srcW, srcH, 0, 0, vw, vh);
        }
        const stampLines: StampLine[] = [];
        if (addressSnapshot) stampLines.push({ text: addressSnapshot });
        stampLines.push({ text: new Date().toLocaleString() });
        stampLines.push(...buildGeoStampLines());
        drawEvidenceStamp(ctx, vw, vh, stampLines);
        lastManualCaptureRef.current = Date.now();
        // Build a SMALL (~400px) strip thumbnail from this same canvas (no extra
        // decode) so the capture strip renders tiny tiles instead of the full-res
        // blob per photo — keeps strip memory low; the viewer still uses the full
        // blob. Best-effort: the strip falls back to the full blob if this fails.
        let thumbUrl: string | undefined;
        try {
          const tEdge = 400;
          const ts = Math.min(1, tEdge / Math.max(vw, vh));
          const tw = Math.max(1, Math.round(vw * ts)), th = Math.max(1, Math.round(vh * ts));
          const tcanvas = document.createElement('canvas');
          tcanvas.width = tw; tcanvas.height = th;
          const tctx = tcanvas.getContext('2d');
          if (tctx) { tctx.drawImage(canvas, 0, 0, tw, th); thumbUrl = tcanvas.toDataURL('image/jpeg', 0.6); }
          tcanvas.width = 0; tcanvas.height = 0; // free the thumb canvas now
        } catch { /* thumb is best-effort */ }
        canvas.toBlob((blob) => {
          if (!blob) return;
          const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          enqueueFile(new File([blob], `capture_${id}.jpg`, { type: 'image/jpeg' }), thumbUrl);
        }, 'image/jpeg', PHOTO_SAVE_QUALITY);
      } catch (e: any) {
        console.error('Capture error:', e);
      }
    };

    // Instant live-frame grab (rapid, no freeze). Sharpness comes from the
    // high-resolution preview track requested in getUserMedia.
    buildAndEnqueue(video, video.videoWidth, video.videoHeight);
  }, [maxPhotos, dialog, enqueueFile, addressSnapshot, buildGeoStampLines]);

  // ----- Per-photo retake/delete -----

  // Save annotations: swap in the marked-up file, show it immediately, and
  // re-upload (the un-annotated HubSpot file is left orphaned — the inspection
  // uses the new URL).
  const handleAnnotated = useCallback((id: string, file: File) => {
    const newBlobUrl = URL.createObjectURL(file);
    setItems((prev) => prev.map((it) => {
      if (it.id !== id) return it;
      // Annotating an un-synced DRAFT is a replace — recall the original draft's
      // queued record + pending attach so it and the annotated copy don't both
      // upload+attach (duplicate). Same fix as the form annotate handlers.
      if (it.hubspotUrl && it.hubspotUrl.startsWith('blob:')) { void discardQueuedByUrls([it.hubspotUrl]); removePhotoAttachByUrl([it.hubspotUrl]); }
      try { URL.revokeObjectURL(it.blobUrl); } catch { /* harmless */ }
      return { ...it, file, blobUrl: newBlobUrl, status: 'uploading', hubspotUrl: undefined };
    }));
    setAnnotatingId(null);
    uploadPhoto(file)
      .then((url) => setItems((prev) => prev.map((it) => (it.id === id ? { ...it, status: 'uploaded', hubspotUrl: url } : it))))
      .catch((err) => setItems((prev) => prev.map((it) => (it.id === id ? { ...it, status: 'failed', error: err?.message || String(err) } : it))));
  }, [uploadPhoto]);

  const deletePhoto = useCallback((id: string) => {
    setItems((prev) => {
      const found = prev.find((it) => it.id === id);
      if (found) {
        // Cancel in-flight upload if any. The .then() above checks aborted before
        // updating state, so this prevents stale state writes.
        found.abortController?.abort();
        // RECALL the durable records — aborting only gates the in-camera state
        // write; the offline queue/attach would otherwise still upload + re-attach
        // the deleted photo (it "reappears").
        if (found.hubspotUrl) { void discardQueuedByUrls([found.hubspotUrl]); removePhotoAttachByUrl([found.hubspotUrl]); }
        // Free the blob URL to avoid memory leaks
        try { URL.revokeObjectURL(found.blobUrl); } catch { /* harmless */ }
      }
      return prev.filter((it) => it.id !== id);
    });
  }, []);

  // ----- Retry a failed upload -----

  const retryUpload = useCallback((id: string) => {
    setItems((prev) => {
      const idx = prev.findIndex((it) => it.id === id);
      if (idx === -1) return prev;
      const target = prev[idx];
      if (target.status !== 'failed') return prev;
      // Reset to uploading
      const newAbort = new AbortController();
      const updated = { ...target, status: 'uploading' as const, error: undefined, abortController: newAbort };
      const next = [...prev];
      next[idx] = updated;

      const onOk = (hubspotUrl: string) => {
        if (newAbort.signal.aborted) return;
        setItems((cur) => cur.map((it) => (it.id === id ? { ...it, status: 'uploaded', hubspotUrl } : it)));
      };
      const onErr = (err: any) => {
        if (newAbort.signal.aborted) return;
        setItems((cur) => cur.map((it) => (it.id === id ? { ...it, status: 'failed', error: err?.message || String(err) } : it)));
      };

      if (target.kind === 'video') {
        // Video items: re-upload the clip AND its poster (the poster blob is
        // recoverable from the still-live preview object URL), then re-encode
        // the poster#v=video entry. (The old code ran uploadPhoto on the video
        // file, which tried to image-compress it and always failed.)
        (async () => {
          const posterBlob = await fetch(target.blobUrl).then((r) => r.blob());
          const posterFile = new File([posterBlob], `clip_${id}_poster.jpg`, { type: 'image/jpeg' });
          if (uploadVideoEntry) return uploadVideoEntry(target.file, posterFile);
          const [pUrl, vUrl] = await Promise.all([uploadPhoto(posterFile), uploadVideo(target.file)]);
          return makeVideoEntry(pUrl, vUrl);
        })().then(onOk).catch(onErr);
      } else {
        uploadPhoto(target.file).then(onOk).catch(onErr);
      }
      return next;
    });
  }, [uploadPhoto, uploadVideoEntry]);

  // ----- Done / Cancel -----

  // Wait for any in-flight uploads (hard ceiling), then return uploaded URLs
  // and clean up object URLs / clear the tray. Shared by Done and room-switch.
  const flushUploads = useCallback(async (): Promise<{ urls: string[]; failures: number }> => {
    const startedAt = Date.now();
    const TIMEOUT_MS = 60_000;
    while (Date.now() - startedAt < TIMEOUT_MS) {
      const current = itemsRef.current;
      if (!current.some((it) => it.status === 'uploading')) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const finalItems = itemsRef.current;
    const urls = Array.from(new Set(finalItems
      .filter((it) => it.status === 'uploaded' && it.hubspotUrl)
      // Resolve draft→real so Done returns the REAL url (matching the flush's copy
      // → the form's Set-dedup collapses them instead of duplicating).
      .map((it) => resolveSyncedUrl(it.hubspotUrl)!)));
    const failures = finalItems.filter((it) => it.status !== 'uploaded').length;
    for (const it of finalItems) {
      try { URL.revokeObjectURL(it.blobUrl); } catch { /* harmless */ }
    }
    setItems([]);
    return { urls, failures };
  }, []);

  const [roomMenuOpen, setRoomMenuOpen] = useState(false);
  // Live AI-assist status, surfaced by CameraAILayer and rendered in the black
  // header strip (below the title) so it never floats over the live image.
  const [aiStatus, setAiStatus] = useState<{ text: string; tone: 'idle' | 'listen' | 'heard' | 'think' | 'err' } | null>(null);
  // AI assist defaults OFF (owner directive) — the inspector turns it on with the
  // "Turn AI on" button when they want voice/call-outs.
  const [aiOn, setAiOn] = useState<boolean>(false);
  // "Teach the AI" voice-training popup (feeds the live knowledge base).
  const [kbTrainerOpen, setKbTrainerOpen] = useState(false);
  const [renamingRoomId, setRenamingRoomId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [addingRoom, setAddingRoom] = useState(false);
  const [addDraft, setAddDraft] = useState('');
  const multiRoom = !!(rooms && rooms.length && currentRoomId && onRoomChange);
  const currentRoom = multiRoom ? rooms!.find((r) => r.id === currentRoomId) : undefined;
  const currentIdx = multiRoom ? rooms!.findIndex((r) => r.id === currentRoomId) : -1;

  // Switch to another room: push the current room's captures back to the
  // inspection, clear the tray, and keep the camera open on the new room.
  const switchToRoom = useCallback(async (enteringRoomId: string) => {
    if (!multiRoom || enteringRoomId === currentRoomId) { setRoomMenuOpen(false); return; }
    setRoomMenuOpen(false);
    const { urls } = await flushUploads();
    onRoomChange!(currentRoomId!, urls, enteringRoomId);
  }, [multiRoom, currentRoomId, flushUploads, onRoomChange]);

  const goAdjacentRoom = useCallback((dir: -1 | 1) => {
    if (!multiRoom) return;
    const n = rooms!.length;
    const next = (currentIdx + dir + n) % n;
    void switchToRoom(rooms![next].id);
  }, [multiRoom, rooms, currentIdx, switchToRoom]);

  const handleDone = useCallback(async () => {
    const { urls, failures } = await flushUploads();
    if (failures > 0) {
      const ok = await dialog.confirm(
        `${failures} photo${failures === 1 ? '' : 's'} did not upload successfully. ` +
        `Continue with the ${urls.length} that succeeded?`,
        { confirmLabel: 'Continue' }
      );
      if (!ok) return;
    }
    stopStream();
    onComplete(urls);
  }, [flushUploads, onComplete, stopStream, dialog]);

  const handleCancel = useCallback(() => {
    // Abort all in-flight uploads and discard all photos. Captures are queued to
    // the durable store on the fly, so ALSO recall this session's queued drafts +
    // pending attaches — otherwise "Cancel" doesn't cancel and every photo still
    // syncs and attaches to the inspection.
    const draftUrls = items.map((it) => it.hubspotUrl).filter(Boolean) as string[];
    if (draftUrls.length) { void discardQueuedByUrls(draftUrls); removePhotoAttachByUrl(draftUrls); }
    for (const it of items) {
      it.abortController?.abort();
      try { URL.revokeObjectURL(it.blobUrl); } catch { /* harmless */ }
    }
    setItems([]);
    stopStream();
    onClose();
  }, [items, stopStream, onClose]);

  // Android back / back-swipe closes the camera and returns to the inspection
  // (keeping the captured photos), instead of leaving the page.
  useBackToClose(isOpen, () => { void handleDone(); });

  const flipCamera = useCallback(() => {
    lensPinnedRef.current = false; // re-auto-pick the main lens when back on rear
    setLensDeviceId(null); // back to the default lens for the new facing
    setFacing((f) => (f === 'environment' ? 'user' : 'environment'));
    // useEffect on [facing, lensDeviceId] restarts the stream
  }, []);

  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks?.()[0];
    if (!track) return;
    const next = !torchOn;
    const applyTorch = async () => {
      await track.applyConstraints({ advanced: [{ torch: next } as any] });
    };
    try {
      await applyTorch();
      setTorchOn(next);
      setTorchError('');
    } catch (e) {
      // Some Android devices reject the very first apply (capability settles a
      // beat late) \u2014 re-read caps and try once more before giving up.
      try {
        const caps = (track.getCapabilities?.() as any) || {};
        if (caps.torch) {
          await applyTorch();
          setTorchOn(next);
          setTorchError('');
          return;
        }
        throw e;
      } catch (e2) {
        console.warn('[CameraCapture] torch toggle failed:', e2);
        setTorchSupported(false);
        setTorchOn(false);
        setTorchError('Flash isn\u2019t available in-app on this device/lens. Use the phone-camera button (top right) to capture with your phone\u2019s camera (it has its own flash).');
      }
    }
  }, [torchOn]);

  // ----- Render -----

  if (!isOpen) return null;

  const uploadingCount = items.filter((it) => it.status === 'uploading').length;
  const failedCount = items.filter((it) => it.status === 'failed').length;

  // AI status (dot + text) and the Teach/Turn controls — shared so they can sit
  // either on their own row (portrait) or inline on the top bar (landscape).
  const aiStatusContent = (
    <div className="text-[12px] flex items-center gap-1.5 min-w-0">
      {aiOn ? (
        <>
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
            aiStatus?.tone === 'err' ? 'bg-rose-400'
              : aiStatus?.tone === 'think' ? 'bg-violet-400 animate-pulse'
              : aiStatus?.tone === 'heard' ? 'bg-emerald-400 animate-pulse'
              : aiStatus?.tone === 'listen' ? 'bg-emerald-400 animate-pulse'
              : 'bg-white/40'}`} />
          <span className={`truncate ${aiStatus?.tone === 'err' ? 'text-rose-200' : aiStatus?.tone === 'heard' ? 'italic text-emerald-200' : 'text-white/90'}`}>
            {aiStatus?.text || 'Starting AI assist…'}
          </span>
        </>
      ) : (
        <>
          <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-white/40" />
          <span className="truncate text-white/70">AI paused — voice &amp; call-outs off</span>
        </>
      )}
    </div>
  );
  const aiButtons = (
    <div className="flex items-center gap-2 shrink-0">
      {/* Teach the AI — record a voice tip that trains the live knowledge base. */}
      <button
        type="button"
        onClick={() => setKbTrainerOpen(true)}
        className="inline-flex items-center gap-1 text-[11px] font-heading font-semibold px-2.5 py-1 rounded-full border border-white/30 text-white/90 hover:bg-white/10 transition-colors"
        aria-label="Teach the AI"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 10v6M2 10l10-5 10 5-10 5z" /><path d="M6 12v5c3 3 9 3 12 0v-5" /></svg>
        Teach AI
      </button>
      {/* Toggle the AI voice + live call-outs on/off (e.g. on low service). */}
      <button
        type="button"
        onClick={() => setAiOn((v) => !v)}
        className={`text-[11px] font-heading font-semibold px-2.5 py-1 rounded-full border transition-colors ${aiOn ? 'border-white/30 text-white/90 hover:bg-white/10' : 'border-violet-400 bg-violet-600 text-white'}`}
        aria-pressed={aiOn}
      >
        {aiOn ? 'Turn AI off' : 'Turn AI on'}
      </button>
    </div>
  );

  return (
    <div ref={rootRef} className="fixed inset-0 z-50 bg-black flex flex-col select-none overflow-hidden overscroll-none animate-fadeIn">
      {/* AI assist (Beta) — overlay that reads this camera's video + its own mic. */}
      {aiAssist && onAiAddLine && (
        <CameraAILayer
          enabled={aiOn}
          videoRef={videoRef}
          getStream={() => streamRef.current}
          getZoom={() => effZoom()}
          getLastManualCaptureAt={() => lastManualCaptureRef.current}
          onStatus={setAiStatus}
          getActiveRoom={() => {
            const r = rooms?.find((x) => x.id === currentRoomId);
            if (r) return { id: r.id, name: r.name, photoCount: r.photoCount };
            return currentRoomId ? { id: currentRoomId, name: 'Room', photoCount: 0 } : null;
          }}
          rooms={(rooms || []).map((r) => ({ id: r.id, name: r.name }))}
          onNavigateRoom={(id) => { void switchToRoom(id); }}
          region={aiRegion || ''}
          catalog={aiCatalog || []}
          regions={aiRegions || []}
          tenantMonths={aiTenantMonths ?? null}
          addressSnapshot={addressSnapshot || ''}
          propertyRecordId={propertyRecordId}
          uploadPhoto={uploadPhoto}
          onAddLine={onAiAddLine}
          onStill={(sid, url) => onAiStill?.(sid, url)}
        />
      )}
      {/* Top bar — ONE row: Cancel · room navigation (or capture count). No
          "Take Photos" title; the room nav lives inline here in portrait AND
          landscape so the chrome stays one slim line. */}
      <div className="lz-head lz-head-top flex items-center justify-between gap-2 px-3 py-1 bg-black/60 text-white">
        <button
          type="button"
          onClick={handleCancel}
          className="shrink-0 text-sm font-heading font-semibold px-3 py-1.5 rounded-md hover:bg-white/10"
        >
          Cancel
        </button>
        {multiRoom ? (
          <div className="flex-1 min-w-0 flex items-center justify-center gap-1">
            <button type="button" onClick={() => goAdjacentRoom(-1)} aria-label="Previous room"
              className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-white/10 text-2xl leading-none shrink-0">‹</button>
            <button type="button" onClick={() => setRoomMenuOpen((o) => !o)}
              className="min-w-0 flex items-center justify-center gap-2 px-2 py-1 rounded-md hover:bg-white/10">
              <span className="font-heading font-semibold truncate">{currentRoom?.name || 'Room'}</span>
              <span className="text-xs text-white/70 shrink-0">{currentRoom ? `(${currentRoom.photoCount + items.length})` : ''}</span>
              <span className={`text-[10px] transition-transform ${roomMenuOpen ? 'rotate-180' : ''}`}>▼</span>
            </button>
            <button type="button" onClick={() => goAdjacentRoom(1)} aria-label="Next room"
              className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-white/10 text-2xl leading-none shrink-0">›</button>
          </div>
        ) : (
          <div className="flex-1 text-center text-xs font-heading text-white/80 truncate">
            {items.length > 0 ? `${items.length} captured` : ''}
            {uploadingCount > 0 && ` · ${uploadingCount} uploading`}
            {failedCount > 0 && ` · ${failedCount} failed`}
          </div>
        )}
        {/* Landscape: the AI status + controls ride on THIS row (no second row),
            so the header stays a single slim bar. Portrait keeps the spacer
            (the AI strip renders as its own row below). */}
        {aiAssist && isLandscape ? (
          <div className="flex items-center gap-2 shrink-0 min-w-0 max-w-[55%]">
            {aiStatusContent}
            {aiButtons}
          </div>
        ) : (
          <div className="w-14 shrink-0" aria-hidden />
        )}
      </div>

      {/* AI-assist status strip — its OWN row in portrait (width is tight there);
          in landscape it's merged into the top bar above. Out of the live image,
          so the inspector always sees Listening/Thinking/transcript. */}
      {aiAssist && !isLandscape && (
        <div className="lz-head bg-black/75 text-white px-4 py-0.5 flex items-center justify-between gap-2 border-b border-white/10">
          {aiStatusContent}
          {aiButtons}
        </div>
      )}

      {/* Voice "Teach the AI" trainer — records → transcribes → review → add to KB. */}
      <KnowledgeTrainerModal open={kbTrainerOpen} onClose={() => setKbTrainerOpen(false)} />

      {/* Room list dropdown — the ‹ Room (N) ▾ › control now lives in the top
          bar; this just renders the scrollable list, anchored right under it. */}
      {multiRoom && roomMenuOpen && (
        <div className="relative text-white">
          <>
              {/* tap-away backdrop */}
              <button
                type="button"
                aria-label="Close room list"
                onClick={() => setRoomMenuOpen(false)}
                className="fixed inset-0 z-10 cursor-default"
              />
              <div className="absolute left-2 right-2 top-full mt-1 z-20 max-h-[50vh] overflow-y-auto rounded-lg bg-black/90 backdrop-blur border border-white/15 shadow-xl">
                {rooms!.map((r) => {
                  const isCurrent = r.id === currentRoomId;
                  const liveCount = r.photoCount + (isCurrent ? items.length : 0);
                  const isRenaming = renamingRoomId === r.id;
                  return (
                    <div
                      key={r.id}
                      className={`relative flex items-center gap-2 px-3 py-3 border-b border-white/5 last:border-0 ${isCurrent ? 'bg-brand/30' : ''}`}
                    >
                      {isRenaming ? (
                        <input
                          autoFocus
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              const v = renameDraft.trim();
                              if (v && onRenameRoom) onRenameRoom(r.id, v);
                              setRenamingRoomId(null);
                            } else if (e.key === 'Escape') {
                              setRenamingRoomId(null);
                            }
                          }}
                          onBlur={() => {
                            const v = renameDraft.trim();
                            if (v && v !== r.name && onRenameRoom) onRenameRoom(r.id, v);
                            setRenamingRoomId(null);
                          }}
                          className="flex-1 min-w-0 bg-white/10 border border-white/30 rounded px-2 py-1 text-sm text-white"
                        />
                      ) : (
                        <>
                          {/* Full-row tap target to SWITCH rooms (sits behind the
                              name/count; the pencil/delete buttons are layered
                              above it so they remain independently tappable). */}
                          <button
                            type="button"
                            onClick={() => switchToRoom(r.id)}
                            aria-label={`Switch to ${r.name}`}
                            className="absolute inset-0 z-0"
                          />
                          <span className="relative z-10 min-w-0 flex items-center gap-2 pointer-events-none">
                            {isCurrent && <span className="text-brand text-xs shrink-0">●</span>}
                            <span className="truncate font-heading">{r.name}</span>
                          </span>
                          {/* Pencil sits right next to the room name. */}
                          {onRenameRoom && (
                            <button
                              type="button"
                              onClick={() => { setRenamingRoomId(r.id); setRenameDraft(r.name); }}
                              aria-label={`Rename ${r.name}`}
                              className="relative z-10 shrink-0 w-8 h-8 flex items-center justify-center rounded-full hover:bg-white/15 text-white/70"
                            >
                              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M11 1.5l3.5 3.5L5 14.5H1.5V11L11 1.5z" />
                              </svg>
                            </button>
                          )}
                          {/* Count pushed to the right (non-interactive). */}
                          <span className="relative z-10 shrink-0 text-xs ml-auto pointer-events-none">
                            {liveCount > 0
                              ? <span className="text-emerald-400 font-semibold">{liveCount} photo{liveCount === 1 ? '' : 's'}</span>
                              : r.needsPhotos
                                ? <span className="text-amber-400 font-semibold">needs photos</span>
                                : <span className="text-white/40">none</span>}
                          </span>
                        </>
                      )}
                      {/* Delete control */}
                      {!isRenaming && onDeleteRoom && rooms!.length > 1 && (
                        <button
                          type="button"
                          onClick={() => onDeleteRoom(r.id)}
                          aria-label={`Delete ${r.name}`}
                          className="relative z-10 shrink-0 w-8 h-8 flex items-center justify-center rounded-full hover:bg-red-500/30 text-white/70 hover:text-red-300 text-lg leading-none"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  );
                })}
                {/* Add-room footer */}
                {onAddRoom && (
                  <div className="px-3 py-2.5 border-t border-white/15">
                    {addingRoom ? (
                      <div className="flex items-center gap-2">
                        <input
                          autoFocus
                          value={addDraft}
                          onChange={(e) => setAddDraft(e.target.value)}
                          placeholder="New room name…"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              const v = addDraft.trim();
                              if (v) onAddRoom!(v);
                              setAddDraft(''); setAddingRoom(false);
                            } else if (e.key === 'Escape') {
                              setAddDraft(''); setAddingRoom(false);
                            }
                          }}
                          className="flex-1 min-w-0 bg-white/10 border border-white/30 rounded px-2 py-1.5 text-sm text-white"
                        />
                        <button
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            const v = addDraft.trim();
                            if (v) onAddRoom!(v);
                            setAddDraft(''); setAddingRoom(false);
                          }}
                          aria-label="Add room"
                          disabled={!addDraft.trim()}
                          className="shrink-0 w-9 h-9 flex items-center justify-center rounded-full bg-emerald-600 text-white disabled:opacity-40 hover:bg-emerald-500"
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => { setAddDraft(''); setAddingRoom(true); }}
                        className="w-full text-left text-sm text-brand font-semibold py-1"
                      >
                        + Add room
                      </button>
                    )}
                  </div>
                )}
              </div>
            </>
        </div>
      )}

      {/* Body: preview + controls. Column in portrait; in landscape it flips to
          a row so the controls become a right-side rail and the preview fills. */}
      <div className={`flex-1 flex min-h-0 ${isLandscape ? 'flex-row' : 'flex-col'}`}>
      {/* Camera viewport */}
      <div ref={viewportRef} className="flex-1 min-h-0 relative bg-black overflow-hidden"
        onTouchStart={onViewportTouchStart} onTouchMove={onViewportTouchMove}
        onTouchEnd={onViewportTouchEnd} onTouchCancel={onViewportTouchEnd}>
        {permissionState === 'denied' || permissionState === 'unsupported' ? (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
            <div className="text-white max-w-sm">
              <svg className="mx-auto mb-3" width="48" height="48" viewBox="0 0 24 24"
                   fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                <line x1="1" y1="1" x2="23" y2="23" />
              </svg>
              <p className="text-sm font-heading font-semibold mb-2">Camera unavailable</p>
              <p className="text-xs text-white/80 mb-4">{permissionError}</p>
              <div className="flex items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={openNativeCamera}
                  className="bg-brand text-white font-heading font-semibold px-4 py-2 rounded-lg text-sm"
                >
                  Use Phone Camera
                </button>
                <button
                  type="button"
                  onClick={handleCancel}
                  className="bg-white text-black font-heading font-semibold px-4 py-2 rounded-lg text-sm"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              // iOS can PAUSE the live preview after a capture or a brief
              // interruption, leaving it black with nothing to recover it (the
              // 026c935 base had no handler). Replaying the SAME stream on pause
              // resumes it — this NEVER calls getUserMedia, so it can't trigger a
              // permission re-prompt (the problem the heavier recovery had).
              onPause={() => {
                if (recordingRef.current) return;
                if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
                const v = videoRef.current;
                if (v && v.paused) v.play().catch(() => { /* non-fatal */ });
              }}
              className="absolute inset-0 w-full h-full object-cover"
              style={(!hwZoom && zoom > 1) ? { transform: `scale(${zoom})`, transformOrigin: 'center' } : undefined}
            />
            {/* Tap-to-focus reticle */}
            {focusPt && (
              <span
                key={focusPt.key}
                className="pointer-events-none absolute z-20 w-[72px] h-[72px] -ml-9 -mt-9 rounded-full border-2 border-white/95 shadow-[0_0_0_1px_rgba(0,0,0,0.35)] animate-cameraFocus"
                style={{ left: focusPt.x, top: focusPt.y }}
                aria-hidden
              />
            )}
            {permissionState === 'pending' && (
              <div className="absolute inset-0 flex items-center justify-center text-white">
                <div className="text-sm font-heading">Starting camera&hellip;</div>
              </div>
            )}
            {/* Live proximity badge — confirms the device is at the selected
                property before shooting (the same verdict is burned into each
                photo). Top-left; shifts down while recording so it clears the
                REC indicator (also top-left). */}
            {(propertyRecordId || addressSnapshot) && permissionState === 'granted' && (
              <div className={`absolute left-3 z-10 ${recording ? 'top-16' : 'top-3'}`}>
                {proximity.status === 'ok' || proximity.status === 'far' ? (
                  // Tappable so the inspector can force a fresh fix on demand.
                  <button
                    type="button"
                    onClick={startWatch}
                    title="Tap to re-check location"
                    className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-heading font-semibold ${
                      proximity.status === 'ok' ? 'bg-emerald-600/85 text-white' : 'bg-red-600/85 text-white'
                    }`}
                  >
                    <span className="text-sm leading-none">{proximity.status === 'ok' ? '✓' : '✗'}</span>
                    <span className="tabular-nums">
                      {proximity.status === 'ok' ? 'At property' : 'Off-site'} · {fmtDistance(proximity.distance)}
                    </span>
                  </button>
                ) : proximity.status === 'locating' ? (
                  <div className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-heading bg-black/55 text-white/90 pointer-events-none">
                    <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                    Locating…
                  </div>
                ) : (
                  // Tap to retry — re-requests location and re-prompts for
                  // permission if the OS allows it.
                  <button
                    type="button"
                    onClick={startWatch}
                    title="Tap to enable / re-check location"
                    className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-heading font-semibold bg-amber-500/90 text-black"
                  >
                    <span className="text-sm leading-none">⚠</span>
                    {/* Short label so it never overlaps the HD/flip controls. */}
                    <span className="whitespace-nowrap">{proximity.reason}</span>
                  </button>
                )}
              </div>
            )}
            {/* Recording indicator + live zoom */}
            {recording && (
              <>
                <div className="absolute top-3 left-3 z-10 pointer-events-none flex items-center gap-2 bg-black/60 rounded-full px-3 py-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
                  <span className="text-white text-xs font-heading font-semibold tabular-nums">
                    REC {recordSecs}s / {MAX_CLIP_MS / 1000}s
                  </span>
                  {Math.abs(zoom - 1) > 0.02 && (
                    <span className="text-white/90 text-xs font-heading tabular-nums border-l border-white/30 pl-2">
                      {zoom.toFixed(1)}×
                    </span>
                  )}
                </div>
                <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 pointer-events-none bg-black/50 rounded-full px-3 py-1">
                  <span className="text-white/80 text-[11px] font-heading">Slide up/down to zoom</span>
                </div>
              </>
            )}
            {/* Top-right control cluster: phone-camera fallback + flip. */}
            <div className="absolute top-3 right-3 flex items-center gap-2">
              {/* Phone camera fallback. The OS camera has its own working flash,
                  so we badge this with a lightning bolt — tapping it is how you
                  get a flash-capable shot (the in-app live flash is unreliable). */}
              <button
                type="button"
                onClick={openNativeCamera}
                className="relative w-10 h-10 rounded-full bg-black/50 text-white flex items-center justify-center"
                aria-label="Use phone camera (has flash)"
                title="Open your phone's camera — it has a working flash"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
                {/* Lightning-bolt badge (bottom-right) — signals "flash here". */}
                <span className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-amber-400 text-black flex items-center justify-center ring-1 ring-black/40">
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                  </svg>
                </span>
              </button>
              {/* Flip camera */}
              <button
                type="button"
                onClick={flipCamera}
                className="w-10 h-10 rounded-full bg-black/50 text-white flex items-center justify-center"
                aria-label="Flip camera"
                title="Switch front/back camera"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
                  <polyline points="21 3 21 8 16 8" />
                  <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
                  <polyline points="3 21 3 16 8 16" />
                </svg>
              </button>
            </div>
          </>
        )}
      </div>

      {/* Captured-photo strip. Portrait: a horizontal row under the preview.
          Landscape: a VERTICAL column between the preview and the control rail
          that fills the height and scrolls vertically — so 12+ shots stack and
          scroll instead of running off the side. */}
      {items.length > 0 && (
        <div ref={stripRef} className={`bg-black/80 ${isLandscape ? 'overflow-y-auto w-[88px] shrink-0 px-2 py-2 min-h-0' : 'overflow-x-auto px-3 py-2'}`}>
          <div className={`flex gap-2 ${isLandscape ? 'flex-col items-center' : ''}`}>
            {items.map((it) => (
              <div key={it.id} className="relative shrink-0">
                {/* Self-healing tile: small local thumb first (tiny + reliable),
                    then the full image, then a neutral box — never a broken glyph. */}
                <SelfHealingImg
                  primary={it.thumbUrl || it.blobUrl}
                  fallback={displayImageSrc(it.hubspotUrl && !it.hubspotUrl.startsWith('blob:') ? it.hubspotUrl : it.blobUrl)}
                  alt=""
                  onClick={() => {
                    // Photos AND videos share one swipeable gallery now.
                    const idx = items.findIndex((p) => p.id === it.id);
                    if (idx >= 0) setViewerIndex(idx);
                  }}
                  className="w-16 h-16 object-cover rounded border border-white/20 cursor-pointer"
                  title={it.kind === 'video' ? 'Tap to play clip' : 'Tap to view'}
                />
                {it.kind === 'video' && (
                  <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <span className="w-6 h-6 rounded-full bg-black/55 flex items-center justify-center">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z" /></svg>
                    </span>
                  </span>
                )}
                {/* Status overlay. Queue-first → a shot is saved to the local queue
                    instantly and shown as a draft, so instead of a spinner we show
                    the same "Syncing…" (online) / "Saved Offline" (offline) banner
                    Android uses; it flips to a green check once it actually lands on
                    HubSpot, and to a Retry button only on a hard failure. */}
                {it.status === 'failed' ? (
                  <button
                    type="button"
                    onClick={() => retryUpload(it.id)}
                    className="absolute inset-0 bg-red-600/70 rounded flex items-center justify-center text-white text-[10px] font-heading font-bold"
                    title={`Failed: ${it.error}. Tap to retry.`}
                  >
                    Retry
                  </button>
                ) : (it.status === 'uploading' || (!!it.hubspotUrl && it.hubspotUrl.startsWith('blob:'))) ? (
                  <SyncingBadge />
                ) : it.status === 'uploaded' ? (
                  <div className="absolute bottom-0 right-0 w-4 h-4 bg-green-500 rounded-full flex items-center justify-center border-2 border-black">
                    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white"
                         strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </div>
                ) : null}
                {/* Delete button */}
                <button
                  type="button"
                  onClick={() => deletePhoto(it.id)}
                  className="absolute top-0 right-0 z-10 w-6 h-6 bg-white text-black rounded-full flex items-center justify-center text-sm font-bold shadow"
                  aria-label="Delete photo"
                  title="Delete this photo"
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Torch error / iOS guidance (if a torch attempt failed) */}
      {torchError && (
        <div className="bg-amber-500/90 text-black text-xs font-heading text-center px-4 py-1.5">
          {torchError}
        </div>
      )}

      {/* Shutter row. `relative` so the voice assistant's pop-up panel (anchored
          bottom-full to the mic) floats above this bar and stays on-screen. */}
      <div className={`lz-foot relative shrink-0 bg-black ${isLandscape ? 'self-stretch flex flex-col items-center justify-center gap-6 px-2 py-4' : 'flex items-center justify-center gap-8 px-4 py-4'}`}>
        {/* Gallery — pick one or more existing photos from the device (replaces
            the separate "Upload" button that used to live on the form). */}
        <button
          type="button"
          onClick={openGallery}
          disabled={busy}
          className="relative flex flex-col items-center text-white/90 disabled:opacity-40"
          aria-label="Choose photos from your gallery"
          title="Upload photos from your gallery"
        >
          <span className="w-11 h-11 rounded-full bg-white/15 flex items-center justify-center">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
          </span>
          {/* Label sits OUTSIDE layout flow so the icon — not the icon+label box —
              is what aligns with the shutter / Mark / Done. */}
          <span className="absolute top-full mt-0.5 text-[10px] font-heading">Gallery</span>
        </button>

        <button
          type="button"
          onPointerDown={onShutterDown}
          onPointerMove={onShutterMove}
          onPointerUp={onShutterUp}
          onPointerCancel={onShutterUp}
          onContextMenu={(e) => e.preventDefault()}
          disabled={busy || permissionState !== 'granted'}
          className={`lz-shutter relative w-16 h-16 rounded-full border-4 disabled:opacity-30 active:scale-95 transition select-none ${
            recording ? 'bg-red-600 border-red-500 ring-2 ring-red-400 scale-110' : 'bg-white border-white ring-2 ring-white/50'
          }`}
          style={{ touchAction: 'none' }}
          aria-label={recording ? 'Stop recording' : 'Take photo (hold to record video)'}
          title="Tap for photo · press and hold for video"
        >
          {recording ? (
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="block w-6 h-6 rounded-sm bg-white" />
            </span>
          ) : (
            <span className="block w-full h-full rounded-full bg-white" />
          )}
        </button>

        {/* Mark/annotate the most recent photo (right of shutter). */}
        <button
          type="button"
          onClick={() => { const last = [...items].reverse().find((p) => p.kind !== 'video'); if (last) setAnnotatingId(last.id); }}
          disabled={items.filter((p) => p.kind !== 'video').length === 0}
          className="relative flex flex-col items-center text-white/90 disabled:opacity-30"
          aria-label="Mark up the last photo"
          title="Draw on the last photo (arrow, circle, pen)"
        >
          <span className="w-11 h-11 rounded-full bg-white/15 flex items-center justify-center">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19l7-7 3 3-7 7-3-3z" />
              <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
              <path d="M2 2l7.586 7.586" />
              <circle cx="11" cy="11" r="2" />
            </svg>
          </span>
          <span className="absolute top-full mt-0.5 text-[10px] font-heading">Mark</span>
        </button>

        {/* Done — bottom-right of the shutter line (moved from the top bar). */}
        <button
          type="button"
          onClick={handleDone}
          className={`text-sm font-heading font-bold px-4 py-2 rounded-md bg-brand text-white hover:bg-brand-dark ${isLandscape ? '' : 'absolute right-4 top-1/2 -translate-y-1/2'}`}
        >
          Done
        </button>
      </div>
      </div>{/* end camera body */}

      {/* Hidden native camera input (capture opens the OS camera on mobile) */}
      <input
        ref={nativeInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        className="hidden"
        onChange={(e) => { handleNativeFiles(e.target.files); e.currentTarget.value = ''; }}
      />
      {/* Hidden gallery input — NO capture attr, so it opens the photo library
          for multi-select rather than the camera. */}
      <input
        ref={galleryInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => { handleNativeFiles(e.target.files); e.currentTarget.value = ''; }}
      />

      {/* Swipeable viewer for captured photos AND videos (markup is opt-in) */}
      {viewerIndex !== null && items.length > 0 && (() => {
        // ONE swipeable gallery for photos AND videos (matches Android). Videos
        // are passed as poster#v=video composite entries — PhotoLightbox plays the
        // clip on the active slide and shows the poster for neighbors. Index maps
        // directly into `items` (no photo-only filtering).
        const entries = items.map((it) =>
          it.kind === 'video' && it.videoUrl ? makeVideoEntry(it.blobUrl, it.videoUrl) : it.blobUrl);
        const idx = Math.min(viewerIndex, items.length - 1);
        return (
          <PhotoLightbox
            groups={[{ id: 'session', name: 'Captures' }]}
            photosByGroup={{ session: entries }}
            initialGroupId="session"
            initialIndex={idx}
            onClose={() => setViewerIndex(null)}
            onDelete={(_g, i) => { const t = items[i]; if (t) deletePhoto(t.id); }}
            onReplace={(_g, i, file) => { const t = items[i]; if (t) handleAnnotated(t.id, file); }}
            // Tag-to-line — only when the active room actually has line items.
            tagLinesByGroup={tagLines && tagLines.length > 0 ? { session: tagLines } : undefined}
            onTagToLine={tagLines && tagLines.length > 0 && onTagPhotoToLine
              ? (_g, i, lineId) => {
                  const target = items[i];
                  if (!target) return;
                  if (target.status !== 'uploaded' || !target.hubspotUrl) {
                    void dialog.alert('This capture is still uploading — tag it again in a moment.');
                    return;
                  }
                  const prevUrl = target.hubspotUrl;
                  onTagPhotoToLine(prevUrl, lineId).then((stamped) => {
                    if (stamped && stamped !== prevUrl) {
                      setItems((cur) => cur.map((it) => (it.id === target.id ? { ...it, hubspotUrl: stamped } : it)));
                    }
                  }).catch((e) => console.warn('[CameraCapture] tag-to-line failed:', e));
                }
              : undefined}
          />
        );
      })()}

      {/* Markup editor (explicit "Mark" action) */}
      {annotatingId && (() => {
        const it = items.find((x) => x.id === annotatingId);
        if (!it) return null;
        return (
          <PhotoAnnotator
            src={it.blobUrl}
            onCancel={() => setAnnotatingId(null)}
            onSave={(file) => handleAnnotated(annotatingId, file)}
          />
        );
      })()}
    </div>
  );
}
