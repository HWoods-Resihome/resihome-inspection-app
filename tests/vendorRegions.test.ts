import { describe, it, expect } from 'vitest';
import { parseRegions, joinRegions, normalizeRegionsString, canonicalRegion } from '@/lib/vendorRegions';

describe('vendorRegions', () => {
  it('fixes the Huntsville typo', () => {
    expect(canonicalRegion('AL: Hunstville')).toBe('AL: Huntsville');
    expect(parseRegions('AL: Birmingham; AL: Hunstville')).toEqual(['AL: Birmingham', 'AL: Huntsville']);
  });

  it('fixes the broken Oklahoma City prefix', () => {
    expect(canonicalRegion('O : Oklahoma City')).toBe('OK: Oklahoma City');
    expect(canonicalRegion('O: Oklahoma City')).toBe('OK: Oklahoma City');
  });

  it('splits colon-joined multi-regions', () => {
    expect(parseRegions('TX: Dallas: TX: Houston')).toEqual(['TX: Dallas', 'TX: Houston']);
  });

  it('dedupes case-insensitively and normalizes spacing', () => {
    expect(parseRegions('ga: atlanta;GA:  Atlanta ; GA: Savannah')).toEqual(['GA: Atlanta', 'GA: Savannah']);
    expect(canonicalRegion('tx :Houston')).toBe('TX: Houston');
  });

  it('dedupes the typo against the correct spelling', () => {
    // Both variants in one string collapse to the canonical one.
    expect(parseRegions('AL: Hunstville; AL: Huntsville')).toEqual(['AL: Huntsville']);
  });

  it('joinRegions produces the canonical stored form', () => {
    expect(joinRegions(['TX: Dallas: TX: Houston', 'AL: Hunstville'])).toBe('TX: Dallas; TX: Houston; AL: Huntsville');
  });

  it('normalizeRegionsString is a fixpoint (repaired value needs no re-repair)', () => {
    const once = normalizeRegionsString('TX: Dallas: TX: Houston; O : Oklahoma City');
    expect(normalizeRegionsString(once)).toBe(once);
    expect(once).toBe('TX: Dallas; TX: Houston; OK: Oklahoma City');
  });

  it('handles empty/blank input', () => {
    expect(parseRegions('')).toEqual([]);
    expect(joinRegions([])).toBe('');
  });
});
