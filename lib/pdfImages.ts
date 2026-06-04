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

const EMBED_EDGE = 520;     // long-edge px — plenty for a 90×65pt cell, even zoomed
const EMBED_QUALITY = 70;
const CONCURRENCY = 8;      // bounded parallel fetch+resize (caps memory/time)

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
  let cursor = 0;
  const worker = async () => {
    while (cursor < posters.length) {
      const url = posters[cursor++];
      try {
        const r = await fetch(url);
        if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        const jpeg = await sharp(buf)
          .rotate()
          .resize(EMBED_EDGE, EMBED_EDGE, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: EMBED_QUALITY })
          .toBuffer();
        out[url] = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
      } catch {
        /* leave unmapped → renderer uses the original URL */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, posters.length) }, worker));
  return out;
}
