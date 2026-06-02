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

/**
 * Fetch a single image URL and resize it to a JPEG data URI.
 * Returns null on failure so missing images don't break the whole PDF.
 */
async function fetchAndResize(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      // 8 second per-image timeout via AbortController would be nice; keep simple for now
    });
    if (!res.ok) {
      console.warn(`[pdf-images] Failed to fetch ${url}: ${res.status}`);
      return null;
    }
    const arrayBuf = await res.arrayBuffer();
    const buf = Buffer.from(arrayBuf);

    const resized = await sharp(buf)
      .resize(MAX_WIDTH, MAX_HEIGHT, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer();

    const base64 = resized.toString('base64');
    return `data:image/jpeg;base64,${base64}`;
  } catch (e: any) {
    console.warn(`[pdf-images] Error processing ${url}: ${e.message || e}`);
    return null;
  }
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
