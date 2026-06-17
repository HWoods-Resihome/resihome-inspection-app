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

// Same HubSpot host family as photo-proxy (region/CDN/TLD variants).
const ALLOWED_HOST_RE = /(^|\.)(hubspot[a-z0-9-]*\.(net|com)|hubfs\.com|hs-sites\.com|hubapi\.com)$/i;

export const config = { api: { responseLimit: false } };

// Map a file extension to a video Content-Type. HubSpot often serves clips as
// application/octet-stream, which iOS refuses to play — so we set the type from
// the URL's extension instead of trusting upstream.
function videoTypeFor(pathname: string): string {
  if (/\.webm$/i.test(pathname)) return 'video/webm';
  if (/\.(mov|qt)$/i.test(pathname)) return 'video/quicktime';
  if (/\.m4v$/i.test(pathname)) return 'video/x-m4v';
  return 'video/mp4';
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
      upstream = await fetch(u.toString(), { redirect: 'follow', signal: ctrl.signal });
      // A just-uploaded clip may not have propagated to the CDN yet — retry a few
      // times so playback right after capture doesn't permanently fail.
      for (let i = 0; i < 3 && !upstream.ok
        && (upstream.status === 404 || upstream.status === 403 || upstream.status >= 500); i++) {
        await new Promise((r) => setTimeout(r, 600));
        upstream = await fetch(u.toString(), { redirect: 'follow', signal: ctrl.signal });
      }
    } finally {
      clearTimeout(to);
    }
    if (!upstream.ok) return res.status(upstream.status).json({ error: `Upstream ${upstream.status}` });

    const buf = Buffer.from(await upstream.arrayBuffer());
    const total = buf.length;
    const contentType = videoTypeFor(u.pathname);

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
  } catch {
    return res.status(502).json({ error: 'Fetch failed' });
  }
}
