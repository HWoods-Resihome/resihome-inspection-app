/**
 * PDF photo downscaling.
 *
 * Inspection photos are stored at ~1280px / ~600KB each, but the PDF draws them
 * into tiny 90×65pt cells. Embedding them at full size makes a finalized report
 * with dozens of photos tens of MB — slow to download and janky to scroll in any
 * viewer. This fetches each unique photo once and produces a small JPEG data URI
 * (long edge ~520px) to embed instead; the photo LINK still points at the
 * full-size gallery, so nothing is lost.
 *
 * Server-only (uses sharp). Best-effort: any photo that fails to fetch/encode is
 * simply omitted from the map, and the renderer falls back to the original URL.
 */
import sharp from 'sharp';
import { getPosterUrl } from '@/lib/media';
import { safeProxyFetch, readBodyCapped, ProxyFetchError } from '@/lib/safeProxyFetch';

const EMBED_EDGE = 520;     // long-edge px — plenty for a 90×65pt cell, even zoomed
const EMBED_QUALITY = 70;
const CONCURRENCY = 6;      // bounded parallel fetch+resize (caps memory/time + CDN throttling)
const FETCH_TIMEOUT_MS = 18000;
const MAX_ATTEMPTS = 4;
// Global wall-clock budget for the WHOLE embed pass. finalize/qc-finalize run under
// a 60s function limit; without this a few permanently-slow photos (4×18s retries
// each) blow the budget and the entire finalize is KILLED (no PDF, no email). Past
// the deadline we stop starting/​retrying fetches and let the rest fall back to links.
const TOTAL_BUDGET_MS = 45000;
// Hard ceiling on a fetched source image so a huge/attacker-supplied URL can't
// OOM the PDF render (mirrors lib/pdf-images.ts).
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

/**
 * Fetch + downscale ONE photo to a JPEG data URI, robustly: time-boxed, and
 * retried on transient failures — a just-uploaded HubSpot file can briefly
 * 404/403/5xx before its CDN propagates, and a momentary throttle/timeout would
 * otherwise leave the photo as a "View photo" link in the report instead of the
 * image. A sharp DECODE error isn't retried (won't change on re-fetch).
 */
async function fetchAndEmbed(url: string, deadline: number): Promise<string | null> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;  // out of budget → link fallback
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(FETCH_TIMEOUT_MS, remaining));
    try {
      // SSRF guard: poster URLs are client-influenced (the app stores whatever URL
      // the client writes into an answer's photoUrls), so a caller could point one
      // at an internal/metadata address and, if it returns a sharp-decodable image
      // (incl. SVG), exfiltrate it into the finalized PDF. safeProxyFetch follows
      // redirects manually and refuses any hop resolving to a private/internal IP;
      // readBodyCapped bounds the read. Mirrors the guarded lib/pdf-images.ts.
      const r = await safeProxyFetch(url, { signal: ctrl.signal });
      if (!r.ok) {
        const retryable = r.status === 404 || r.status === 403 || r.status === 429 || r.status >= 500;
        if (retryable && attempt < MAX_ATTEMPTS) { clearTimeout(timer); await new Promise((res) => setTimeout(res, 600 * attempt)); continue; }
        return null;
      }
      const buf = await readBodyCapped(r, MAX_IMAGE_BYTES);
      const jpeg = await sharp(buf)
        .rotate()
        .resize(EMBED_EDGE, EMBED_EDGE, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: EMBED_QUALITY })
        .toBuffer();
      return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
    } catch (e: any) {
      // SSRF-blocked / oversized / unresolvable host: not transient — don't retry.
      if (e instanceof ProxyFetchError) return null;
      const isAbort = e?.name === 'AbortError';
      const transient = isAbort || /fetch failed|network|ECONN|ETIMEDOUT|socket/i.test(String(e?.message || e));
      if (transient && attempt < MAX_ATTEMPTS) { clearTimeout(timer); await new Promise((res) => setTimeout(res, 600 * attempt)); continue; }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * Build a map of poster-URL → downscaled JPEG data URI for every photo entry
 * that will appear in the PDF. Keys are the POSTER url (what the PDF embeds), so
 * the renderer can look up `embedded[getPosterUrl(entry)]`.
 */
export async function buildEmbeddedPhotoMap(entries: string[]): Promise<Record<string, string>> {
  // Unique poster URLs (http/https only — skip blob:/data: and dedupe).
  const posters = Array.from(new Set(
    entries.map((e) => getPosterUrl(e)).filter((u) => /^https?:\/\//i.test(u))
  ));
  const out: Record<string, string> = {};
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let cursor = 0;
  const worker = async () => {
    while (cursor < posters.length && Date.now() < deadline) {
      const url = posters[cursor++];
      const data = await fetchAndEmbed(url, deadline);
      if (data) out[url] = data; // else leave unmapped → renderer falls back to the link
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, posters.length) }, worker));
  return out;
}
