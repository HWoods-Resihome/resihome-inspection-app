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
  // Step 1: compress. Try the library first; if it throws or returns a still-huge
  // file, fall back to a manual canvas resize. Phone-camera 4000x3000 photos
  // (~5-8 MB) are the main reason we have a fallback at all.
  let compressed: Blob = file;
  try {
    const result = await imageCompression(file, {
      maxSizeMB: TARGET_MAX_SIZE_MB,
      maxWidthOrHeight: TARGET_MAX_DIMENSION,
      useWebWorker: false,  // web worker is faster but silently OOMs on big files
      initialQuality: 0.75, // a good baseline for photos viewed on screens
    });
    compressed = result;
  } catch (e: any) {
    console.warn('[uploadPhoto] library compression failed, using canvas fallback:', e?.message || e);
  }

  // Canvas fallback if the file is still too big (> ~2 MB compressed means
  // base64-encoded payload could exceed the 10MB API body limit).
  if (compressed.size > 2 * 1024 * 1024) {
    try {
      compressed = await canvasDownscale(file, TARGET_MAX_DIMENSION, 0.72);
    } catch (e: any) {
      // If canvas fallback ALSO fails, surface a clear error instead of trying
      // to upload a 5MB+ file and getting a confusing 413.
      throw new Error(`Could not resize image (${formatBytes(file.size)}). Try a different photo or update your browser.`);
    }
  }

  // Hard cap: refuse to even try uploading > 6 MB raw (which is ~8 MB base64,
  // already very close to the 10 MB body limit). This shouldn't trigger after
  // the canvas fallback, but it's a safety net.
  if (compressed.size > 6 * 1024 * 1024) {
    throw new Error(`Image too large after compression (${formatBytes(compressed.size)}). Use a lower-resolution photo.`);
  }

  const base64 = await fileToBase64(compressed);
  const payload = JSON.stringify({
    filename: file.name,
    contentType: compressed.type || 'image/jpeg',
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
