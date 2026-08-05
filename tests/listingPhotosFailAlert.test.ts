import { describe, it, expect } from 'vitest';
import { findListingPhotosAnswer, isListingPhotosFail } from '@/lib/listingPhotosFailAlert';

const A = (over: Record<string, any>) => ({ answerType: 'qa', answerSummary: '', answerValue: '', note: '', photoUrls: [], ...over }) as any;

describe('listingPhotosFailAlert triggers', () => {
  it('finds the listing-photos answer by summary text (case-insensitive)', () => {
    const answers = [
      A({ answerSummary: 'Evaluate Listing Price', answerValue: 'Keep' }),
      A({ answerSummary: 'Listing Photos Accurate?', answerValue: 'Fail - Needs Attention' }),
    ];
    const hit = findListingPhotosAnswer(answers);
    expect(hit?.answerValue).toBe('Fail - Needs Attention');
  });

  it('ignores non-qa answer records', () => {
    const answers = [A({ answerType: 'section_photo', answerSummary: 'Listing Photos Accurate?', answerValue: 'Fail - Needs Attention' })];
    expect(findListingPhotosAnswer(answers)).toBeUndefined();
  });

  it('treats "Fail - Needs Attention" as a fail', () => {
    expect(isListingPhotosFail(A({ answerValue: 'Fail - Needs Attention' }))).toBe(true);
  });

  it('does NOT treat "Good - No Issues" as a fail', () => {
    expect(isListingPhotosFail(A({ answerValue: 'Good - No Issues' }))).toBe(false);
  });

  it('is false for a blank/missing answer', () => {
    expect(isListingPhotosFail(A({ answerValue: '' }))).toBe(false);
    expect(isListingPhotosFail(undefined)).toBe(false);
  });
});
