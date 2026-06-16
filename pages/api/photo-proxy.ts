/**
 * GET /api/photo-proxy?url=<hubspot file url>
 *
 * Streams a HubSpot-hosted photo back through our own origin so it can be drawn
 * onto a <canvas> for annotation without cross-origin taint (which would make
 * canvas.toBlob throw). SSRF-guarded: only HubSpot file hosts are allowed.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import sharp from 'sharp';

// HubSpot serves uploaded files from a whole family of hosts that vary by portal
// region and CDN — and crucially across BOTH .net AND .com TLDs:
// hubspotusercontent-na1.net / -na2 / -eu1 / numbered variants, the bare
// hubspotusercontent.net, AND the newer hubspotusercontent*.COM hosts, plus the
// hubspot.net / hubspot.com CDNs, hubfs.com, hs-sites.com and hubapi.com. The
// previous regex only allowed the .NET variants, so photos served from a .COM
// file host 403'd in the proxy — the thumbnail broke while the direct URL (which
// bypasses this allowlist) still opened on click. Match `hubspot<anything>.net|
// .com` to cover every region/CDN/TLD HubSpot uses. (This is the SSRF guard on the
// INITIAL url; the proxy then follows HubSpot's own CDN redirect and trusts it.)
const ALLOWED_HOST_RE = /(^|\.)(hubspot[a-z0-9-]*\.(net|com)|hubfs\.com|hs-sites\.com|hubapi\.com)$/i;

export const config = { api: { responseLimit: false } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const raw = String(req.query.url || '');
  let u: URL;
  try { u = new URL(raw); } catch { return res.status(400).json({ error: 'Invalid url' }); }
  if (u.protocol !== 'https:' || !ALLOWED_HOST_RE.test(u.hostname)) {
    return res.status(403).json({ error: 'Host not allowed' });
  }
  try {
    // The INITIAL host check above is the SSRF guard — we only ever fetch a URL
    // HubSpot itself produced. HubSpot file URLs commonly 302 to a signed CDN
    // (CloudFront/Akamai/cdn2) whose host ISN'T a hubspot.* domain; re-rejecting
    // that final host (the old behavior) 403'd legitimate photos. So we follow
    // the redirect and TRUST it — a validated HubSpot URL redirecting to its own
    // CDN is not an SSRF vector. Cap the fetch so a slow origin can't tie up the
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
      upstream = await fetch(u.toString(), { redirect: 'follow', signal: ctrl.signal });
      for (let i = 0; i < 3 && !upstream.ok
        && (upstream.status === 404 || upstream.status === 403 || upstream.status >= 500); i++) {
        await new Promise((r) => setTimeout(r, 600));
        upstream = await fetch(u.toString(), { redirect: 'follow', signal: ctrl.signal });
      }
    } finally {
      clearTimeout(to);
    }
    if (!upstream.ok) return res.status(upstream.status).json({ error: `Upstream ${upstream.status}` });
    const ct = (upstream.headers.get('content-type') || '').toLowerCase();
    const buf = Buffer.from(await upstream.arrayBuffer());

    // Optional thumbnail resize (?w=). Inspection forms render dozens of photos
    // as small tiles; without this the browser decodes the FULL-RES bitmap of
    // each (a 2048px JPEG ≈ 12MB decoded), and a photo-heavy inspection OOM-
    // crashes the iOS WebKit content process ("A problem repeatedly occurred").
    // Serving a ~400px thumbnail cuts the decoded size ~25–40×. We re-encode with
    // sharp (auto-orient) and cache hard, since a given photo's thumb is immutable.
    const wRaw = Number(req.query.w);
    const width = Number.isFinite(wRaw) ? Math.max(64, Math.min(1024, Math.round(wRaw))) : 0;
    const isHeic = ct.includes('heic') || ct.includes('heif')
      || /\.(heic|heif)$/i.test(u.pathname);

    if (width > 0 && (isHeic || ct.startsWith('image/') || !ct)) {
      try {
        const jpeg = await sharp(buf).rotate().resize({ width, withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
        return res.status(200).send(jpeg);
      } catch { /* fall through to full-size handling below */ }
    }

    // HEIC/HEIF doesn't render in <img> in most browsers. Convert it to JPEG
    // server-side (sharp) so existing .heic photos display + can be annotated.
    if (isHeic) {
      const jpeg = await sharp(buf).rotate().jpeg({ quality: 82 }).toBuffer();
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'private, max-age=86400');
      return res.status(200).send(jpeg);
    }

    if (ct && !ct.startsWith('image/')) return res.status(415).json({ error: 'Not an image' });
    res.setHeader('Content-Type', ct || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.status(200).send(buf);
  } catch {
    return res.status(502).json({ error: 'Fetch failed' });
  }
}
