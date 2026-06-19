/**
 * GET /api/admin/ffmpeg-check            → does ffmpeg run + have H.264?
 * GET /api/admin/ffmpeg-check?inspection=<recordId>
 *                                        → also probe the ACTUAL codec/container
 *                                          of every video clip stored on that
 *                                          inspection (so we can tell whether the
 *                                          transcode produced iOS-playable H.264
 *                                          mp4 or left the original format).
 *
 * Admin-only diagnostic for the iOS video pipeline.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { probeFfmpeg, probeMediaCodec } from '@/lib/videoFaststart';
import { fetchAnswersForInspection } from '@/lib/hubspot';
import { getVideoUrl, isVideoEntry } from '@/lib/media';

export const config = { maxDuration: 60 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!/@resihome\.com$/i.test(session.email)) return res.status(403).json({ error: 'Admin only.' });

  try {
    const env = await probeFfmpeg();
    const inspectionId = typeof req.query.inspection === 'string' ? req.query.inspection.trim() : '';
    if (!inspectionId) return res.status(200).json({ ok: true, ffmpeg: env });

    // Collect every video clip URL stored on the inspection's answers.
    const answers = await fetchAnswersForInspection(inspectionId).catch(() => [] as any[]);
    const videoUrls: string[] = [];
    for (const a of (answers as any[]) || []) {
      for (const entry of [...(a.photoUrls || []), ...(a.afterPhotoUrls || [])]) {
        if (isVideoEntry(entry)) { const v = getVideoUrl(entry); if (v) videoUrls.push(v); }
      }
    }
    const uniq = Array.from(new Set(videoUrls)).slice(0, 8);
    const clips = await Promise.all(uniq.map(async (url) => {
      try {
        const r = await fetch(url, { redirect: 'follow' });
        if (!r.ok) return { url, error: `HTTP ${r.status}` };
        const buf = Buffer.from(await r.arrayBuffer());
        const codec = await probeMediaCodec(buf);
        return { url, bytes: buf.length, codec };
      } catch (e: any) {
        return { url, error: String(e?.message || e).slice(0, 120) };
      }
    }));
    return res.status(200).json({ ok: true, ffmpeg: env, clipCount: uniq.length, clips });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
