/**
 * GET /api/video-proxy?url=<hubspot file url>
 *
 * Streams a HubSpot-hosted video clip back through our own origin with PROPER
 * HTTP Range support and a correct video Content-Type.
 *
 * WHY THIS EXISTS: iOS Safari's <video> element is strict — it will only play a
 * source whose server (a) returns a real `video/*` Content-Type and (b) honors
 * HTTP Range requests (responding 206 Partial Content with Accept-Ranges). Chrome
 * /Android are lenient and play a plain 200 with a wrong/missing type, so clips
 * looked fine on Android but showed a black frame + dead play button on iPhones —
 * even clips RECORDED on an iPhone (so the codec was fine; only delivery was at
 * fault). HubSpot's File Manager CDN doesn't reliably satisfy iOS here, so we
 * re-serve the bytes ourselves: force the right Content-Type and implement Range
 * locally (slice the buffer) so iOS always gets the 206 it demands.
 *
 * SCOPE: only HubSpot file hosts are proxied (SSRF-guarded, same allowlist as
 * photo-proxy). Larger clips live on Vercel Blob, which already supports Range
 * natively and is served direct — never routed here (it would blow the function's
 * memory/response limits). Clips here are the small (≤3MB) HubSpot-hosted ones.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureFaststart } from '@/lib/videoFaststart';
import { safeProxyFetch, readBodyCapped, ProxyFetchError } from '@/lib/safeProxyFetch';

// Ceiling on a proxied clip: HubSpot-hosted clips here are small (≤3MB; larger
// clips live on Vercel Blob and are served DIRECT, never routed here). This caps
// the whole-buffer read + faststart so a large URL can't OOM the function.
const MAX_VIDEO_BYTES = 60 * 1024 * 1024;

// Same HubSpot host family as photo-proxy (region/CDN/TLD variants).
// resihome.com / resiwalk.com = HubSpot file CDN via the connected custom domain
// (this portal's uploads resolve there), so clips stored there are proxied too.
// SECURITY: pinned to `hubspotusercontent*` + hubspot.(com|net); do NOT loosen to
// `hubspot[a-z0-9-]*` (matches attacker-registerable hubspotx.com → open proxy).
const ALLOWED_HOST_RE = /(^|\.)(hubspotusercontent([0-9]+|-[a-z0-9-]+)?\.(net|com)|hubspot\.(com|net)|hubfs\.com|hs-sites\.com|hubapi\.com|vercel-storage\.com|resihome\.com|resiwalk\.com)$/i;

export const config = { api: { responseLimit: false }, maxDuration: 60 };

// Map a file extension to a video Content-Type. Used only as a fallback when
// the bytes themselves don't identify the container (see sniffVideoType).
function videoTypeFor(pathname: string): string {
  if (/\.webm$/i.test(pathname)) return 'video/webm';
  if (/\.(mov|qt)$/i.test(pathname)) return 'video/quicktime';
  if (/\.m4v$/i.test(pathname)) return 'video/x-m4v';
  return 'video/mp4';
}

// Identify the REAL container from the file's magic bytes, so we serve the
// correct Content-Type even when the stored extension/label is wrong. iOS Safari
// trusts Content-Type strictly and refuses to decode a real H.264/mp4 clip that
// was mislabeled (e.g. ".webm" from a recorder fallback) — the exact "slashed
// play button" failure. Returns null when the bytes don't match a known
// container (caller falls back to the extension guess).
//   - ISO-BMFF (mp4/m4v/mov): bytes 4..8 == 'ftyp'
//   - Matroska/WebM:          starts with 1A 45 DF A3 (EBML)
function sniffVideoType(buf: Buffer): string | null {
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buf.toString('latin1', 8, 12).toLowerCase();
    // 'qt  ' = QuickTime; everything else ISO-BMFF plays as mp4 on iOS.
    return brand.startsWith('qt') ? 'video/quicktime' : 'video/mp4';
  }
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return 'video/webm';
  }
  return null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const raw = String(req.query.url || '');
  let u: URL;
  try { u = new URL(raw); } catch { return res.status(400).json({ error: 'Invalid url' }); }
  if (u.protocol !== 'https:' || !ALLOWED_HOST_RE.test(u.hostname)) {
    return res.status(403).json({ error: 'Host not allowed' });
  }

  try {
    // The INITIAL host check is the SSRF guard — we only fetch a URL HubSpot
    // produced. HubSpot file URLs commonly 302 to a signed CDN whose host isn't a
    // hubspot.* domain; we follow that redirect and trust it (same as photo-proxy).
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 20000);
    let upstream: Response;
    try {
      // safeProxyFetch follows redirects manually and re-validates every hop by
      // resolved IP (blocks an allowlisted open-redirect aimed at internal/metadata
      // addresses) — the host allowlist above can't cover the signed-CDN hop.
      upstream = await safeProxyFetch(u.toString(), { signal: ctrl.signal });
      // A just-uploaded clip may not have propagated to the CDN yet — retry a few
      // times so playback right after capture doesn't permanently fail.
      for (let i = 0; i < 3 && !upstream.ok
        && (upstream.status === 404 || upstream.status === 403 || upstream.status >= 500); i++) {
        await new Promise((r) => setTimeout(r, 600));
        upstream = await safeProxyFetch(u.toString(), { signal: ctrl.signal });
      }
    } finally {
      clearTimeout(to);
    }
    if (!upstream.ok) return res.status(upstream.status).json({ error: `Upstream ${upstream.status}` });

    let buf = await readBodyCapped(upstream, MAX_VIDEO_BYTES);
    // Prefer the container detected from the actual bytes; fall back to the
    // extension only when the bytes are inconclusive. This rescues mislabeled
    // clips (the real cause of iOS's "can't play / slashed play button").
    const contentType = sniffVideoType(buf) || videoTypeFor(u.pathname);
    // iOS Safari won't play an mp4 whose moov atom is at the end (what WebKit's
    // in-app recorder produces). Relocate it to the front so it plays — covers
    // EXISTING clips too, since every HubSpot clip serves through here. No-op for
    // already-faststart clips and a safe passthrough on any failure.
    if (contentType === 'video/mp4') buf = await ensureFaststart(buf);
    const total = buf.length;

    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    // Clips are immutable once uploaded — cache hard (private: per-user evidence).
    res.setHeader('Cache-Control', 'private, max-age=86400');

    // Parse a single Range header (the only form browsers send for <video>).
    // Anything malformed or unsatisfiable falls back to a full 200.
    const range = req.headers.range;
    const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m && total > 0) {
      let start = m[1] === '' ? NaN : parseInt(m[1], 10);
      let end = m[2] === '' ? NaN : parseInt(m[2], 10);
      // Suffix range ("bytes=-500") → last N bytes.
      if (Number.isNaN(start) && !Number.isNaN(end)) { start = Math.max(0, total - end); end = total - 1; }
      else {
        if (Number.isNaN(start)) start = 0;
        if (Number.isNaN(end) || end >= total) end = total - 1;
      }
      if (start > end || start >= total) {
        res.setHeader('Content-Range', `bytes */${total}`);
        return res.status(416).end();
      }
      const chunk = buf.subarray(start, end + 1);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', String(chunk.length));
      if (req.method === 'HEAD') return res.status(206).end();
      return res.status(206).send(chunk);
    }

    res.setHeader('Content-Length', String(total));
    if (req.method === 'HEAD') return res.status(200).end();
    return res.status(200).send(buf);
  } catch (e) {
    if (e instanceof ProxyFetchError) return res.status(e.status).json({ error: e.message });
    return res.status(502).json({ error: 'Fetch failed' });
  }
}
