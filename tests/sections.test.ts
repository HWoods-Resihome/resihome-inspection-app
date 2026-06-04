import { describe, it, expect } from 'vitest';
import { deriveDefaultSections, parseSectionListJson, serializeSectionList, resolveSections } from '@/lib/sections';

describe('section resolution', () => {
  it('static (non-repeating) sections carry an EMPTY location — the gotcha that broke finalize grouping', () => {
    const secs = deriveDefaultSections(3, 2);
    const yard = secs.find((s) => s.key === 'yard_exterior')!;
    const whole = secs.find((s) => s.key === 'whole_house')!;
    expect(yard.location).toBe('');
    expect(whole.location).toBe('');
    // …so they MUST be distinguished by label||location, never by location alone.
    expect(`${yard.label}||${yard.location}`).not.toBe(`${whole.label}||${whole.location}`);
  });

  it('label||location keys are unique across all default sections', () => {
    const secs = deriveDefaultSections(3, 2);
    const keys = secs.map((s) => `${s.label}||${s.location}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('interleaves bedrooms/bathrooms with real locations', () => {
    const secs = deriveDefaultSections(3, 2);
    const bedrooms = secs.filter((s) => s.key === 'bedroom');
    const bathrooms = secs.filter((s) => s.key === 'bathroom');
    expect(bedrooms.map((s) => s.location)).toEqual(['Bedroom 1', 'Bedroom 2', 'Bedroom 3']);
    expect(bathrooms.map((s) => s.location)).toEqual(['Bathroom 1', 'Bathroom 2']);
  });

  it('adds a Half Bath for a .5 bathroom count', () => {
    const secs = deriveDefaultSections(2, 1.5);
    expect(secs.some((s) => s.location === 'Half Bath')).toBe(true);
  });

  it('round-trips through serialize/parse', () => {
    const secs = deriveDefaultSections(2, 1);
    const parsed = parseSectionListJson(serializeSectionList(secs))!;
    expect(parsed.map((s) => `${s.label}||${s.location}`)).toEqual(secs.map((s) => `${s.label}||${s.location}`));
  });

  it('resolveSections falls back to defaults on empty json', () => {
    expect(resolveSections(null, 1, 1).length).toBe(deriveDefaultSections(1, 1).length);
    expect(resolveSections('not json', 1, 1).length).toBe(deriveDefaultSections(1, 1).length);
  });
});
