/**
 * Proof-of-service photo extraction (server-only).
 *
 * When a vendor closes a service with their OWN company invoice/report (the
 * proof-of-service upload), the job photos live INSIDE that document. This pulls
 * the embedded JPEGs back out of a proof PDF so the app's vendor/client service
 * PDFs can show the actual photos instead of only linking to the document.
 *
 * How: photos inside PDFs are overwhelmingly stored as DCTDecode image XObjects,
 * whose stream bytes ARE a complete JPEG. Rather than adding a PDF parser, we
 * scan the raw bytes for JPEG start/end markers and let sharp validate each
 * candidate (decodable + real-photo sized). That reliably recovers camera photos
 * from vendor-generated PDFs (Word exports, phone scanners, invoice platforms);
 * vector logos / Flate-encoded PNGs are simply skipped — this is a best-effort
 * "if possible" enrichment, never a gate.
 *
 * Extracted photos are re-encoded (strips any weird JPEG internals), uploaded to
 * HubSpot Files, and returned as URLs for the `proof_photo_urls` property.
 */
import sharp from 'sharp';
import { createHash } from 'crypto';
import { uploadFile } from '@/lib/hubspot';
import { safeProxyFetch, readBodyCapped, isAllowedPhotoHost } from '@/lib/safeProxyFetch';

const MAX_DOC_BYTES = 24 * 1024 * 1024;  // same ceiling as the AI-review proof fetch
const MAX_PHOTOS = 12;                    // cap per document (a report rarely has more real photos)
// Vendor platforms often embed the job photos as SMALL thumbnails (real example:
// 188×250 grids), so the "not a logo" floor must be low; banner-shaped images
// (wide/thin logos, header art) are excluded by aspect ratio instead.
const MIN_EDGE_PX = 150;                  // long edge — keeps photo thumbnails, drops icons
const MAX_ASPECT = 3.2;                   // skip banner-shaped images (logos/headers)
const OUT_EDGE = 1280;                    // stored size (matches app photo scale)

/** Slice every plausible JPEG (SOI …FFD8FF… → EOI …FFD9) out of a raw buffer. */
function sliceJpegCandidates(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let i = 0;
  while (out.length < MAX_PHOTOS * 3 && i < buf.length - 4) {
    const soi = buf.indexOf(Buffer.from([0xff, 0xd8, 0xff]), i);
    if (soi === -1) break;
    const eoi = buf.indexOf(Buffer.from([0xff, 0xd9]), soi + 3);
    if (eoi === -1) break;
    out.push(buf.subarray(soi, eoi + 2));
    i = eoi + 2;
  }
  return out;
}

/** Extract, validate, downscale, and upload the photos inside a proof document.
 *  Returns HubSpot file URLs (possibly empty). NEVER throws — best-effort. */
export async function extractProofPhotos(proofUrl: string, serviceId: string): Promise<string[]> {
  try {
    const clean = String(proofUrl || '').split('#')[0];
    if (!/^https?:\/\//i.test(clean) || !isAllowedPhotoHost(clean)) return [];
    if (!/\.pdf(\?|$)/i.test(clean)) return [];   // docx/other → skip (PDF is the proof-upload norm)
    const r = await safeProxyFetch(clean);
    if (!r.ok) return [];
    const doc = await readBodyCapped(r, MAX_DOC_BYTES);

    // Validate every candidate first, THEN keep the largest (by pixel area) up to
    // the cap — so when a report has more photos than the cap, the small
    // duplicates/thumbnails are what gets dropped, never the main photos.
    const keeps: { jpeg: Buffer; area: number; hash: string }[] = [];
    const seen = new Set<string>();
    for (const cand of sliceJpegCandidates(doc)) {
      try {
        const base = sharp(cand, { failOn: 'truncated' }).rotate();
        const meta = await base.clone().metadata();
        const w = meta.width || 0; const h = meta.height || 0;
        const long = Math.max(w, h); const short = Math.min(w, h) || 1;
        if (long < MIN_EDGE_PX) continue;              // icon / signature — not a job photo
        if (long / short > MAX_ASPECT) continue;       // banner-shaped logo / header art
        const jpeg = await base.resize(OUT_EDGE, OUT_EDGE, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
        // Dedupe identical photos (same image often appears twice in a PDF's
        // object tree — thumbnail + full — or across pages).
        const hash = createHash('sha1').update(jpeg).digest('hex');
        if (seen.has(hash)) continue;
        seen.add(hash);
        keeps.push({ jpeg, area: w * h, hash });
      } catch { /* not a decodable/real JPEG — skip candidate */ }
    }
    keeps.sort((a, b) => b.area - a.area);
    const urls: string[] = [];
    for (let i = 0; i < Math.min(keeps.length, MAX_PHOTOS); i++) {
      const k = keeps[i];
      try {
        const url = await uploadFile(k.jpeg, `proof-${serviceId}-${i + 1}-${k.hash.slice(0, 8)}.jpg`, 'image/jpeg', '/service_proof_photos');
        if (url) urls.push(url);
      } catch (e) { console.warn('[proof-extract] upload failed for one photo (continuing):', e); }
    }
    if (urls.length) console.log(`[proof-extract] service ${serviceId}: extracted ${urls.length} photo(s) from proof document (${keeps.length} candidates kept)`);
    return urls;
  } catch (e) {
    console.warn('[proof-extract] failed (continuing without photos):', e);
    return [];
  }
}
