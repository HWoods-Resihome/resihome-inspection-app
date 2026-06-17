import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { uploadFile } from '@/lib/hubspot';
import { ensureFaststart } from '@/lib/videoFaststart';

export const config = {
  api: {
    bodyParser: {
      // 48MB headroom: photos are tiny post-compression (~600KB), but short
      // video clips (≤10s, bitrate-capped to ~2.5Mbps → ~3MB) inflate ~33% as
      // base64, so this leaves comfortable margin for the largest expected clip.
      sizeLimit: '48mb',
    },
  },
  // Headroom for the mp4 faststart remux (lossless -c copy is quick, but give a
  // generous ceiling so a larger clip never trips the default function timeout).
  maxDuration: 60,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Defense-in-depth: middleware already gates this, but verify the
  // session here too so the route is never reachable unauthenticated
  // even if the middleware matcher changes.
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    // Frontend sends { filename, contentType, base64 } -- base64-encoded file bytes
    const { filename, contentType, base64 } = req.body || {};
    if (!base64 || !filename) {
      return res.status(400).json({ error: 'Missing filename or base64 body' });
    }

    // Only accept image + short-clip video uploads. Without this allowlist, any
    // authenticated user could push arbitrary file types (e.g. HTML) to HubSpot
    // Files, which then serves them from a public CDN URL — a stored-content /
    // file-abuse vector. Video is limited to the formats MediaRecorder emits.
    const ALLOWED_TYPES = new Set([
      'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
      'video/mp4', 'video/webm', 'video/quicktime',
    ]);
    const safeContentType = String(contentType || 'image/jpeg').toLowerCase().split(';')[0].trim();
    if (!ALLOWED_TYPES.has(safeContentType)) {
      return res.status(400).json({ error: `Unsupported content type: ${safeContentType}` });
    }

    // Sanitize the filename: strip any path components and disallow anything but
    // a conservative character set, cap the length, and guarantee an extension.
    const rawName = String(filename).split(/[\\/]/).pop() || 'photo.jpg';
    let safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
    if (!/\.[a-zA-Z0-9]{1,5}$/.test(safeName)) {
      safeName += '.jpg';
    }

    let buffer = Buffer.from(base64, 'base64');
    // Reject empty / clearly-bogus payloads.
    if (buffer.length === 0) {
      return res.status(400).json({ error: 'Empty file payload' });
    }
    // Store mp4 clips faststart (moov atom at the front) so iOS Safari can play
    // them — the in-app recorder emits moov-at-end mp4 that iOS won't play from a
    // URL. Lossless remux (no re-encode); safe passthrough if ffmpeg is absent.
    if (safeContentType === 'video/mp4') buffer = await ensureFaststart(buffer);
    const url = await uploadFile(buffer, safeName, safeContentType);
    return res.status(200).json({ url });
  } catch (e: any) {
    console.error('POST /api/upload failed:', e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}
