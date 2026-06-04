import { describe, it, expect } from 'vitest';
import { titleCase } from '@/lib/titleCase';

describe('titleCase', () => {
  it('capitalizes each word', () => {
    expect(titleCase('garage remote present')).toBe('Garage Remote Present');
  });
  it('keeps filler words lowercase (but not the first word)', () => {
    expect(titleCase('pick the type of device')).toBe('Pick the Type of Device');
    expect(titleCase('of mice and men')).toBe('Of Mice and Men'); // first word always capitalized
  });
  it('preserves all-caps acronyms', () => {
    expect(titleCase('hvac functioning')).toBe('Hvac Functioning'); // lowercase input → normal
    expect(titleCase('HVAC functioning')).toBe('HVAC Functioning'); // acronym preserved
    expect(titleCase('N/A')).toBe('N/A');
    expect(titleCase('OK')).toBe('OK');
  });
  it('title-cases hyphenated words per segment', () => {
    expect(titleCase('needs pump-out')).toBe('Needs Pump-Out');
  });
  it('handles empty / null', () => {
    expect(titleCase('')).toBe('');
    expect(titleCase(null)).toBe('');
    expect(titleCase(undefined)).toBe('');
  });
});
