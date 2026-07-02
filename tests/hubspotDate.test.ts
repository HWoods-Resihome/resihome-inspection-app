import { describe, it, expect } from 'vitest';
import { hubspotToMs, hubspotToIso } from '@/lib/hubspotDate';

describe('hubspotToMs', () => {
  it('parses epoch-ms numeric strings (submitted_at / approved_at shape)', () => {
    expect(hubspotToMs('1719800000000')).toBe(1719800000000);
    expect(hubspotToMs(1719800000000)).toBe(1719800000000);
  });
  it('parses ISO strings (completed_at shape)', () => {
    expect(hubspotToMs('2026-07-01T02:00:00.000Z')).toBe(Date.parse('2026-07-01T02:00:00.000Z'));
  });
  it('normalizes epoch-SECONDS to ms (defensive)', () => {
    expect(hubspotToMs('1719800000')).toBe(1719800000 * 1000);
  });
  it('returns null for empty / unparseable', () => {
    expect(hubspotToMs(null)).toBeNull();
    expect(hubspotToMs(undefined)).toBeNull();
    expect(hubspotToMs('')).toBeNull();
    expect(hubspotToMs('not-a-date')).toBeNull();
  });
  it('the bug it fixes: Date.parse drops an epoch-ms string but hubspotToMs does not', () => {
    expect(Number.isNaN(Date.parse('1719800000000'))).toBe(true); // the old behavior
    expect(hubspotToMs('1719800000000')).not.toBeNull();          // the fix
  });
});

describe('hubspotToIso', () => {
  it('round-trips epoch-ms to ISO', () => {
    expect(hubspotToIso('1719800000000')).toBe(new Date(1719800000000).toISOString());
  });
  it('returns null for junk', () => {
    expect(hubspotToIso('nope')).toBeNull();
  });
});
