/**
 * GET /api/photo-proxy?url=<hubspot file url>
 *
 * Streams a HubSpot-hosted photo back through our own origin so it can be drawn
 * onto a <canvas> for annotation without cross-origin taint (which would make
 * canvas.toBlob throw). SSRF-guarded: only HubSpot file hosts are allowed.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import sharp from 'sharp';

// Matches hubspotusercontent-na1.net, *.hubspotusercontent-na1.net, hubspot.com,
// *.hubfs.com, etc. — the hosts HubSpot serves uploaded files from.
const ALLOWED_HOST_RE = /(^|\.)(hubspotusercontent-na1\.net|hubspotusercontent\.net|hubspot\.com|hubfs\.com)$/i;

export const config = { api: { responseLimit: false } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const raw = String(req.query.url || '');
  let u: URL;
  try { u = new URL(raw); } catch { return res.status(400).json({ error: 'Invalid url' }); }
  if (u.protocol !== 'https:' || !ALLOWED_HOST_RE.test(u.hostname)) {
    return res.status(403).json({ error: 'Host not allowed' });
  }
  try {
    const upstream = await fetch(u.toString());
    if (!upstream.ok) return res.status(upstream.status).json({ error: `Upstream ${upstream.status}` });
    const ct = (upstream.headers.get('content-type') || '').toLowerCase();
    const buf = Buffer.from(await upstream.arrayBuffer());

    // HEIC/HEIF doesn't render in <img> in most browsers. Convert it to JPEG
    // server-side (sharp) so existing .heic photos display + can be annotated.
    const isHeic = ct.includes('heic') || ct.includes('heif')
      || /\.(heic|heif)$/i.test(u.pathname);
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
