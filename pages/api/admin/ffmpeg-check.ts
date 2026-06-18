/**
 * GET /api/admin/ffmpeg-check  (admin only)
 *
 * Diagnostic for the iOS video pipeline: reports whether the ffmpeg-static binary
 * actually EXECUTES in this serverless runtime and whether H.264 (libx264) is
 * available — the two things that decide if clips get transcoded to an
 * iOS-playable format. If ffmpeg can't run (Vercel read-only +x stripping) or has
 * no H.264 encoder, every clip silently falls back to its original (unplayable)
 * bytes.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { probeFfmpeg } from '@/lib/videoFaststart';

export const config = { maxDuration: 30 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!/@resihome\.com$/i.test(session.email)) return res.status(403).json({ error: 'Admin only.' });
  try {
    const result = await probeFfmpeg();
    return res.status(200).json({ ok: true, ...result });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
