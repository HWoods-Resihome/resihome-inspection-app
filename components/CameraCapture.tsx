import { useCallback, useEffect, useRef, useState } from 'react';

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

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onComplete: (hubspotUrls: string[]) => void;
  // Reuses the parent's upload helper (compression + HubSpot Files API).
  // Returning the HubSpot URL on success.
  uploadPhoto: (file: File) => Promise<string>;
  // Optional cap on number of photos in a single session
  maxPhotos?: number;
}

// Target capture resolution: 1920x1440 (4:3). Browser may downgrade if
// the device can't do it, that's OK.
const CAPTURE_WIDTH = 1920;
const CAPTURE_HEIGHT = 1440;

// JPEG quality (0..1). 0.88 is a good balance of file size vs visual quality.
const JPEG_QUALITY = 0.88;

export function CameraCapture({
  isOpen, onClose, onComplete, uploadPhoto, maxPhotos = 30,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [items, setItems] = useState<CaptureItem[]>([]);
  // Mirror items in a ref so async code (handleDone polling) can read the
  // latest value without depending on state closures.
  const itemsRef = useRef<CaptureItem[]>([]);
  useEffect(() => { itemsRef.current = items; }, [items]);

  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  const [permissionState, setPermissionState] = useState<'pending' | 'granted' | 'denied' | 'unsupported'>('pending');
  const [permissionError, setPermissionError] = useState<string>('');
  const [busy, setBusy] = useState(false);

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

  // ----- Capture -----

  const capturePhoto = useCallback(async () => {
    if (busy) return;
    if (items.length >= maxPhotos) {
      alert(`You can capture up to ${maxPhotos} photos per session. Tap Done to finish.`);
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
      const blobUrl = URL.createObjectURL(blob);
      const abortController = new AbortController();

      const item: CaptureItem = {
        id, blobUrl, file, status: 'uploading', abortController,
      };
      // Add to state immediately (optimistic) - thumbnail appears at once
      setItems((prev) => [...prev, item]);

      // Kick off the upload in the background. We don't await it here so the
      // shutter unblocks immediately for the next shot.
      uploadPhoto(file).then((hubspotUrl) => {
        if (abortController.signal.aborted) return; // user deleted this photo
        setItems((prev) =>
          prev.map((it) =>
            it.id === id ? { ...it, status: 'uploaded', hubspotUrl } : it
          )
        );
      }).catch((err) => {
        if (abortController.signal.aborted) return;
        setItems((prev) =>
          prev.map((it) =>
            it.id === id ? { ...it, status: 'failed', error: err?.message || String(err) } : it
          )
        );
      });
    } catch (e: any) {
      console.error('Capture error:', e);
    } finally {
      setBusy(false);
    }
  }, [busy, items.length, maxPhotos, uploadPhoto]);

  // ----- Per-photo retake/delete -----

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

  const handleDone = useCallback(async () => {
    // If any uploads are still in flight, wait for them. Hard ceiling: 60 seconds.
    const startedAt = Date.now();
    const TIMEOUT_MS = 60_000;

    while (Date.now() - startedAt < TIMEOUT_MS) {
      const current = itemsRef.current;
      const stillUploading = current.some((it) => it.status === 'uploading');
      if (!stillUploading) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    const finalItems = itemsRef.current;
    const urls = finalItems
      .filter((it) => it.status === 'uploaded' && it.hubspotUrl)
      .map((it) => it.hubspotUrl!) as string[];

    const failures = finalItems.filter((it) => it.status !== 'uploaded').length;
    if (failures > 0) {
      const ok = confirm(
        `${failures} photo${failures === 1 ? '' : 's'} did not upload successfully. ` +
        `Continue with the ${urls.length} that succeeded?`
      );
      if (!ok) return;
    }

    // Clean up object URLs
    for (const it of finalItems) {
      try { URL.revokeObjectURL(it.blobUrl); } catch { /* harmless */ }
    }
    setItems([]);
    stopStream();
    onComplete(urls);
  }, [onComplete, stopStream]);

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

  // ----- Render -----

  if (!isOpen) return null;

  const uploadingCount = items.filter((it) => it.status === 'uploading').length;
  const failedCount = items.filter((it) => it.status === 'failed').length;

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
          disabled={items.length === 0}
          className="text-sm font-heading font-bold px-3 py-1.5 rounded-md bg-brand text-white disabled:bg-gray-600 disabled:text-gray-400"
        >
          Done
        </button>
      </div>

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
              <button
                type="button"
                onClick={handleCancel}
                className="bg-white text-black font-heading font-semibold px-4 py-2 rounded-lg text-sm"
              >
                Close
              </button>
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
                  className="w-16 h-16 object-cover rounded border border-white/20"
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

      {/* Shutter row */}
      <div className="bg-black px-4 py-4 flex items-center justify-center">
        <button
          type="button"
          onClick={capturePhoto}
          disabled={busy || permissionState !== 'granted'}
          className="w-16 h-16 rounded-full bg-white border-4 border-white ring-2 ring-white/50 disabled:opacity-30 active:scale-95 transition"
          aria-label="Take photo"
        >
          <span className="block w-full h-full rounded-full bg-white" />
        </button>
      </div>
    </div>
  );
}
