import type { NextApiRequest, NextApiResponse } from 'next';
import { put } from '@vercel/blob';
import { getSessionFromRequest } from '@/lib/auth';
import { transcodeToH264Mp4 } from '@/lib/videoFaststart';
import { enforceRateLimit } from '@/lib/rateLimit';
import { reportServerError } from '@/lib/serverErrorReporter';

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
  // Per-user throttle so a runaway client (or a huge offline backlog flushing at
  // once) can't hammer HubSpot Files into 429s. Generous: the foreground flush is
  // single-flight (~30-60/min) and a capture burst is a few per second.
  if (enforceRateLimit(res, { key: session.email, route: 'upload', max: 300 })) return;
  try {
    // Frontend sends { filename, contentType, base64 } -- base64-encoded file bytes.
    // Optional dedupeKey (the photo's stable localId) is folded into the stored
    // filename so a repeat upload of the SAME photo resolves to the SAME hosted
    // URL via HubSpot's RETURN_EXISTING (see below) — no duplicate hosted copies
    // when the foreground flush and the iOS background uploader both run.
    const { filename, contentType, base64, dedupeKey } = req.body || {};
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
      // Vendor proof-of-service attachment (invoice) — a PDF or Word document.
      'application/pdf',
      'application/msword',                                                        // .doc
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',   // .docx
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
    // Fold a sanitized dedupeKey into the name (prefix) so the SAME photo always
    // produces the SAME stored filename across the foreground flush and the iOS
    // background uploader. HubSpot's RETURN_EXISTING (EXACT_FOLDER) then returns
    // the already-stored file's URL on the second upload instead of duplicating.
    if (dedupeKey != null) {
      const safeKey = String(dedupeKey).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
      if (safeKey) safeName = `${safeKey}__${safeName}`.slice(0, 180);
    }

    let buffer = Buffer.from(base64, 'base64');
    // Reject empty / clearly-bogus payloads.
    if (buffer.length === 0) {
      return res.status(400).json({ error: 'Empty file payload' });
    }
    // Video clips: TRANSCODE to a universally playable H.264/AAC mp4 (yuv420p,
    // faststart). The in-app recorder can emit clips iOS itself can't decode
    // (non-baseline profile / wrong pixel format / webm fallback) — re-encoding
    // guarantees iOS playback. Always output mp4. Safe: falls back to the
    // original bytes on any ffmpeg problem.
    let outName = safeName;
    let outType = safeContentType;
    if (safeContentType.startsWith('video/')) {
      buffer = await transcodeToH264Mp4(buffer);
      outType = 'video/mp4';
      outName = safeName.replace(/\.[a-zA-Z0-9]{1,5}$/, '') + '.mp4';
    }
    // Store in Vercel Blob (public URL), NOT HubSpot File Manager — keeps
    // resident-home photos off HubSpot's storage cap while the read/display path
    // is unchanged (it just renders whatever URL we return). Key is deterministic
    // from the (dedupe-folded) filename so an offline retry of the SAME capture
    // overwrites the same object and yields the same URL — no duplicates. A store
    // failure throws → caught below → surfaced as a 500 (loud, never a silent
    // success with no image).
    const idMatch = /idbph_(\d+)__/.exec(outName);
    const key = idMatch ? `inspections/${idMatch[1]}/${outName}` : `photos/${outName}`;
    const blob = await put(key, buffer, {
      access: 'public',
      contentType: outType,
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return res.status(200).json({ url: blob.url });
  } catch (e: any) {
    reportServerError(e, { route: 'POST /api/upload', method: 'POST', userEmail: session.email });
    return res.status(500).json({ error: String(e.message || e) });
  }
}
