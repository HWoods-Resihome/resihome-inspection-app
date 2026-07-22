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
const CONCURRENCY = 8;      // bounded parallel fetch+resize (caps memory/time + CDN throttling)
const FETCH_TIMEOUT_MS = 18000;
const MAX_ATTEMPTS = 4;
// Global wall-clock budget for the WHOLE embed pass — a safety valve, not a pace:
// past the deadline we stop starting/retrying fetches and the REST of the photos
// fall back to "View photo" links (grey boxes) instead of killing the finalize.
// finalize/qc-finalize now run under a 300s ceiling (vercel.json), so the budget
// is sized to cover a photo-heavy inspection (hundreds of photos) while still
// leaving ~2 minutes of headroom for the renders/uploads/tickets/email after it.
// (The old 45s value was tuned for the former 60s limit and made big reports
// degrade most of their photos to links.)
const TOTAL_BUDGET_MS = 150000;
// Hard ceiling on a fetched source image so a huge/attacker-supplied URL can't
// OOM the PDF render (mirrors lib/pdf-images.ts).
const MAX_IMAGE_BYTES = 12 * 1024 * 1024; // output is <=520px; a 12MB source is ample. Bounds peak memory (concurrency x this) so a few oversized uploads can't OOM the render.

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
      // failOn:'truncated' → a partially-uploaded/corrupt source THROWS instead of
      // decoding the missing bytes as black (the "occasional black photo" bug); it
      // then falls back to the "View photo" link rather than embedding a black cell.
      const base = sharp(buf, { failOn: 'truncated' }).rotate();
      // Reject a solid near-black frame outright (some HEIC decodes / black uploads
      // produce one). If NO channel has a pixel brighter than ~8/255 anywhere, it
      // isn't a real photo — a genuinely dark photo still has brighter pixels.
      try {
        const stats = await base.clone().stats();
        if (stats.channels.slice(0, 3).every((c) => c.max <= 8)) return null;
      } catch { /* stats failed → let the resize below surface a real decode error */ }
      const jpeg = await base
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
// Warm-instance thumbnail cache: uploaded photos are immutable (a HubSpot file
// URL never changes content), so a poster fetched+downscaled once can be reused
// by any later render on this instance — a re-finalize / qc pass embeds its
// already-seen photos instantly and spends the whole budget on NEW ones. Bounded
// (insertion-order eviction) so a long-lived instance can't grow unbounded:
// ~60KB per data URI × 600 ≈ 36MB ceiling.
const _thumbCache = new Map<string, string>();
const THUMB_CACHE_MAX = 600;
function cacheThumb(url: string, data: string): void {
  if (_thumbCache.size >= THUMB_CACHE_MAX) {
    const oldest = _thumbCache.keys().next().value;
    if (oldest !== undefined) _thumbCache.delete(oldest);
  }
  _thumbCache.set(url, data);
}

export async function buildEmbeddedPhotoMap(entries: string[]): Promise<Record<string, string>> {
  // Unique poster URLs (http/https only — skip blob:/data: and dedupe).
  const posters = Array.from(new Set(
    entries.map((e) => getPosterUrl(e)).filter((u) => /^https?:\/\//i.test(u))
  ));
  const out: Record<string, string> = {};
  // Serve cache hits first — they cost nothing and don't touch the budget.
  const misses: string[] = [];
  for (const url of posters) {
    const hit = _thumbCache.get(url);
    if (hit) out[url] = hit; else misses.push(url);
  }
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let cursor = 0;
  const worker = async () => {
    while (cursor < misses.length && Date.now() < deadline) {
      const url = misses[cursor++];
      const data = await fetchAndEmbed(url, deadline);
      if (data) { out[url] = data; cacheThumb(url, data); } // else unmapped → link fallback
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, misses.length) }, worker));
  // Coverage visibility: if photos degraded to "View photo" links, say how many
  // and whether the budget deadline was the cause — the exact signal needed to
  // diagnose grey-box reports from the field.
  const embedded = Object.keys(out).length;
  if (embedded < posters.length) {
    const ranOut = Date.now() >= deadline;
    console.warn(`[pdf-images] embedded ${embedded}/${posters.length} photos (${posters.length - embedded} fell back to links${ranOut ? ' — TIME BUDGET EXHAUSTED' : ' — fetch/decode failures'})`);
  } else if (posters.length > 0) {
    console.log(`[pdf-images] embedded ${embedded}/${posters.length} photos (${posters.length - misses.length} from cache)`);
  }
  return out;
}
