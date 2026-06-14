/**
 * Multi-frame burst merge — our own (approximate) "computational photography"
 * denoise, the practical core of what Pixel "Super Res Zoom" / Samsung "Space
 * Zoom" do: capture several frames of the same scene (hand-shake gives tiny
 * offsets), align them, and merge so random sensor noise cancels (~√N cleaner)
 * while real detail reinforces. We do robust DENOISE (motion-rejecting temporal
 * average) rather than true sub-pixel super-resolution — that's what removes the
 * grain inspectors complain about, and it's robust enough to ship.
 *
 * Pure typed-array math (no `sharp`/DOM) so it runs on the server AND is
 * unit-testable in isolation. The API layer (sharp) decodes JPEGs to raw RGB,
 * calls mergeBurst(), then sharpens + re-encodes.
 *
 * Frames MUST all share the same width/height/channels.
 */

export interface RawFrame {
  data: Uint8Array | Uint8ClampedArray; // length = width*height*channels
}

export interface MergeOptions {
  width: number;
  height: number;
  channels: number;        // 3 (RGB) or 4 (RGBA)
  /** Max integer shift (in full-res px) searched during alignment. Default 16. */
  maxShift?: number;
  /** Per-channel luma tolerance for including a frame's pixel in the average
   *  (0..255). Samples beyond this from the reference are rejected as motion /
   *  misalignment so they can't ghost. Default 28. */
  rejectThreshold?: number;
}

/** Luma (Rec.601) of an RGB(A) pixel at byte offset `i`. */
function luma(d: Uint8Array | Uint8ClampedArray, i: number): number {
  return (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
}

/**
 * Build a downscaled luma map (for fast alignment). `scale` is an integer
 * decimation factor (e.g. 4 → quarter size on each axis).
 */
export function downscaledLuma(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  channels: number,
  scale: number,
): { luma: Float32Array; w: number; h: number } {
  const w = Math.max(1, Math.floor(width / scale));
  const h = Math.max(1, Math.floor(height / scale));
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const by0 = y * scale, by1 = Math.min(height, by0 + scale);
    for (let x = 0; x < w; x++) {
      const bx0 = x * scale, bx1 = Math.min(width, bx0 + scale);
      // Average the source block → anti-aliased downscale that also denoises the
      // alignment signal (random noise cancels within the block).
      let s = 0, cnt = 0;
      for (let sy = by0; sy < by1; sy++) for (let sx = bx0; sx < bx1; sx++) { s += luma(data, (sy * width + sx) * channels); cnt++; }
      out[y * w + x] = cnt ? s / cnt : 0;
    }
  }
  return { luma: out, w, h };
}

/** In-place-ish 3×3 box blur of a luma map → low-pass that stabilizes alignment
 *  against per-frame noise (we align on structure, not noise). Returns a new map. */
export function blurLuma3(src: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = y > 0 ? y - 1 : 0, y1 = y < h - 1 ? y + 1 : h - 1;
    for (let x = 0; x < w; x++) {
      const x0 = x > 0 ? x - 1 : 0, x1 = x < w - 1 ? x + 1 : w - 1;
      let s = 0;
      for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) s += src[yy * w + xx];
      out[y * w + x] = s / ((y1 - y0 + 1) * (x1 - x0 + 1));
    }
  }
  return out;
}

/**
 * Estimate the integer translation (dx, dy) that best aligns `frame` onto `ref`
 * using sum-of-absolute-differences over a search window, on downscaled luma.
 * Returns the shift in FULL-RES pixels. (dx, dy) means: the content at ref(x,y)
 * is found in the frame at (x+dx, y+dy).
 */
export function estimateShift(
  refLuma: Float32Array, frameLuma: Float32Array, w: number, h: number,
  maxShiftSmall: number,
): { dx: number; dy: number; scaleUsed: 1 } {
  let bestDx = 0, bestDy = 0, bestErr = Infinity;
  // Sample a sparse grid for speed (every 2px) — alignment is global so we don't
  // need every pixel.
  const step = 2;
  for (let dy = -maxShiftSmall; dy <= maxShiftSmall; dy++) {
    for (let dx = -maxShiftSmall; dx <= maxShiftSmall; dx++) {
      let err = 0, n = 0;
      const x0 = Math.max(0, -dx), x1 = Math.min(w, w - dx);
      const y0 = Math.max(0, -dy), y1 = Math.min(h, h - dy);
      if (x1 - x0 < w * 0.5 || y1 - y0 < h * 0.5) continue; // require >50% overlap
      for (let y = y0; y < y1; y += step) {
        for (let x = x0; x < x1; x += step) {
          const a = refLuma[y * w + x];
          const b = frameLuma[(y + dy) * w + (x + dx)];
          const d = a - b;
          err += d < 0 ? -d : d;
          n++;
        }
      }
      if (n === 0) continue;
      err /= n;
      // Tie-break toward smaller shifts (prefer no motion when ambiguous).
      const bias = (Math.abs(dx) + Math.abs(dy)) * 1e-3;
      if (err + bias < bestErr) { bestErr = err + bias; bestDx = dx; bestDy = dy; }
    }
  }
  return { dx: bestDx, dy: bestDy, scaleUsed: 1 };
}

/** Variance of luma — a cheap sharpness/contrast proxy used to pick the
 *  reference frame (sharper = less motion blur). */
export function frameSharpness(
  data: Uint8Array | Uint8ClampedArray, width: number, height: number, channels: number,
): number {
  // Variance of the Laplacian, sampled sparsely. Higher = sharper.
  let sum = 0, sumSq = 0, n = 0;
  const step = 3;
  for (let y = 1; y < height - 1; y += step) {
    for (let x = 1; x < width - 1; x += step) {
      const i = (y * width + x) * channels;
      const c = luma(data, i);
      const up = luma(data, ((y - 1) * width + x) * channels);
      const dn = luma(data, ((y + 1) * width + x) * channels);
      const lf = luma(data, (y * width + (x - 1)) * channels);
      const rt = luma(data, (y * width + (x + 1)) * channels);
      const lap = 4 * c - up - dn - lf - rt;
      sum += lap; sumSq += lap * lap; n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

export interface MergeResult {
  data: Uint8Array;     // merged RGB(A), same dims/channels as input
  referenceIndex: number;
  shifts: Array<{ dx: number; dy: number }>;
  /** Mean number of frames averaged per pixel — a quality signal (closer to N
   *  = more noise reduction; near 1 = lots of motion / poor alignment). */
  avgSamplesPerPixel: number;
}

/**
 * Align + merge a burst into one denoised frame. The sharpest frame is the
 * reference (so output sharpness ≈ best input, not blurred by a soft frame);
 * other frames are globally aligned to it and averaged per pixel with motion
 * rejection (samples too far from the reference are dropped to avoid ghosting).
 */
export function mergeBurst(frames: RawFrame[], opts: MergeOptions): MergeResult {
  const { width, height, channels } = opts;
  const maxShift = opts.maxShift ?? 16;
  const reject = opts.rejectThreshold ?? 28;
  const n = frames.length;

  if (n === 0) throw new Error('mergeBurst: no frames');
  if (n === 1) {
    return { data: Uint8Array.from(frames[0].data), referenceIndex: 0, shifts: [{ dx: 0, dy: 0 }], avgSamplesPerPixel: 1 };
  }

  // Pick the sharpest frame as the reference.
  let refIdx = 0, bestSharp = -Infinity;
  for (let f = 0; f < n; f++) {
    const s = frameSharpness(frames[f].data, width, height, channels);
    if (s > bestSharp) { bestSharp = s; refIdx = f; }
  }

  // Downscale lumas for alignment. Cap the small map to ~256 px on the long edge.
  const scale = Math.max(1, Math.round(Math.max(width, height) / 256));
  const refSmall = downscaledLuma(frames[refIdx].data, width, height, channels, scale);
  const refBlur = blurLuma3(refSmall.luma, refSmall.w, refSmall.h);
  const maxShiftSmall = Math.max(1, Math.round(maxShift / scale));

  const shifts: Array<{ dx: number; dy: number }> = new Array(n);
  for (let f = 0; f < n; f++) {
    if (f === refIdx) { shifts[f] = { dx: 0, dy: 0 }; continue; }
    const small = downscaledLuma(frames[f].data, width, height, channels, scale);
    const blur = blurLuma3(small.luma, small.w, small.h);
    // Align on the low-passed luma so noise can't sway the match.
    const { dx, dy } = estimateShift(refBlur, blur, refSmall.w, refSmall.h, maxShiftSmall);
    shifts[f] = { dx: dx * scale, dy: dy * scale };
  }

  const ref = frames[refIdx].data;
  const out = new Uint8Array(width * height * channels);
  let totalSamples = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const oi = (y * width + x) * channels;
      const refL = luma(ref, oi);
      let r = ref[oi], g = ref[oi + 1], b = ref[oi + 2];
      let aSum = channels === 4 ? ref[oi + 3] : 0;
      let count = 1;
      for (let f = 0; f < n; f++) {
        if (f === refIdx) continue;
        const sx = x + shifts[f].dx;
        const sy = y + shifts[f].dy;
        if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
        const si = (sy * width + sx) * channels;
        const d = frames[f].data;
        const sL = luma(d, si);
        if (Math.abs(sL - refL) > reject) continue; // motion / misalignment → skip
        r += d[si]; g += d[si + 1]; b += d[si + 2];
        if (channels === 4) aSum += d[si + 3];
        count++;
      }
      out[oi] = Math.round(r / count);
      out[oi + 1] = Math.round(g / count);
      out[oi + 2] = Math.round(b / count);
      if (channels === 4) out[oi + 3] = Math.round(aSum / count);
      totalSamples += count;
    }
  }

  return {
    data: out,
    referenceIndex: refIdx,
    shifts,
    avgSamplesPerPixel: totalSamples / (width * height),
  };
}
