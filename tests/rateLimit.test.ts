import { describe, it, expect } from 'vitest';
import { checkRateLimit } from '@/lib/rateLimit';

describe('checkRateLimit (per-instance token bucket)', () => {
  it('allows up to max within the window, then limits', () => {
    const opts = { key: 'a@x.com', route: 't1', max: 3, windowMs: 60_000 };
    expect(checkRateLimit(opts).limited).toBe(false); // 1
    expect(checkRateLimit(opts).limited).toBe(false); // 2
    expect(checkRateLimit(opts).limited).toBe(false); // 3
    const r = checkRateLimit(opts);                   // 4 → over
    expect(r.limited).toBe(true);
    expect(r.retryAfterSec).toBeGreaterThan(0);
  });

  it('keys are independent per (route,key)', () => {
    const a = { key: 'u1', route: 'r', max: 1, windowMs: 60_000 };
    const b = { key: 'u2', route: 'r', max: 1, windowMs: 60_000 };
    const c = { key: 'u1', route: 'other', max: 1, windowMs: 60_000 };
    expect(checkRateLimit(a).limited).toBe(false);
    expect(checkRateLimit(a).limited).toBe(true);   // u1/r exhausted
    expect(checkRateLimit(b).limited).toBe(false);  // different key
    expect(checkRateLimit(c).limited).toBe(false);  // different route
  });

  it('resets after the window elapses', async () => {
    const opts = { key: 'w@x.com', route: 'win', max: 1, windowMs: 20 };
    expect(checkRateLimit(opts).limited).toBe(false);
    expect(checkRateLimit(opts).limited).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(checkRateLimit(opts).limited).toBe(false); // window rolled over
  });
});
