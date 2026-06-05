import { describe, it, expect } from 'vitest';
import { buildQaAnswerProps } from '@/lib/answerProps';

const base = {
  answerIdExternal: 'ext_1',
  inspectionIdExternal: 'insp_1',
  questionIdExternal: 'q_1',
  questionText: 'Any damage?',
  section: 'Kitchen',
  summaryInstanceLabel: 'kitchen',
  answerValue: 'No',
};

describe('buildQaAnswerProps photo/note clearing', () => {
  it('writes photo_urls + photo_count when photos are present', () => {
    const p = buildQaAnswerProps({ ...base, photoUrls: ['a.jpg', 'b.jpg'] }, { isScope: false });
    expect(p.photo_urls).toBe('a.jpg;b.jpg');
    expect(p.photo_count).toBe(2);
  });

  it('CLEARS photo_urls (empty string) when all photos are deleted — regression', () => {
    // The bug: an empty array used to omit photo_urls, so HubSpot PATCH kept the
    // old value and deleted photos reappeared on reload. An explicit [] must clear.
    const p = buildQaAnswerProps({ ...base, photoUrls: [] }, { isScope: false });
    expect(p.photo_urls).toBe('');
    expect(p.photo_count).toBe(0);
  });

  it('leaves photo_urls untouched when not provided (null/undefined)', () => {
    const p = buildQaAnswerProps({ ...base }, { isScope: false });
    expect('photo_urls' in p).toBe(false);
  });

  it('clears a removed note (empty string), but omits when not provided', () => {
    const cleared = buildQaAnswerProps({ ...base, note: '' }, { isScope: false });
    expect(cleared.note).toBe('');
    const absent = buildQaAnswerProps({ ...base }, { isScope: false });
    expect('note' in absent).toBe(false);
  });

  it('never writes Scope-only fields on non-Scope templates', () => {
    const p = buildQaAnswerProps({ ...base, quantity: 3, assignedTo: 'Vendor 1', photoUrls: [] }, { isScope: false });
    expect('quantity' in p).toBe(false);
    expect('assigned_to' in p).toBe(false);
  });
});
