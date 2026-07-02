/**
 * POST /api/video-transcode  { url }
 *
 * Transcodes an ALREADY-UPLOADED clip to a universally-playable H.264/AAC mp4
 * (yuv420p, faststart) and returns the new URL. Used for LARGE clips that the
 * client streams straight to Vercel Blob (bypassing /api/upload's 4.5MB body
 * limit, and therefore its transcode). The in-app recorder can emit clips iOS
 * can't decode, so without this they play on Android but show a black frame +
 * slashed play button on iOS.
 *
 * Flow: fetch the uploaded clip → transcode (ffmpeg) → re-upload the mp4 to
 * Vercel Blob → best-effort delete the original → return the new URL. SSRF-
 * guarded to our own storage hosts. Authenticated (mirrors /api/upload).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { put, del } from '@vercel/blob';
import { transcodeToH264Mp4 } from '@/lib/videoFaststart';
import { safeProxyFetch, readBodyCapped, ProxyFetchError } from '@/lib/safeProxyFetch';

const MAX_TRANSCODE_BYTES = 200 * 1024 * 1024; // large clips route here (streamed to Blob)

// Only our own storage hosts (HubSpot files + Vercel Blob) — same family as the
// proxies. The SSRF guard: we only ever fetch a URL our own upload produced.
// SECURITY: pinned to `hubspotusercontent*` + hubspot.(com|net); do NOT loosen to
// `hubspot[a-z0-9-]*` (matches attacker-registerable hubspotx.com).
const ALLOWED_HOST_RE = /(^|\.)(hubspotusercontent([0-9]+|-[a-z0-9-]+)?\.(net|com)|hubspot\.(com|net)|hubfs\.com|hs-sites\.com|hubapi\.com|vercel-storage\.com|resihome\.com|resiwalk\.com)$/i;

export const config = { api: { bodyParser: { sizeLimit: '1mb' }, responseLimit: false }, maxDuration: 120 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const raw = String(req.body?.url || '');
  let u: URL;
  try { u = new URL(raw); } catch { return res.status(400).json({ error: 'Invalid url' }); }
  if (u.protocol !== 'https:' || !ALLOWED_HOST_RE.test(u.hostname)) {
    return res.status(403).json({ error: `Host not allowed: ${u.hostname}` });
  }

  try {
    // Follow redirects manually + re-validate each hop by resolved IP (blocks SSRF
    // to internal/metadata addresses via an allowlisted open-redirect).
    const resp = await safeProxyFetch(u.toString());
    if (!resp.ok) return res.status(502).json({ error: `Fetch failed ${resp.status}` });
    const input = await readBodyCapped(resp, MAX_TRANSCODE_BYTES);
    if (input.length === 0) return res.status(502).json({ error: 'Empty source' });

    const out = await transcodeToH264Mp4(input);

    // Re-store the transcoded mp4. If ffmpeg fell back to the original bytes
    // (transcode unavailable), we still re-store as .mp4 so delivery is correct;
    // a no-op transcode just means it stays whatever it was (no worse than now).
    const name = `clip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp4`;
    const blob = await put(name, out, { access: 'public', contentType: 'video/mp4' });

    // Best-effort cleanup of the original upload (only if it lived on Blob — we
    // can only delete our own Blob objects, not HubSpot files).
    if (/vercel-storage\.com$/i.test(u.hostname)) {
      try { await del(raw); } catch { /* orphan is harmless */ }
    }
    return res.status(200).json({ url: blob.url });
  } catch (e: any) {
    if (e instanceof ProxyFetchError) return res.status(e.status).json({ error: e.message });
    console.error('[video-transcode] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 200) });
  }
}
