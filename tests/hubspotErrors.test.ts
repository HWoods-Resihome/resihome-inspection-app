import { describe, it, expect } from 'vitest';
import { rejectedPropNames } from '@/lib/hubspotErrors';

describe('rejectedPropNames', () => {
  it('extracts an invalid enum property from HubSpot JSON-escaped validation detail', () => {
    // The exact shape HubSpot returns (inner detail is a JSON-escaped string).
    const detail = '{"status":"error","message":"Property values were not valid: [{\\"isValid\\":false,\\"message\\":\\"Property \\\\\\"review_decision\\\\\\" was not one of the allowed options: [approve, reject]\\",\\"error\\":\\"INVALID_OPTION\\",\\"name\\":\\"review_decision\\"}]","category":"VALIDATION_ERROR"}';
    const names = rejectedPropNames({ detail, message: 'Upstream request failed (400)' });
    expect(names).toContain('review_decision');
  });

  it('extracts an unknown property (PROPERTY_DOESNT_EXIST)', () => {
    const detail = '{"status":"error","message":"Property \\"enroll_criteria_json\\" does not exist","category":"VALIDATION_ERROR"}';
    expect(rejectedPropNames({ detail })).toContain('enroll_criteria_json');
  });

  it('returns [] for unrelated errors (so they rethrow, not silently strip)', () => {
    expect(rejectedPropNames({ detail: 'rate limited', message: 'Upstream request failed (429)' })).toEqual([]);
    expect(rejectedPropNames({})).toEqual([]);
  });
});
