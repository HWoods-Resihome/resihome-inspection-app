import { describe, it, expect } from 'vitest';
import { mergeBurst, estimateShift, downscaledLuma, type RawFrame } from '@/lib/burstMerge';

// Deterministic PRNG so noise is reproducible across runs.
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const W = 64, H = 64, CH = 3;

// A TEXTURED "clean" scene (no noise): gradients + a checkerboard + diagonal
// stripes. Real photos have texture, which is what makes global alignment
// well-posed (a flat gradient alone is the aperture problem — no algorithm can
// align it, and it doesn't need to). This exercises the realistic case.
function cleanScene(): Uint8Array {
  const d = new Uint8Array(W * H * CH);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * CH;
      const checker = ((x >> 2) + (y >> 2)) & 1 ? 60 : 0;       // 4px checkerboard
      const stripe = ((x + y) % 6 < 3) ? 30 : 0;                // diagonal stripes
      d[i] = Math.min(255, Math.round((x / W) * 120 + 30 + checker));
      d[i + 1] = Math.min(255, Math.round((y / H) * 120 + 30 + stripe));
      d[i + 2] = Math.min(255, Math.round(((x + y) / (W + H)) * 120 + 30 + checker + stripe) >> 0);
    }
  }
  return d;
}

// Shift a clean scene by (dx,dy) and add gaussian-ish noise of amplitude `amp`.
function noisyShifted(clean: Uint8Array, dx: number, dy: number, amp: number, rng: () => number): Uint8Array {
  const d = new Uint8Array(W * H * CH);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = x - dx, sy = y - dy; // content at (x,y) came from clean(x-dx,y-dy)
      const oi = (y * W + x) * CH;
      const cx = Math.min(W - 1, Math.max(0, sx));
      const cy = Math.min(H - 1, Math.max(0, sy));
      const ci = (cy * W + cx) * CH;
      for (let c = 0; c < CH; c++) {
        const noise = (rng() + rng() + rng() - 1.5) * amp; // ~gaussian
        d[oi + c] = Math.max(0, Math.min(255, Math.round(clean[ci + c] + noise)));
      }
    }
  }
  return d;
}

function rmseVsClean(img: Uint8Array, clean: Uint8Array): number {
  // Compare only the central region (avoid edge wrap from shifts).
  let sq = 0, n = 0;
  for (let y = 8; y < H - 8; y++) {
    for (let x = 8; x < W - 8; x++) {
      const i = (y * W + x) * CH;
      for (let c = 0; c < CH; c++) { const d = img[i + c] - clean[i + c]; sq += d * d; n++; }
    }
  }
  return Math.sqrt(sq / n);
}

describe('burstMerge', () => {
  it('estimateShift recovers a known integer translation', () => {
    const clean = cleanScene();
    const rng = mulberry32(1);
    const a = noisyShifted(clean, 0, 0, 2, rng);
    const b = noisyShifted(clean, 3, -2, 2, rng);
    const la = downscaledLuma(a, W, H, CH, 1);
    const lb = downscaledLuma(b, W, H, CH, 1);
    const { dx, dy } = estimateShift(la.luma, lb.luma, W, H, 8);
    // content at ref(x,y) is found in b at (x+dx,y+dy); b was shifted by (+3,-2),
    // so to map ref→b we expect (+3,-2).
    expect(Math.abs(dx - 3)).toBeLessThanOrEqual(1);
    expect(Math.abs(dy - (-2))).toBeLessThanOrEqual(1);
  });

  it('merging a noisy burst is markedly cleaner than a single frame', () => {
    const clean = cleanScene();
    const rng = mulberry32(42);
    const amp = 22;
    const shifts = [[0, 0], [1, 0], [-1, 1], [2, -1], [0, 2], [-2, -1]];
    const frames: RawFrame[] = shifts.map(([dx, dy]) => ({ data: noisyShifted(clean, dx, dy, amp, rng) }));

    const merged = mergeBurst(frames, { width: W, height: H, channels: CH, maxShift: 8, rejectThreshold: 60 });

    // The merged image lives in the REFERENCE frame's coordinates, so compare it
    // against `clean` shifted into that same frame (noise-free) — not raw clean.
    const [rdx, rdy] = shifts[merged.referenceIndex];
    const cleanRef = noisyShifted(clean, rdx, rdy, 0, mulberry32(0));
    const refRmse = rmseVsClean(frames[merged.referenceIndex].data as Uint8Array, cleanRef);
    const mergedRmse = rmseVsClean(merged.data, cleanRef);

    // Temporal averaging of ~6 aligned frames should cut RMSE substantially.
    expect(mergedRmse).toBeLessThan(refRmse * 0.7);
    // And it should actually be averaging multiple samples per pixel.
    expect(merged.avgSamplesPerPixel).toBeGreaterThan(2.5);
  });

  it('single-frame burst is a no-op passthrough', () => {
    const clean = cleanScene();
    const merged = mergeBurst([{ data: clean }], { width: W, height: H, channels: CH });
    expect(merged.avgSamplesPerPixel).toBe(1);
    expect(Array.from(merged.data.slice(0, 30))).toEqual(Array.from(clean.slice(0, 30)));
  });
});
