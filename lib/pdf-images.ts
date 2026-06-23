// Server-only helper: bulk-fetch image URLs in parallel and resize them to data URIs.
// This is the biggest perf win for PDF generation -- React-PDF's built-in image
// fetcher is sequential. We pre-resolve everything in parallel and pass data URIs
// so React-PDF embeds them directly without doing any I/O of its own.

import sharp from 'sharp';

// Embedded photos are sized/compressed for documentation legibility while
// keeping the PDF small — photo-heavy scopes were pushing the finalize email
// past Gmail's 25 MB cap. ~520px @ q62 (mozjpeg) roughly halves the bytes vs
// 600px @ q70 with no meaningful loss at PDF print scale.
const MAX_WIDTH = 520;   // max width for embedded images (pixels)
const MAX_HEIGHT = 400;  // max height
const JPEG_QUALITY = 62;
// Per-image fetch ceiling. One stalled HubSpot file download must never hang the
// whole PDF render (which would blow the serverless timeout and fail finalize).
const IMAGE_FETCH_TIMEOUT_MS = 18000;

/**
 * Fetch a single image URL and resize it to a JPEG data URI.
 * Returns null on failure so missing images don't break the whole PDF.
 *
 * Retries a transient fetch failure (network blip, or a just-uploaded file that
 * HubSpot's CDN briefly 404/403/5xx's before it propagates) a couple of times —
 * otherwise that photo renders as a "View photo" link in the PDF instead of the
 * image. A sharp DECODE failure isn't retried (it won't change on a re-fetch).
 */
async function fetchAndResize(url: string): Promise<string | null> {
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Time-box each fetch: on timeout we retry (or skip), so the report still
    // renders rather than hanging the whole PDF on one bad URL.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), IMAGE_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) {
        // Retry the propagation-lag statuses; give up on a genuine client error.
        const retryable = res.status === 404 || res.status === 403 || res.status === 429 || res.status >= 500;
        if (retryable && attempt < MAX_ATTEMPTS) { clearTimeout(timer); await new Promise((r) => setTimeout(r, 600)); continue; }
        console.warn(`[pdf-images] Failed to fetch ${url}: ${res.status}`);
        return null;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      // auto-orient (rotate) so EXIF-rotated phone photos embed upright.
      const resized = await sharp(buf)
        .rotate()
        .resize(MAX_WIDTH, MAX_HEIGHT, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
        .toBuffer();
      return `data:image/jpeg;base64,${resized.toString('base64')}`;
    } catch (e: any) {
      const isAbort = e?.name === 'AbortError';
      // A network/timeout error is worth one more try; a decode error isn't.
      const looksTransient = isAbort || /fetch failed|network|ECONN|ETIMEDOUT|socket/i.test(String(e?.message || e));
      if (looksTransient && attempt < MAX_ATTEMPTS) { clearTimeout(timer); await new Promise((r) => setTimeout(r, 600)); continue; }
      const why = isAbort ? `timed out after ${IMAGE_FETCH_TIMEOUT_MS}ms` : (e?.message || e);
      console.warn(`[pdf-images] Error processing ${url}: ${why}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * Resolve every URL in the given list, in parallel, to a data URI.
 * Deduplicates -- each URL is fetched at most once.
 * Returns a Map: original URL -> data URI (or original URL if fetch failed).
 */
export async function resolveImagesInParallel(urls: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(urls.filter(Boolean)));
  if (unique.length === 0) return new Map();

  // Cap concurrency to avoid overwhelming HubSpot. 8 concurrent is conservative.
  const CONCURRENCY = 8;
  const out = new Map<string, string>();
  let idx = 0;

  async function worker() {
    while (idx < unique.length) {
      const i = idx++;
      const url = unique[i];
      const result = await fetchAndResize(url);
      // On failure, fall back to the original URL (React-PDF will try to load it,
      // and either succeed or show a placeholder).
      out.set(url, result || url);
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, unique.length) }, () => worker());
  await Promise.all(workers);
  return out;
}
