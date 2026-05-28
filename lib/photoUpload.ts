/**
 * Photo upload helpers shared between QuestionForm and RateCardForm.
 *
 * The pattern:
 *   1. Compress with browser-image-compression (max 1MB, max 1600px)
 *   2. Convert to base64
 *   3. POST to /api/upload (which uploads to HubSpot Files and returns the URL)
 *
 * Concurrency=3: balances throughput with not overwhelming a phone on LTE
 * or hitting HubSpot's rate limit.
 */

import imageCompression from 'browser-image-compression';

export async function uploadPhoto(file: File): Promise<string> {
  const compressed = await imageCompression(file, {
    maxSizeMB: 1,
    maxWidthOrHeight: 1600,
    useWebWorker: true,
  });
  const base64 = await fileToBase64(compressed);
  const r = await fetch('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: file.name,
      contentType: compressed.type,
      base64,
    }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Upload failed: ${text}`);
  }
  const data = await r.json();
  return data.url as string;
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
): Promise<{ failed: number }> {
  const CONCURRENCY = 3;
  let next = 0;
  let completed = 0;
  let failed = 0;

  async function worker() {
    while (next < files.length) {
      const idx = next++;
      try {
        const url = await uploadPhoto(files[idx]);
        onUploaded(url);
      } catch (e: any) {
        console.error(`Photo ${idx + 1} upload failed:`, e);
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
  return { failed };
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

/** Format a number with thousands separators and 2 decimal places: 1234.5 -> "1,234.50" */
export function formatMoney(v: number): string {
  if (!isFinite(v)) return '0.00';
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
