/**
 * Photo upload helpers shared between QuestionForm and RateCardForm.
 *
 * The pattern:
 *   1. Aggressively compress with browser-image-compression (600KB target, 1280px max).
 *      Inspection photos don't need to be print-quality — these get viewed on a phone
 *      screen and in HubSpot's web UI, never zoomed in. Small files upload faster and
 *      stay well under the API body limit even after base64 inflation.
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
const TARGET_MAX_SIZE_MB = 0.6;     // aim for ~600KB output
const TARGET_MAX_DIMENSION = 1280;  // 1280px on the long edge

export async function uploadPhoto(file: File): Promise<string> {
  // HEIC/HEIF (the default iPhone format) does NOT render in <img> tags in most
  // browsers, nor in the PDF renderer — so we must always end up with a JPEG.
  const isHeic = /image\/(heic|heif)/i.test(file.type) || /\.(heic|heif)$/i.test(file.name || '');

  // Step 1: compress to JPEG. `fileType: 'image/jpeg'` forces JPEG output even
  // when the source is HEIC/PNG. On browsers that can't decode HEIC the library
  // throws — we then try the canvas path (which decodes via <img>, working on
  // Safari/iOS where HEIC photos originate). We only accept the library result
  // if it's actually a JPEG.
  let compressed: Blob | null = null;
  try {
    const result = await imageCompression(file, {
      maxSizeMB: TARGET_MAX_SIZE_MB,
      maxWidthOrHeight: TARGET_MAX_DIMENSION,
      useWebWorker: false,  // web worker is faster but silently OOMs on big files
      initialQuality: 0.75, // a good baseline for photos viewed on screens
      fileType: 'image/jpeg',
    });
    if (result && result.type === 'image/jpeg') compressed = result;
  } catch (e: any) {
    console.warn('[uploadPhoto] library compression failed, will try canvas:', e?.message || e);
  }

  // Canvas path: run it whenever we don't yet have a confirmed JPEG, or the JPEG
  // is still too big (> ~2 MB → base64 could exceed the 10MB API body limit).
  // This is also what converts HEIC → JPEG on Safari/iOS.
  if (!compressed || compressed.size > 2 * 1024 * 1024) {
    try {
      compressed = await canvasDownscale(file, TARGET_MAX_DIMENSION, 0.72);
    } catch (e: any) {
      // Couldn't decode/resize. For HEIC this means the browser can't decode it
      // (non-Safari) — give actionable guidance instead of uploading a file that
      // won't render anywhere.
      if (isHeic) {
        throw new Error('This HEIC photo couldn’t be converted in this browser. On iPhone, set Settings → Camera → Formats to "Most Compatible", or use the in-app camera, then re-upload.');
      }
      throw new Error(`Could not process image (${formatBytes(file.size)}). Try a different photo or update your browser.`);
    }
  }

  // Hard cap: refuse to even try uploading > 6 MB raw (which is ~8 MB base64,
  // already very close to the 10 MB body limit). This shouldn't trigger after
  // the canvas fallback, but it's a safety net.
  if (compressed.size > 6 * 1024 * 1024) {
    throw new Error(`Image too large after compression (${formatBytes(compressed.size)}). Use a lower-resolution photo.`);
  }

  const base64 = await fileToBase64(compressed);
  // Always upload as .jpg / image/jpeg — never trust the original name/type
  // (which could be .heic), so HubSpot stores a renderable file.
  const payload = JSON.stringify({
    filename: toJpegName(file.name),
    contentType: 'image/jpeg',
    base64,
  });

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt++) {
    try {
      const r = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
      if (!r.ok) {
        const text = await r.text();
        throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`);
      }
      const data = await r.json();
      if (!data.url) throw new Error('Server response missing url');
      return data.url as string;
    } catch (e: any) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt < MAX_UPLOAD_ATTEMPTS) {
        // Exponential backoff: 0.8s, 1.6s
        await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY_MS * attempt));
      }
    }
  }
  throw lastError || new Error('Upload failed for unknown reason');
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

  // 1) Direct-to-Blob (preferred).
  try {
    const { upload } = await import('@vercel/blob/client');
    const blob = await upload(filename, file, {
      access: 'public',
      handleUploadUrl: '/api/blob-upload',
      contentType,
    });
    if (blob?.url) return blob.url;
    throw new Error('Blob upload returned no url');
  } catch (e: any) {
    // 2) Fallback for short clips when Blob isn't configured.
    if (file.size <= 3 * 1024 * 1024) {
      return uploadVideoBase64(file, filename, contentType);
    }
    throw new Error(
      `Couldn’t upload this clip. For clips longer than ~10s, enable Vercel Blob storage on the project. (${e?.message || e})`
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
    try {
      const r = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
      if (!r.ok) {
        const text = await r.text();
        throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`);
      }
      const data = await r.json();
      if (!data.url) throw new Error('Server response missing url');
      return data.url as string;
    } catch (e: any) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt < MAX_UPLOAD_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY_MS * attempt));
      }
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
  onProgress?: (completed: number, total: number) => void
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
        const url = await uploadPhoto(files[idx]);
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
function toJpegName(name: string): string {
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
