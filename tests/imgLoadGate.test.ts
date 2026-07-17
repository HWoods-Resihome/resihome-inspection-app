import { describe, it, expect } from 'vitest';
import { acquireImgSlot, releaseImgSlot } from '@/lib/imgLoadGate';

// The gate's MAX is 8 (see lib/imgLoadGate). These tests treat it behaviorally:
// the first 8 acquires resolve immediately, the 9th queues until a release.
const MAX = 8;
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Acquire and record whether it resolved synchronously (before a macrotask). */
function acquireTracked() {
  const state = { resolved: false };
  const p = acquireImgSlot().then(() => { state.resolved = true; });
  return { p, state };
}

describe('imgLoadGate concurrency', () => {
  it('resolves the first MAX acquires immediately and queues the rest', async () => {
    const got = Array.from({ length: MAX + 3 }, () => acquireTracked());
    await tick();
    // First MAX resolved, the extra 3 are still queued (pending).
    expect(got.slice(0, MAX).every((g) => g.state.resolved)).toBe(true);
    expect(got.slice(MAX).every((g) => !g.state.resolved)).toBe(true);

    // Release one → exactly one queued waiter resolves.
    releaseImgSlot();
    await tick();
    expect(got[MAX].state.resolved).toBe(true);
    expect(got[MAX + 1].state.resolved).toBe(false);

    // Drain everything and return to baseline (release once per outstanding slot).
    releaseImgSlot(); releaseImgSlot();      // frees the last two waiters
    await tick();
    expect(got.every((g) => g.state.resolved)).toBe(true);
    // Balance the books: MAX+3 acquired, 3 released above → release the remaining MAX.
    for (let i = 0; i < MAX; i++) releaseImgSlot();
  });

  it('does NOT leak: after balanced release, a fresh MAX-burst all resolve immediately', async () => {
    const burst = Array.from({ length: MAX }, () => acquireTracked());
    await tick();
    // If a prior test leaked a slot, fewer than MAX would resolve here.
    expect(burst.every((b) => b.state.resolved)).toBe(true);
    // A one-over acquire must still queue (proves the ceiling is intact, not raised by a leak).
    const over = acquireTracked();
    await tick();
    expect(over.state.resolved).toBe(false);
    // Clean up.
    releaseImgSlot();                        // frees `over`
    await tick();
    for (let i = 0; i < MAX; i++) releaseImgSlot();
  });

  it('release with no waiters just lowers the active count (no negative underflow)', async () => {
    // Over-release from empty — must not push active negative (Math.max guard).
    releaseImgSlot(); releaseImgSlot(); releaseImgSlot();
    // Now a full MAX-burst still resolves and the ceiling still holds.
    const burst = Array.from({ length: MAX }, () => acquireTracked());
    await tick();
    expect(burst.every((b) => b.state.resolved)).toBe(true);
    const over = acquireTracked();
    await tick();
    expect(over.state.resolved).toBe(false);
    releaseImgSlot();
    await tick();
    for (let i = 0; i < MAX; i++) releaseImgSlot();
  });
});
