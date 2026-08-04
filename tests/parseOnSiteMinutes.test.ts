import { describe, it, expect } from 'vitest';
import { parseOnSiteMinutes } from '@/lib/services/aiReview';

describe('parseOnSiteMinutes', () => {
  it('reads a plain minute span', () => {
    expect(parseOnSiteMinutes('7:49 AM → 8:41 AM (~52 min)')).toBe(52);
  });

  it('reads the ~1 min case that should fail the community bar', () => {
    const m = parseOnSiteMinutes('7:12:35 AM → 7:13:07 AM (~1 min)');
    expect(m).toBe(1);
    expect(m! < 3).toBe(true);
  });

  it('combines hours and minutes', () => {
    expect(parseOnSiteMinutes('(~1 hr 5 min)')).toBe(65);
    expect(parseOnSiteMinutes('(~2 hours 30 minutes)')).toBe(150);
  });

  it('converts a sub-minute seconds span to fractional minutes', () => {
    const m = parseOnSiteMinutes('7:12:35 AM → 7:13:07 AM (~32 sec)');
    expect(m).toBeCloseTo(32 / 60, 5);
    expect(m! < 3).toBe(true);
  });

  it('never false-matches the wall-clock times outside the parenthetical', () => {
    // No parenthetical span → unreadable (must not parse "12" from the timestamps).
    expect(parseOnSiteMinutes('7:12:35 AM → 7:13:07 AM')).toBeNull();
  });

  it('returns null for empty / unreadable input', () => {
    expect(parseOnSiteMinutes('')).toBeNull();
    expect(parseOnSiteMinutes('(unreadable)')).toBeNull();
  });
});
