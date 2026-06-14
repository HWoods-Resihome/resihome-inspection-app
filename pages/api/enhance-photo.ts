import type { NextApiRequest, NextApiResponse } from 'next';
import sharp from 'sharp';
import { getSessionFromRequest } from '@/lib/auth';
import { mergeBurst, type RawFrame } from '@/lib/burstMerge';

/**
 * Multi-frame burst enhancement ("our own computational photography"). The
 * client captures a short burst of frames of the same scene; we align them and
 * merge so random sensor noise cancels (~√N cleaner) and real detail reinforces,
 * then sharpen. This is the practical core of what Pixel/Samsung do for low
 * light + zoom — robust DENOISE, not literal sub-pixel super-resolution.
 *
 * Works for iPhone AND Android because the burst is captured from the live
 * <video> frames (both platforms expose those), not a platform-specific still API.
 *
 * Input:  { frames: string[] }  — base64 JPEGs, same scene, 2–MAX_FRAMES of them.
 * Output: { base64, width, height, samples, frames }  — enhanced JPEG (no EXIF).
 * Best-effort: on any failure the client falls back to its single-shot capture.
 */

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '48mb', // a handful of moderate-res JPEG frames
    },
  },
};

const MAX_FRAMES = 8;
const MAX_EDGE = 2048;      // working (merge) resolution cap — bounds memory/time
const OUT_EDGE = 3024;      // final output res — match the single-shot path so HD is never softer

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body || {};
    const framesB64: unknown = body.frames;
    if (!Array.isArray(framesB64) || framesB64.length < 2) {
      return res.status(400).json({ error: 'Need at least 2 frames to merge' });
    }
    const inputs = framesB64.slice(0, MAX_FRAMES).filter((f) => typeof f === 'string' && f.length > 0) as string[];
    if (inputs.length < 2) return res.status(400).json({ error: 'No usable frames' });

    // Decode the first frame to fix the working dimensions (capped to MAX_EDGE).
    const first = sharp(Buffer.from(inputs[0], 'base64'), { failOn: 'none' }).rotate(); // honor EXIF if any
    const meta = await first.metadata();
    const srcW = meta.width || 0, srcH = meta.height || 0;
    if (!srcW || !srcH) return res.status(400).json({ error: 'Unreadable first frame' });
    const fit = Math.min(1, MAX_EDGE / Math.max(srcW, srcH));
    const W = Math.max(2, Math.round(srcW * fit));
    const H = Math.max(2, Math.round(srcH * fit));

    // Decode every frame to raw RGB at the SAME dimensions (fill so they line up).
    const rawFrames: RawFrame[] = [];
    for (const b64 of inputs) {
      try {
        const { data } = await sharp(Buffer.from(b64, 'base64'), { failOn: 'none' })
          .rotate()
          .resize(W, H, { fit: 'fill' })
          .removeAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        if (data.length === W * H * 3) rawFrames.push({ data: new Uint8Array(data) });
      } catch { /* skip a bad frame */ }
    }
    if (rawFrames.length < 2) return res.status(400).json({ error: 'Frames could not be decoded' });

    // Align + merge (the denoise). A looser reject threshold includes more
    // aligned samples → more noise cancellation (alignment is robust, so ghosting
    // risk stays low).
    const merged = mergeBurst(rawFrames, { width: W, height: H, channels: 3, maxShift: 24, rejectThreshold: 38 });

    // Upscale the clean, denoised result to the output resolution (so HD is never
    // softer than the single-shot path) and apply a strong unsharp mask — a clean
    // upscaled image takes sharpening far better than a noisy native-res one.
    const outFit = Math.min(OUT_EDGE / Math.max(W, H), 2); // never upscale beyond 2×
    const outW = Math.max(W, Math.round(W * outFit));
    const outH = Math.max(H, Math.round(H * outFit));
    const out = await sharp(Buffer.from(merged.data), { raw: { width: W, height: H, channels: 3 } })
      .resize(outW, outH, { kernel: 'lanczos3' })
      .sharpen({ sigma: 1.3, m1: 0.8, m2: 3 })
      .jpeg({ quality: 92, mozjpeg: true })
      .toBuffer();

    return res.status(200).json({
      base64: out.toString('base64'),
      width: outW,
      height: outH,
      frames: rawFrames.length,
      samples: Math.round(merged.avgSamplesPerPixel * 100) / 100,
    });
  } catch (e: any) {
    console.error('[enhance-photo] failed:', e?.message || e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 200) });
  }
}
