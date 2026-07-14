/**
 * GET /api/photo-proxy?url=<hubspot file url>
 *
 * Streams a HubSpot-hosted photo back through our own origin so it can be drawn
 * onto a <canvas> for annotation without cross-origin taint (which would make
 * canvas.toBlob throw). SSRF-guarded: only HubSpot file hosts are allowed.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import sharp from 'sharp';
import { safeProxyFetch, readBodyCapped, ProxyFetchError } from '@/lib/safeProxyFetch';

// Hard ceiling on a proxied image so a huge upstream can't OOM the function.
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

// HubSpot serves uploaded files from a whole family of hosts that vary by portal
// region and CDN — and crucially across BOTH .net AND .com TLDs:
// hubspotusercontent-na1.net / -na2 / -eu1 / numbered variants, the bare
// hubspotusercontent.net, AND the newer hubspotusercontent*.COM hosts, plus the
// hubspot.net / hubspot.com CDNs, hubfs.com, hs-sites.com and hubapi.com. Match
// the `hubspotusercontent*` file family across BOTH .net and .com to cover every
// region/CDN variant. (This is the SSRF guard on the INITIAL url; the proxy then
// follows HubSpot's own CDN redirect and trusts it.)
// resihome.com = HubSpot's file CDN served via the connected custom domain (this
// portal's uploaded photos come back as https://resihome.com/hubfs/…). Without
// it the proxy 403'd every photo → markup couldn't open the image on iOS.
// SECURITY: keep this pinned to `hubspotusercontent*` + hubspot.(com|net) — do
// NOT loosen to `hubspot[a-z0-9-]*`, which also matches attacker-registerable
// domains like hubspotx.com / hubspot-evil.com and would turn this UNAUTHENTICATED
// proxy into an open proxy serving attacker content from our own origin.
const ALLOWED_HOST_RE = /(^|\.)(hubspotusercontent([0-9]+|-[a-z0-9-]+)?\.(net|com)|hubspot\.(com|net)|hubfs\.com|hs-sites\.com|hubapi\.com|vercel-storage\.com|resihome\.com|resiwalk\.com)$/i;

export const config = { api: { responseLimit: false } };

// Soft per-IP rate limit. This endpoint is public (drawn onto a canvas, no
// session), so cap how fast a single client can drive HubSpot fetches through
// us — without it the proxy is a bandwidth/DoS amplifier. Per-instance (not
// global), which is enough to blunt abuse from any one source; legitimate
// galleries load a handful of images and never approach the cap.
const RL_WINDOW_MS = 60_000;
const RL_MAX = 240; // requests per IP per minute
const rlHits = new Map<string, { count: number; windowStart: number }>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const cur = rlHits.get(ip);
  if (!cur || now - cur.windowStart >= RL_WINDOW_MS) { rlHits.set(ip, { count: 1, windowStart: now }); }
  else if (cur.count >= RL_MAX) { return true; }
  else { cur.count++; }
  // Bound the map so it can't grow unboundedly across many IPs.
  if (rlHits.size > 5000) for (const [k, v] of rlHits) { if (now - v.windowStart >= RL_WINDOW_MS) rlHits.delete(k); }
  return false;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const ip = (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket?.remoteAddress || 'unknown';
  if (rateLimited(ip)) { res.setHeader('Retry-After', '30'); return res.status(429).json({ error: 'Too many requests' }); }
  const raw = String(req.query.url || '');
  let u: URL;
  try { u = new URL(raw); } catch { return res.status(400).json({ error: 'Invalid url' }); }
  if (u.protocol !== 'https:' || !ALLOWED_HOST_RE.test(u.hostname)) {
    return res.status(403).json({ error: `Host not allowed: ${u.hostname}` });
  }
  try {
    // The initial host check above restricts WHAT can be proxied to the HubSpot
    // file family. HubSpot file URLs commonly 302 to a signed CDN whose host
    // ISN'T a hubspot.* domain, so we must follow the redirect — but safeProxyFetch
    // follows it MANUALLY and re-validates every hop by RESOLVED IP, refusing any
    // private/internal address (blocks an allowlisted open-redirect aimed at
    // cloud metadata / localhost). Cap the fetch so a slow origin can't tie up the
    // function.
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 15000);
    let upstream: Response;
    try {
      // Retry a just-uploaded file that hasn't propagated to HubSpot's CDN yet.
      // For the first second or two after a photo syncs, fetching its file URL can
      // return 404/403/5xx — and a one-shot <img> would be left a PERMANENT broken
      // tile (the "thumbnail won't preview" the inspector kept seeing right after
      // capture). A few quick retries INSIDE the proxy let the SAME image request
      // succeed once the file goes live, fixing the broken thumbnails server-side
      // with zero client OOM risk (no falling back to full-res images).
      upstream = await safeProxyFetch(u.toString(), { signal: ctrl.signal });
      for (let i = 0; i < 3 && !upstream.ok
        && (upstream.status === 404 || upstream.status === 403 || upstream.status >= 500); i++) {
        await new Promise((r) => setTimeout(r, 600));
        upstream = await safeProxyFetch(u.toString(), { signal: ctrl.signal });
      }
    } finally {
      clearTimeout(to);
    }
    if (!upstream.ok) return res.status(upstream.status).json({ error: `Upstream ${upstream.status}` });
    const ct = (upstream.headers.get('content-type') || '').toLowerCase();
    const buf = await readBodyCapped(upstream, MAX_IMAGE_BYTES);

    // Optional thumbnail resize (?w=). Inspection forms render dozens of photos
    // as small tiles; without this the browser decodes the FULL-RES bitmap of
    // each (a 2048px JPEG ≈ 12MB decoded), and a photo-heavy inspection OOM-
    // crashes the iOS WebKit content process ("A problem repeatedly occurred").
    // Serving a ~400px thumbnail cuts the decoded size ~25–40×. We re-encode with
    // sharp (auto-orient) and cache hard, since a given photo's thumb is immutable.
    // Cap at 2048 so the markup editor can request a large-but-clean re-encoded
    // JPEG (?w=1920). The raw full-size passthrough can fail to decode in iOS
    // WebKit on big photos — re-encoding through sharp produces a baseline JPEG
    // iOS reliably decodes. Thumbnails request small widths and stay memory-light.
    const wRaw = Number(req.query.w);
    const width = Number.isFinite(wRaw) ? Math.max(64, Math.min(2048, Math.round(wRaw))) : 0;
    const isHeic = ct.includes('heic') || ct.includes('heif')
      || /\.(heic|heif)$/i.test(u.pathname);

    if (width > 0 && (isHeic || ct.startsWith('image/') || !ct)) {
      try {
        const pipeline = sharp(buf).rotate().resize({ width, withoutEnlargement: true });
        // Serve WebP to clients that accept it (~25-35% smaller than JPEG at equal
        // quality → less cell bandwidth + faster decode), else JPEG. WebP not AVIF:
        // AVIF's encode is far slower and a photo-heavy inspection requests dozens
        // of tiles at once. `Vary: Accept` so a cache never hands a WebP to a
        // JPEG-only client. Both are cached hard (a photo's thumb is immutable).
        const accept = String(req.headers.accept || '');
        const useWebp = accept.includes('image/webp');
        const out = useWebp
          ? await pipeline.webp({ quality: 72 }).toBuffer()
          : await pipeline.jpeg({ quality: 78 }).toBuffer();
        res.setHeader('Content-Type', useWebp ? 'image/webp' : 'image/jpeg');
        res.setHeader('Vary', 'Accept');
        res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
        return res.status(200).send(out);
      } catch { /* fall through to full-size handling below */ }
    }

    // HEIC/HEIF doesn't render in <img> in most browsers. Convert it to JPEG
    // server-side (sharp) so existing .heic photos display + can be annotated.
    if (isHeic) {
      const jpeg = await sharp(buf).rotate().jpeg({ quality: 82 }).toBuffer();
      res.setHeader('Content-Type', 'image/jpeg');
      // A given file URL's bytes are immutable, so cache hard (like thumbnails).
      // The old 1-day/5-min windows made the SAME photo re-fetch repeatedly during
      // a session — hundreds of proxy hits from one phone, which trips Vercel's
      // automatic DDoS challenge and then blocks fetch() calls (AI review, upload).
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      return res.status(200).send(jpeg);
    }

    if (ct && !ct.startsWith('image/')) return res.status(415).json({ error: 'Not an image' });
    res.setHeader('Content-Type', ct || 'image/jpeg');
    // Immutable per URL → cache hard so repeat renders hit the browser/edge cache
    // instead of re-requesting (was max-age=300, which re-fetched every 5 min and
    // inflated the request burst that triggers the DDoS challenge).
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    return res.status(200).send(buf);
  } catch (e) {
    if (e instanceof ProxyFetchError) return res.status(e.status).json({ error: e.message });
    return res.status(502).json({ error: 'Fetch failed' });
  }
}
