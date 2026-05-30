import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppDialog } from '@/components/AppDialog';
import { PhotoAnnotator } from '@/components/PhotoAnnotator';

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
  blobUrl: string;               // object URL for local preview thumbnail
  file: File;                    // the captured file
  status: 'uploading' | 'uploaded' | 'failed';
  hubspotUrl?: string;           // populated when upload succeeds
  error?: string;                // populated when upload fails
  abortController?: AbortController;
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
  const fontSize = Math.max(16, Math.round(w / 54));
  const lineH = Math.round(fontSize * 1.34);
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
    ctx.fillStyle = '#ffffff';
    ctx.fillText(row.text, pad, y);
    if (row.mark) {
      const x = pad + ctx.measureText(row.text + '  ').width;
      ctx.fillStyle = row.mark === 'ok' ? '#34d399' : '#f87171';
      ctx.fillText(row.mark === 'ok' ? '✓' : '✗', x, y);
    }
    y += lineH;
  }
  ctx.restore();
}

// Distance in meters between two lat/lng points (haversine).
function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// How close the GPS fix must be to the geocoded property to count as a match.
// Generous on purpose: address geocoding (street centroid) and indoor GPS each
// carry error, so this is meant to catch gross mismatches (wrong property/city),
// not pinpoint accuracy.
const GEO_MATCH_RADIUS_M = 300;

// Target capture resolution: 1920x1440 (4:3). Browser may downgrade if
// the device can't do it, that's OK.
const CAPTURE_WIDTH = 1920;
const CAPTURE_HEIGHT = 1440;

// JPEG quality (0..1). 0.88 is a good balance of file size vs visual quality.
const JPEG_QUALITY = 0.88;

export function CameraCapture({
  isOpen, onClose, onComplete, uploadPhoto, maxPhotos = 30,
  rooms, currentRoomId, onRoomChange, onRenameRoom, onDeleteRoom, onAddRoom,
  addressSnapshot, propertyRecordId,
}: Props) {
  const dialog = useAppDialog();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Latest GPS fix, kept fresh while the camera is open, burned into captures.
  const geoRef = useRef<GeolocationPosition | null>(null);
  const geoWatchRef = useRef<number | null>(null);
  // Geocoded coordinates of the property address (reference point for the
  // ✓/✗ location check). Null until resolved; stays null if geocoding fails.
  const refCoordsRef = useRef<{ lat: number; lng: number } | null>(null);
  const geocodedAddrRef = useRef<string | null>(null);
  const geocodeInFlightRef = useRef(false);
  // Mirrors of the above into state so the live location HUD can render and
  // explain *why* a photo can or can't be ✓/✗ verified.
  const [geoFix, setGeoFix] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [geoDenied, setGeoDenied] = useState(false);
  const [refCoords, setRefCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [geocodeState, setGeocodeState] = useState<'idle' | 'pending' | 'ok' | 'failed'>('idle');

  const [items, setItems] = useState<CaptureItem[]>([]);
  // Mirror items in a ref so async code (handleDone polling) can read the
  // latest value without depending on state closures.
  const itemsRef = useRef<CaptureItem[]>([]);
  useEffect(() => { itemsRef.current = items; }, [items]);

  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  const [permissionState, setPermissionState] = useState<'pending' | 'granted' | 'denied' | 'unsupported'>('pending');
  const [permissionError, setPermissionError] = useState<string>('');
  const [busy, setBusy] = useState(false);
  // Id of the captured photo currently open in the annotator (null = closed).
  const [annotatingId, setAnnotatingId] = useState<string | null>(null);
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
      const constraints: MediaStreamConstraints = {
        video: {
          facingMode: { ideal: facing },
          width: { ideal: CAPTURE_WIDTH },
          height: { ideal: CAPTURE_HEIGHT },
        },
        audio: false,
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => { /* play() may reject silently if autoplay is blocked; not fatal */ });
      }
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
      // Check now, after metadata, and once more on a delay to catch late caps.
      checkTorch();
      if (videoRef.current) {
        videoRef.current.addEventListener('loadedmetadata', () => {
          checkTorch();
          setTimeout(checkTorch, 600);
        }, { once: true });
      }
      setTimeout(checkTorch, 800);
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
  }, [facing, stopStream]);

  // Mount/unmount: start/stop the camera stream
  useEffect(() => {
    if (isOpen) {
      startStream();
    } else {
      stopStream();
    }
    return () => stopStream();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, facing]);

  // While the camera is open, keep a fresh GPS fix so each shot can be stamped.
  // Best-effort: if the user denies location or it's unavailable, we just stamp
  // address + time without coordinates.
  useEffect(() => {
    if (!isOpen || typeof navigator === 'undefined' || !navigator.geolocation) { setGeoDenied(true); return; }
    const onPos = (pos: GeolocationPosition) => {
      geoRef.current = pos;
      setGeoDenied(false);
      const { latitude, longitude, accuracy } = pos.coords;
      setGeoFix({ lat: latitude, lng: longitude, accuracy });
    };
    const onErr = (err: GeolocationPositionError) => {
      // code 1 = permission denied; 2/3 = unavailable/timeout. Either way we
      // can't stamp a verdict — surface it in the HUD instead of failing silently.
      if (err && err.code === 1) setGeoDenied(true);
    };
    navigator.geolocation.getCurrentPosition(onPos, onErr, {
      enableHighAccuracy: true, timeout: 8000, maximumAge: 30000,
    });
    try {
      geoWatchRef.current = navigator.geolocation.watchPosition(onPos, onErr, {
        enableHighAccuracy: true, timeout: 20000, maximumAge: 15000,
      });
    } catch { /* watchPosition unsupported — getCurrentPosition fix still applies */ }
    return () => {
      if (geoWatchRef.current != null) {
        try { navigator.geolocation.clearWatch(geoWatchRef.current); } catch { /* noop */ }
        geoWatchRef.current = null;
      }
      geoRef.current = null;
    };
  }, [isOpen]);

  // Geocode the property address once (when the camera opens) to get a
  // reference point for the GPS ✓/✗ check. Best-effort: on failure we simply
  // stamp coordinates without a verdict.
  useEffect(() => {
    if (!isOpen || (!addressSnapshot && !propertyRecordId)) return;
    const key = `${propertyRecordId || ''}|${addressSnapshot || ''}`;
    if (geocodedAddrRef.current === key || geocodeInFlightRef.current) return;
    geocodeInFlightRef.current = true;
    setGeocodeState('pending');
    let cancelled = false;
    const params = new URLSearchParams();
    if (addressSnapshot) params.set('address', addressSnapshot);
    if (propertyRecordId) params.set('propertyId', propertyRecordId);
    fetch(`/api/geocode?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return;
        if (d && typeof d.lat === 'number' && typeof d.lng === 'number') {
          refCoordsRef.current = { lat: d.lat, lng: d.lng };
          geocodedAddrRef.current = key;
          setRefCoords({ lat: d.lat, lng: d.lng });
          setGeocodeState('ok');
        } else {
          setGeocodeState('failed'); // address couldn't be resolved → no reference
        }
      })
      .catch(() => { if (!cancelled) setGeocodeState('failed'); })
      .finally(() => { geocodeInFlightRef.current = false; });
    return () => { cancelled = true; };
  }, [isOpen, addressSnapshot, propertyRecordId]);

  // ----- Capture -----

  // Upload one File through the background pipeline + optimistic thumbnail.
  // Shared by the in-app shutter and the native-camera fallback.
  const enqueueFile = useCallback((file: File) => {
    const id = `${Date.now()}_${(typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 8)}`;
    const blobUrl = URL.createObjectURL(file);
    const abortController = new AbortController();
    const item: CaptureItem = { id, blobUrl, file, status: 'uploading', abortController };
    setItems((prev) => [...prev, item]);
    uploadPhoto(file).then((hubspotUrl) => {
      if (abortController.signal.aborted) return;
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, status: 'uploaded', hubspotUrl } : it)));
    }).catch((err) => {
      if (abortController.signal.aborted) return;
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, status: 'failed', error: err?.message || String(err) } : it)));
    });
  }, [uploadPhoto]);

  // Native OS camera fallback. On iOS (no web torch) and as a universal
  // backup, this opens the phone's built-in camera — which has its own flash
  // control — via a file input with capture. Picked photos flow through the
  // same upload pipeline and thumbnails as in-app shots.
  const nativeInputRef = useRef<HTMLInputElement | null>(null);
  const openNativeCamera = useCallback(() => {
    nativeInputRef.current?.click();
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

  const capturePhoto = useCallback(async () => {
    if (busy) return;
    if (items.length >= maxPhotos) {
      void dialog.alert(`You can capture up to ${maxPhotos} photos per session. Tap Done to finish.`);
      return;
    }
    const video = videoRef.current;
    if (!video || video.readyState < 2) {
      // Video not ready yet; let the user try again in a moment
      return;
    }
    setBusy(true);
    try {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) {
        setBusy(false);
        return;
      }
      const canvas = document.createElement('canvas');
      canvas.width = vw;
      canvas.height = vh;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        setBusy(false);
        return;
      }
      ctx.drawImage(video, 0, 0, vw, vh);
      // Burn the evidence stamp (address / timestamp / GPS) into the frame.
      // The GPS line gets a ✓/✗ when we have geocoded the property to compare.
      const stampLines: StampLine[] = [];
      if (addressSnapshot) stampLines.push({ text: addressSnapshot });
      stampLines.push({ text: new Date().toLocaleString() });
      const pos = geoRef.current;
      if (pos) {
        const { latitude, longitude, accuracy } = pos.coords;
        let mark: 'ok' | 'bad' | undefined;
        const ref = refCoordsRef.current;
        if (ref) {
          const dist = haversineMeters(latitude, longitude, ref.lat, ref.lng);
          mark = dist <= GEO_MATCH_RADIUS_M ? 'ok' : 'bad';
        }
        stampLines.push({
          text: `${latitude.toFixed(5)}, ${longitude.toFixed(5)} (±${Math.round(accuracy)}m)`,
          mark,
        });
      }
      drawEvidenceStamp(ctx, vw, vh, stampLines);
      // Convert to JPEG blob
      const blob: Blob | null = await new Promise((resolve) => {
        canvas.toBlob((b) => resolve(b), 'image/jpeg', JPEG_QUALITY);
      });
      if (!blob) {
        setBusy(false);
        return;
      }
      const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const file = new File([blob], `capture_${id}.jpg`, { type: 'image/jpeg' });
      enqueueFile(file);
    } catch (e: any) {
      console.error('Capture error:', e);
    } finally {
      setBusy(false);
    }
  }, [busy, items.length, maxPhotos, enqueueFile, addressSnapshot]);

  // ----- Per-photo retake/delete -----

  // Save annotations: swap in the marked-up file, show it immediately, and
  // re-upload (the un-annotated HubSpot file is left orphaned — the inspection
  // uses the new URL).
  const handleAnnotated = useCallback((id: string, file: File) => {
    const newBlobUrl = URL.createObjectURL(file);
    setItems((prev) => prev.map((it) => {
      if (it.id !== id) return it;
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
      // Kick off the upload again (fire-and-forget; state update happens in the .then)
      uploadPhoto(target.file).then((hubspotUrl) => {
        if (newAbort.signal.aborted) return;
        setItems((cur) =>
          cur.map((it) => (it.id === id ? { ...it, status: 'uploaded', hubspotUrl } : it))
        );
      }).catch((err) => {
        if (newAbort.signal.aborted) return;
        setItems((cur) =>
          cur.map((it) => (it.id === id ? { ...it, status: 'failed', error: err?.message || String(err) } : it))
        );
      });
      return next;
    });
  }, [uploadPhoto]);

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
    const urls = finalItems
      .filter((it) => it.status === 'uploaded' && it.hubspotUrl)
      .map((it) => it.hubspotUrl!) as string[];
    const failures = finalItems.filter((it) => it.status !== 'uploaded').length;
    for (const it of finalItems) {
      try { URL.revokeObjectURL(it.blobUrl); } catch { /* harmless */ }
    }
    setItems([]);
    return { urls, failures };
  }, []);

  const [roomMenuOpen, setRoomMenuOpen] = useState(false);
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
    // Abort all in-flight uploads and discard all photos
    for (const it of items) {
      it.abortController?.abort();
      try { URL.revokeObjectURL(it.blobUrl); } catch { /* harmless */ }
    }
    setItems([]);
    stopStream();
    onClose();
  }, [items, stopStream, onClose]);

  const flipCamera = useCallback(() => {
    setFacing((f) => (f === 'environment' ? 'user' : 'environment'));
    // useEffect on [facing] will restart the stream
  }, []);

  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks?.()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as any] });
      setTorchOn(next);
      setTorchError('');
    } catch (e) {
      // We optimistically showed the button; this device can't actually do
      // torch via the web API. Hide it and point the user to the OS camera.
      console.warn('[CameraCapture] torch toggle failed:', e);
      setTorchSupported(false);
      setTorchOn(false);
      setTorchError('Flash isn\u2019t available in-app on this device. Use "Photo Library / Camera" below for your phone\u2019s camera with flash.');
    }
  }, [torchOn]);

  // ----- Render -----

  if (!isOpen) return null;

  const uploadingCount = items.filter((it) => it.status === 'uploading').length;
  const failedCount = items.filter((it) => it.status === 'failed').length;

  // Live location-verification status for the HUD chip. Mirrors exactly what the
  // burned-in ✓/✗ stamp will (or won't) say, so the inspector sees the cause.
  const locHud: { tone: 'ok' | 'bad' | 'wait' | 'warn'; text: string } = (() => {
    if (geoDenied) return { tone: 'warn', text: 'Location off — enable GPS to verify' };
    if (!geoFix) return { tone: 'wait', text: 'Locating…' };
    if (geocodeState === 'pending') return { tone: 'wait', text: 'Checking address…' };
    if (geocodeState !== 'ok' || !refCoords) return { tone: 'warn', text: "Can't verify address (GPS only)" };
    const m = haversineMeters(geoFix.lat, geoFix.lng, refCoords.lat, refCoords.lng);
    return m <= GEO_MATCH_RADIUS_M
      ? { tone: 'ok', text: 'At property ✓' }
      : { tone: 'bad', text: `Not at property ✗ (~${m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`})` };
  })();
  const locHudClasses = {
    ok: 'bg-emerald-600/85 text-white',
    bad: 'bg-red-600/85 text-white',
    wait: 'bg-black/60 text-white/90',
    warn: 'bg-amber-500/90 text-black',
  }[locHud.tone];

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col select-none">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3 bg-black/60 text-white">
        <button
          type="button"
          onClick={handleCancel}
          className="text-sm font-heading font-semibold px-3 py-1.5 rounded-md hover:bg-white/10"
        >
          Cancel
        </button>
        <div className="text-xs font-heading text-white/80">
          {items.length === 0 ? 'Take Photos' : `${items.length} captured`}
          {uploadingCount > 0 && ` · ${uploadingCount} uploading`}
          {failedCount > 0 && ` · ${failedCount} failed`}
        </div>
        <button
          type="button"
          onClick={handleDone}
          className="text-sm font-heading font-bold px-3 py-1.5 rounded-md bg-brand text-white hover:bg-brand-dark"
        >
          Done
        </button>
      </div>

      {/* Room switcher (multi-room mode): ‹ Room Name (N) › — name opens a
          scrollable room list showing photo counts and which rooms still need
          photos, so the inspector can shoot the whole house without leaving. */}
      {multiRoom && (
        <div className="relative bg-black/70 text-white border-b border-white/10">
          <div className="flex items-center justify-between px-3 py-2 gap-2">
            <button
              type="button"
              onClick={() => goAdjacentRoom(-1)}
              aria-label="Previous room"
              className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-white/10 text-2xl leading-none shrink-0"
            >
              ‹
            </button>
            <button
              type="button"
              onClick={() => setRoomMenuOpen((o) => !o)}
              className="flex-1 min-w-0 flex items-center justify-center gap-2 px-3 py-1.5 rounded-md hover:bg-white/10"
            >
              <span className="font-heading font-semibold truncate">{currentRoom?.name || 'Room'}</span>
              <span className="text-xs text-white/70 shrink-0">
                {currentRoom ? `(${currentRoom.photoCount + items.length})` : ''}
              </span>
              <span className={`text-[10px] transition-transform ${roomMenuOpen ? 'rotate-180' : ''}`}>▼</span>
            </button>
            <button
              type="button"
              onClick={() => goAdjacentRoom(1)}
              aria-label="Next room"
              className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-white/10 text-2xl leading-none shrink-0"
            >
              ›
            </button>
          </div>

          {roomMenuOpen && (
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
          )}
        </div>
      )}

      {/* Camera viewport */}
      <div className="flex-1 relative bg-black overflow-hidden">
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
              className="absolute inset-0 w-full h-full object-cover"
            />
            {permissionState === 'pending' && (
              <div className="absolute inset-0 flex items-center justify-center text-white">
                <div className="text-sm font-heading">Starting camera&hellip;</div>
              </div>
            )}
            {/* Live location-verification chip (matches the ✓/✗ burned into shots) */}
            {permissionState === 'granted' && (
              <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
                <span className={`px-3 py-1.5 rounded-full text-xs font-heading font-semibold shadow ${locHudClasses}`}>
                  {locHud.text}
                </span>
              </div>
            )}
            {/* Flip camera button (top right of viewport) */}
            <button
              type="button"
              onClick={flipCamera}
              className="absolute top-3 right-3 w-10 h-10 rounded-full bg-black/50 text-white flex items-center justify-center"
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
            {/* Flash / torch toggle — only shown when the device supports it */}
            {torchSupported && (
              <button
                type="button"
                onClick={toggleTorch}
                className={
                  'absolute top-3 right-16 w-10 h-10 rounded-full flex items-center justify-center transition ' +
                  (torchOn ? 'bg-amber-400 text-black' : 'bg-black/50 text-white')
                }
                aria-label={torchOn ? 'Turn flash off' : 'Turn flash on'}
                aria-pressed={torchOn}
                title={torchOn ? 'Flash on (tap to turn off)' : 'Flash off (tap to turn on)'}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill={torchOn ? 'currentColor' : 'none'}
                     stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                </svg>
              </button>
            )}
          </>
        )}
      </div>

      {/* Thumbnail strip */}
      {items.length > 0 && (
        <div className="bg-black/80 px-3 py-2 overflow-x-auto">
          <div className="flex gap-2">
            {items.map((it) => (
              <div key={it.id} className="relative shrink-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={it.blobUrl}
                  alt=""
                  onClick={() => setAnnotatingId(it.id)}
                  className="w-16 h-16 object-cover rounded border border-white/20 cursor-pointer"
                  title="Tap to mark up"
                />
                {/* Status overlay */}
                {it.status === 'uploading' && (
                  <div className="absolute inset-0 bg-black/60 rounded flex items-center justify-center">
                    <svg className="animate-spin" width="20" height="20" viewBox="0 0 24 24"
                         fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                    </svg>
                  </div>
                )}
                {it.status === 'failed' && (
                  <button
                    type="button"
                    onClick={() => retryUpload(it.id)}
                    className="absolute inset-0 bg-red-600/70 rounded flex items-center justify-center text-white text-[10px] font-heading font-bold"
                    title={`Failed: ${it.error}. Tap to retry.`}
                  >
                    Retry
                  </button>
                )}
                {it.status === 'uploaded' && (
                  <div className="absolute bottom-0 right-0 w-4 h-4 bg-green-500 rounded-full flex items-center justify-center border-2 border-black">
                    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white"
                         strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </div>
                )}
                {/* Delete button */}
                <button
                  type="button"
                  onClick={() => deletePhoto(it.id)}
                  className="absolute -top-1 -right-1 w-5 h-5 bg-white text-black rounded-full flex items-center justify-center text-xs font-bold shadow"
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

      {/* Shutter row */}
      <div className="bg-black px-4 py-4 flex items-center justify-center gap-8">
        {/* Phone camera fallback (left of shutter). Always available: gives iOS
            users a flash-capable camera, and is a universal backup if the live
            camera struggles. */}
        <button
          type="button"
          onClick={openNativeCamera}
          className="flex flex-col items-center gap-1 text-white/90"
          aria-label="Use phone camera (with flash)"
          title="Open your phone's camera (has its own flash)"
        >
          <span className="w-11 h-11 rounded-full bg-white/15 flex items-center justify-center">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
          </span>
          <span className="text-[10px] font-heading">Phone Cam</span>
        </button>

        <button
          type="button"
          onClick={capturePhoto}
          disabled={busy || permissionState !== 'granted'}
          className="w-16 h-16 rounded-full bg-white border-4 border-white ring-2 ring-white/50 disabled:opacity-30 active:scale-95 transition"
          aria-label="Take photo"
        >
          <span className="block w-full h-full rounded-full bg-white" />
        </button>

        {/* Mark/annotate the most recent photo (right of shutter). */}
        <button
          type="button"
          onClick={() => { const last = items[items.length - 1]; if (last) setAnnotatingId(last.id); }}
          disabled={items.length === 0}
          className="flex flex-col items-center gap-1 text-white/90 disabled:opacity-30"
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
          <span className="text-[10px] font-heading">Mark</span>
        </button>
      </div>

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

      {/* Markup editor for a captured photo */}
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
