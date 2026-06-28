/**
 * Photo upload helpers shared between QuestionForm and RateCardForm.
 *
 * The pattern:
 *   1. Compress with browser-image-compression (≤2MB target, 3024px max edge, q0.9).
 *      Inspectors zoom into these photos to check fine defects (cracks, scuffs),
 *      so we keep near-native ~9MP detail rather than crushing to a screen size.
 *      The /api/upload body limit is 48MB, so there's ample headroom even after
 *      base64 inflation. The library iterates quality DOWN to hit the size cap,
 *      so files self-limit (clean shots land well under it).
 *   2. If the library fails (silent web worker OOM on big phone photos is the usual
 *      cause), fall back to a manual canvas-based downscale.
 *   3. Convert to base64 and POST to /api/upload.
 *   4. Retry the network step up to 3 times with exponential backoff.
 *
 * Concurrency=2: balances throughput with not overwhelming a phone on LTE
 * or hitting HubSpot's rate limit.
 */

import imageCompression from 'browser-image-compression';

const MAX_UPLOAD_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 800;
// Per-attempt network timeout. A stalled upload on a weak signal aborts here so
// the caller can fall back to the offline cache instead of spinning forever.
const UPLOAD_TIMEOUT_MS = 20000;
const TARGET_MAX_SIZE_MB = 2.0;     // ceiling; the lib drops quality only if over this — 2MB keeps field sync fast on weak signal while staying detailed
const TARGET_MAX_DIMENSION = 3024;  // ~9MP long edge — near native still res, so zoomed-in detail survives

/**
 * Compress any image File to a screen-sized JPEG Blob (client-side; works
 * offline). Exposed separately from uploadPhoto so the offline path can queue
 * the already-compressed blob (small, ~600KB) rather than the raw file.
 */
export async function compressToJpeg(file: File): Promise<Blob> {
  // FAST PATH: an already-small JPEG needs no recompression. The in-app camera
  // produces a sized JPEG (≤ ~9MP, q0.9) on capture, so re-running the heavy
  // main-thread imageCompression pass on it just stalls the UI between shots —
  // the cause of iPhone "one photo at a time." Skip it. (HEIC, oversized, or
  // non-JPEG inputs from the gallery still fall through to full compression.)
  if (/image\/jpe?g/i.test(file.type) && file.size > 0 && file.size <= TARGET_MAX_SIZE_MB * 1024 * 1024) {
    return file;
  }

  // HEIC/HEIF (the default iPhone format) does NOT render in <img> tags in most
  // browsers, nor in the PDF renderer — so we must always end up with a JPEG.
  const isHeic = /image\/(heic|heif)/i.test(file.type) || /\.(heic|heif)$/i.test(file.name || '');

  let compressed: Blob | null = null;
  try {
    const result = await imageCompression(file, {
      maxSizeMB: TARGET_MAX_SIZE_MB,
      maxWidthOrHeight: TARGET_MAX_DIMENSION,
      useWebWorker: false,  // web worker is faster but silently OOMs on big files
      initialQuality: 0.92, // near-native fidelity — preserves fine detail on zoomed-in shots
      fileType: 'image/jpeg',
    });
    if (result && result.type === 'image/jpeg') compressed = result;
  } catch (e: any) {
    console.warn('[uploadPhoto] library compression failed, will try canvas:', e?.message || e);
  }

  // Only fall back to the canvas path if the library failed or produced an
  // unexpectedly huge file (well above our size target) — not for normal
  // high-quality results that legitimately sit near the target ceiling.
  if (!compressed || compressed.size > (TARGET_MAX_SIZE_MB + 1) * 1024 * 1024) {
    try {
      compressed = await canvasDownscale(file, TARGET_MAX_DIMENSION, 0.88);
    } catch (e: any) {
      if (isHeic) {
        throw new Error('This HEIC photo couldn’t be converted in this browser. On iPhone, set Settings → Camera → Formats to "Most Compatible", or use the in-app camera, then re-upload.');
      }
      throw new Error(`Could not process image (${formatBytes(file.size)}). Try a different photo or update your browser.`);
    }
  }

  if (compressed.size > 6 * 1024 * 1024) {
    throw new Error(`Image too large after compression (${formatBytes(compressed.size)}). Use a lower-resolution photo.`);
  }
  return compressed;
}

/** Upload an already-compressed JPEG blob to HubSpot Files. Retries transient.
 *  Each attempt is bounded by a timeout (AbortController) so a stalled request on
 *  a low-bar connection FAILS instead of hanging forever — letting the caller
 *  fall back to the offline queue. */
export async function uploadJpegBlob(
  blob: Blob,
  filename: string,
  opts?: { attempts?: number; timeoutMs?: number; dedupeKey?: string },
): Promise<string> {
  const base64 = await fileToBase64(blob);
  // dedupeKey (the photo's stable localId): the server folds it into the stored
  // filename so a repeat upload of the SAME photo — a client-timeout retry, or
  // the iOS native background uploader racing this foreground flush — resolves to
  // the SAME hosted URL (HubSpot RETURN_EXISTING) instead of a second copy.
  const payload = JSON.stringify({ filename, contentType: 'image/jpeg', base64, dedupeKey: opts?.dedupeKey });
  const attempts = Math.max(1, opts?.attempts ?? MAX_UPLOAD_ATTEMPTS);
  const timeoutMs = opts?.timeoutMs ?? UPLOAD_TIMEOUT_MS;

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: controller.signal,
      });
      if (!r.ok) {
        const text = await r.text();
        throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`);
      }
      const data = await r.json();
      if (!data.url) throw new Error('Server response missing url');
      return data.url as string;
    } catch (e: any) {
      // A timeout surfaces as AbortError — normalize it to a clear network error
      // so the offline-detection (isOfflineErr) queues the photo.
      lastError = e?.name === 'AbortError'
        ? new Error('Upload timed out (slow or no connection)')
        : (e instanceof Error ? e : new Error(String(e)));
      if (attempt < attempts) {
        // Jitter the backoff so many phones retrying a failed upload at once
        // (e.g. a flaky cell tower coming back) don't all re-hit /api/upload on
        // the same beat and re-collide.
        const base = RETRY_BASE_DELAY_MS * attempt;
        await new Promise((r) => setTimeout(r, Math.round(base * (0.65 + Math.random() * 0.7))));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('Upload failed for unknown reason');
}

export async function uploadPhoto(file: File): Promise<string> {
  const compressed = await compressToJpeg(file);
  // Always upload as .jpg / image/jpeg — never trust the original name/type
  // (which could be .heic), so HubSpot stores a renderable file.
  return uploadJpegBlob(compressed, toJpegName(file.name));
}

/**
 * Upload a video clip from the in-app recorder.
 *
 * PRIMARY PATH: stream the file straight to Vercel Blob from the browser
 * (`@vercel/blob/client`). This bypasses Vercel's ~4.5MB serverless request-body
 * limit, so clips can be much longer than the old ~10s base64 ceiling.
 *
 * FALLBACK: if Blob isn't configured yet (no Blob store / BLOB_READ_WRITE_TOKEN),
 * small clips (≤ ~3MB) still upload via the base64 /api/upload path so nothing
 * breaks before the store is set up. Larger clips throw an actionable error.
 */
export async function uploadVideo(file: File): Promise<string> {
  const contentType = (file.type || 'video/mp4').split(';')[0].trim();
  const ext = /webm/i.test(contentType) ? 'webm' : /quicktime|mov/i.test(contentType) ? 'mov' : 'mp4';
  const filename = `clip_${Date.now()}.${ext}`;

  // DEFAULT: HubSpot Files (base64 → /api/upload) for clips that fit under
  // Vercel's ~4.5MB request-body limit (~3MB of raw video). Keeps videos
  // alongside the photos in HubSpot.
  if (file.size <= 3 * 1024 * 1024) {
    try {
      return await uploadVideoBase64(file, filename, contentType);
    } catch (e) {
      console.warn('[uploadVideo] HubSpot path failed, trying Blob:', e);
      // fall through to Blob as a last resort
    }
  }

  // FALLBACK: larger clips stream straight to Vercel Blob (bypasses the body
  // limit). Requires a Blob store linked to the project.
  try {
    const { upload } = await import('@vercel/blob/client');
    const blob = await upload(filename, file, {
      access: 'public',
      handleUploadUrl: '/api/blob-upload',
      contentType,
    });
    if (blob?.url) {
      // The client-direct Blob upload bypasses /api/upload's transcode, so this
      // raw clip may be a format iOS can't decode. Transcode it server-side to an
      // iOS-playable H.264 mp4; on any failure keep the raw URL (plays on
      // Android — no worse than before).
      try {
        const r = await fetch('/api/video-transcode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: blob.url }),
        });
        if (r.ok) {
          const d = await r.json().catch(() => ({}));
          if (d?.url) return d.url as string;
        }
      } catch { /* fall back to the raw Blob URL */ }
      return blob.url;
    }
    throw new Error('Blob upload returned no url');
  } catch (e: any) {
    throw new Error(
      `Couldn’t upload this clip. Longer clips need Vercel Blob storage enabled on the project. (${e?.message || e})`
    );
  }
}

/** Legacy base64 → /api/upload path (used as a fallback for short clips). */
async function uploadVideoBase64(file: File, filename: string, contentType: string): Promise<string> {
  if (file.size > 4 * 1024 * 1024) {
    throw new Error(`Video too large for fallback upload (${formatBytes(file.size)}). Enable Vercel Blob storage.`);
  }
  const base64 = await fileToBase64(file);
  const payload = JSON.stringify({ filename, contentType, base64 });
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    try {
      const r = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: controller.signal,
      });
      if (!r.ok) {
        const text = await r.text();
        throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`);
      }
      const data = await r.json();
      if (!data.url) throw new Error('Server response missing url');
      return data.url as string;
    } catch (e: any) {
      lastError = e?.name === 'AbortError'
        ? new Error('Video upload timed out (slow or no connection)')
        : (e instanceof Error ? e : new Error(String(e)));
      if (attempt < MAX_UPLOAD_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY_MS * attempt));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('Video upload failed for unknown reason');
}

/**
 * Upload multiple files in parallel with a small concurrency cap.
 * Photos are added to state progressively (as each upload completes), so the
 * inspector sees thumbnails appear in real time rather than waiting for all
 * uploads to finish.
 */
export async function uploadFilesBatch(
  files: File[],
  onUploaded: (url: string) => void,
  onProgress?: (completed: number, total: number) => void,
  uploader: (file: File) => Promise<string> = uploadPhoto,
): Promise<{ failed: number; errors: string[] }> {
  const CONCURRENCY = 2;  // lowered from 3 to be gentler on flaky cell networks
  let next = 0;
  let completed = 0;
  let failed = 0;
  const errors: string[] = [];

  async function worker() {
    while (next < files.length) {
      const idx = next++;
      try {
        const url = await uploader(files[idx]);
        onUploaded(url);
      } catch (e: any) {
        const msg = `${files[idx]?.name || `photo ${idx + 1}`}: ${e?.message || e}`;
        console.error('Upload failed —', msg);
        errors.push(msg);
        failed++;
      }
      completed++;
      if (onProgress) onProgress(completed, files.length);
    }
  }

  const workers = Array.from(
    { length: Math.min(CONCURRENCY, files.length) },
    () => worker()
  );
  await Promise.all(workers);
  return { failed, errors };
}

function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip the data URL prefix: "data:image/jpeg;base64,XXXXX..."
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Manual canvas-based downscale. Used as a fallback when
 * browser-image-compression silently produces a too-large file (or throws
 * on big phone photos). This works on every modern browser without a worker.
 *
 * Outputs JPEG since we don't need transparency for inspection photos.
 */
function canvasDownscale(file: File, maxDimension: number, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        // Calculate target dimensions preserving aspect ratio
        let { width, height } = img;
        if (width > maxDimension || height > maxDimension) {
          const ratio = width / height;
          if (width >= height) {
            width = maxDimension;
            height = Math.round(maxDimension / ratio);
          } else {
            height = maxDimension;
            width = Math.round(maxDimension * ratio);
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          URL.revokeObjectURL(url);
          reject(new Error('Canvas context not available'));
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => {
            URL.revokeObjectURL(url);
            if (blob) resolve(blob);
            else reject(new Error('Canvas toBlob returned null'));
          },
          'image/jpeg',
          quality
        );
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(e);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not load image for resizing'));
    };
    img.src = url;
  });
}

/** Force a .jpg extension on the upload filename (input may be .heic/.png/etc). */
export function toJpegName(name: string): string {
  const base = (name || 'photo').replace(/\.[^.]+$/, '').trim();
  return `${base || 'photo'}.jpg`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Format a number with thousands separators and 2 decimal places: 1234.5 -> "1,234.50" */
export function formatMoney(v: number): string {
  if (!isFinite(v)) return '0.00';
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Format a line-item quantity with thousands separators, no forced decimals:
 *  1833 -> "1,833", 12.5 -> "12.5", 1448 -> "1,448". Returns '' for non-finite
 *  input so callers can render an empty cell. Used everywhere a qty is DISPLAYED
 *  (rate-card view rows, re-inspect tables, AI suggestion cards). */
export function formatQty(v: number): string {
  if (!isFinite(v)) return '';
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
