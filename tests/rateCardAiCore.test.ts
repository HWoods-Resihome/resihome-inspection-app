/**
 * Deterministic behavior gate for the shared rate-card AI core
 * (lib/rateCardAiCore) — the server-side safety net that BOTH the microphone
 * (voice) AI and the camera AIs run through. These are the rules that catch the
 * model's mistakes, so a regression here is exactly the kind of bug that reaches
 * inspectors. Every case below encodes a real failure we've fixed, so it can't
 * silently come back. Runs in CI on every change (no API keys, fully offline).
 *
 * The companion LIVE eval (tests/eval/catalogMatch.gold.json, `npm run eval`)
 * covers the semantic MATCH; this covers the deterministic GUARDS layered on it.
 */
import { describe, it, expect } from 'vitest';
import {
  correctCleanLevel, correctBlinds, wholeHouseExempt, isWholeHouseItem,
  measuredUnitOf, measurementWord, isStairCount, resolveTenantPct,
  normalizeVendor, roomFromUtterance, countItemPhrases, aliasFor,
} from '@/lib/rateCardAiCore';
import { VENDORS } from '@/lib/vendors';
import type { RateCardLineItem } from '@/lib/types';

// Minimal valid catalog item; override only the fields a test cares about.
const mk = (over: Partial<RateCardLineItem>): RateCardLineItem => ({
  recordId: 'r', lineItemCode: 'X', laborShortDescription: '', laborFullDescription: '', laborSubtext: '',
  category: '', subcategory: '', laborCode: '', laborMeas: 'EA', laborHours: 0, laborHourlyRateList: 0,
  materialCode: '', materialDescription: '', materialMeas: '', materialRate: 0, materialQty: 1, materialCost: 0,
  billTo: '', workType: '', isLaborOnly: false, isBidItem: false, isActive: true, catalogVersion: 'v1',
  ...over,
});

const liteClean = mk({ lineItemCode: 'CLN-LITE', laborShortDescription: 'Lite Sales Clean', category: 'Cleaning', subcategory: 'Sales Clean' });
const l2Clean = mk({ lineItemCode: 'CLN-L2', laborShortDescription: 'Level 2 Sales Clean', category: 'Cleaning', subcategory: 'Sales Clean', laborMeas: 'SF' });
const wholeHouseClean = mk({ lineItemCode: 'CLN-WH', laborShortDescription: 'Whole House Sales Clean', category: 'Cleaning', subcategory: 'Sales Clean', laborMeas: 'SF' });
const mistMatch = mk({ lineItemCode: 'PNT-MM', laborShortDescription: 'Mist Match Painting (Lite)', category: 'Painting', subcategory: 'Walls', laborMeas: 'SF' });
const faux = mk({ lineItemCode: 'BLD-FAUX', laborShortDescription: 'Replace Faux Wood Blind', category: 'Window Coverings', subcategory: 'Blinds' });
const valance = mk({ lineItemCode: 'BLD-VAL', laborShortDescription: 'Replace Vertical Blind Valance', category: 'Window Coverings', subcategory: 'Blinds' });
const bulbs = mk({ lineItemCode: 'ELC-BULB', laborShortDescription: 'Replace Light Bulbs Screw in', category: 'Electrical', subcategory: 'Bulbs' });
const carpet = mk({ lineItemCode: 'FLR-CARP', laborShortDescription: 'Replace Carpet', category: 'Flooring', subcategory: 'Carpet', laborMeas: 'SF' });
const stairCarpet = mk({ lineItemCode: 'FLR-STAIR', laborShortDescription: 'Carpet on Stairs', category: 'Flooring', subcategory: 'Carpet' });
const catalog = [liteClean, l2Clean, wholeHouseClean, mistMatch, faux, valance, bulbs, carpet, stairCarpet];

describe('correctCleanLevel (clean tier)', () => {
  it('"level 2 sales clean" upgrades a Lite match to the Level-2 sibling', () => {
    expect(correctCleanLevel(liteClean, 'level 2 sales clean', catalog).lineItemCode).toBe('CLN-L2');
    expect(correctCleanLevel(liteClean, 'level two clean', catalog).lineItemCode).toBe('CLN-L2');
  });
  it('"level one clean" downgrades a Level-2 match to the Lite sibling', () => {
    expect(correctCleanLevel(l2Clean, 'level one sales clean', catalog).lineItemCode).toBe('CLN-LITE');
  });
  it('leaves the match unchanged when no level was stated', () => {
    expect(correctCleanLevel(liteClean, 'sales clean', catalog).lineItemCode).toBe('CLN-LITE');
  });
  it('never touches non-clean items', () => {
    expect(correctCleanLevel(bulbs, 'level 2', catalog).lineItemCode).toBe('ELC-BULB');
  });
  it('is a no-op when no sibling tier exists', () => {
    expect(correctCleanLevel(liteClean, 'level 2', [liteClean]).lineItemCode).toBe('CLN-LITE');
  });
});

describe('correctBlinds (faux-wood default)', () => {
  it('a bare "blind" swaps a valance/vertical match to faux wood', () => {
    expect(correctBlinds(valance, 'replace this blind', catalog).lineItemCode).toBe('BLD-FAUX');
  });
  it('keeps the part when the inspector named it (vertical/valance/wand)', () => {
    expect(correctBlinds(valance, 'replace the vertical blind', catalog).lineItemCode).toBe('BLD-VAL');
  });
  it('leaves an already-correct faux-wood match alone', () => {
    expect(correctBlinds(faux, 'blind', catalog).lineItemCode).toBe('BLD-FAUX');
  });
  it('ignores items that are not blinds', () => {
    expect(correctBlinds(bulbs, 'light bulb out', catalog).lineItemCode).toBe('ELC-BULB');
  });
});

describe('wholeHouseExempt (skip the sqft question)', () => {
  it('true when the item itself is whole-house', () => {
    expect(isWholeHouseItem(wholeHouseClean)).toBe(true);
    expect(wholeHouseExempt({ item: wholeHouseClean })).toBe(true);
  });
  it('true when working IN the Whole House section', () => {
    expect(wholeHouseExempt({ item: mistMatch, sectionName: 'Whole House' })).toBe(true);
  });
  it('true when the inspector said "whole house" AND a Whole House room exists', () => {
    expect(wholeHouseExempt({ item: mistMatch, utterance: 'whole house mismatch', hasWholeHouseRoom: true })).toBe(true);
  });
  it('false when they said "whole house" but there is NO Whole House room to route into', () => {
    expect(wholeHouseExempt({ item: mistMatch, utterance: 'whole house mismatch', hasWholeHouseRoom: false })).toBe(false);
  });
  it('false for an ordinary single-room measured item', () => {
    expect(wholeHouseExempt({ item: carpet, sectionName: 'Bedroom 2' })).toBe(false);
  });
});

describe('measured unit + stairs', () => {
  it('detects SF/LF/SY as measured, EA as not', () => {
    expect(measuredUnitOf(carpet)).toEqual({ unit: 'SF', isMeasured: true });
    expect(measuredUnitOf(bulbs)).toEqual({ unit: 'EA', isMeasured: false });
  });
  it('names the measurement unit', () => {
    expect(measurementWord('SF')).toBe('square feet');
    expect(measurementWord('LF')).toBe('linear feet');
    expect(measurementWord('EA')).toBe('');
  });
  it('flags stair items (priced per stair)', () => {
    expect(isStairCount(stairCarpet)).toBe(true);
    expect(isStairCount(carpet)).toBe(false);
  });
});

describe('resolveTenantPct', () => {
  it('always returns an integer multiple of 5 within 0..100', () => {
    for (const item of catalog) {
      for (const months of [0, 6, 12, 36, 120]) {
        const pct = resolveTenantPct(item, months);
        expect(pct).toBeGreaterThanOrEqual(0);
        expect(pct).toBeLessThanOrEqual(100);
        expect(pct % 5).toBe(0);
      }
    }
  });
  it('defaults a non-depreciable item to 100%', () => {
    expect(resolveTenantPct(bulbs, 12)).toBe(100);
  });
});

describe('normalizeVendor', () => {
  it('maps empty / unknown to the default Vendor 1', () => {
    expect(normalizeVendor('')).toBe('Vendor 1');
    expect(normalizeVendor(undefined)).toBe('Vendor 1');
    expect(normalizeVendor('Totally Unknown Vendor')).toBe('Vendor 1');
  });
  it('matches an allowed vendor case-insensitively', () => {
    const v = VENDORS[0];
    expect(normalizeVendor(v)).toBe(v);
    expect(normalizeVendor(v.toLowerCase())).toBe(v);
  });
});

describe('roomFromUtterance (named-room routing)', () => {
  const rooms = [
    { id: 'k', name: 'Kitchen' },
    { id: 'hs', name: 'Hallway / Stairs' },
    { id: 'b1', name: 'Bedroom 1 (Main)' },
    { id: 'b2', name: 'Bedroom 2' },
    { id: 'wh', name: 'Whole House' },
    { id: 'ye', name: 'Yard / Exterior' },
  ];
  it('routes an item to the single room named in the utterance', () => {
    expect(roomFromUtterance('replace light bulb kitchen', rooms)?.id).toBe('k');
    expect(roomFromUtterance('carpet on the stairs', rooms)?.id).toBe('hs');
    expect(roomFromUtterance('whole house mismatch', rooms)?.id).toBe('wh');
  });
  it('returns null when the named token is ambiguous across rooms', () => {
    // "bedroom" matches Bedroom 1 AND Bedroom 2 → don't guess.
    expect(roomFromUtterance('outlet in the bedroom', rooms)).toBeNull();
  });
  it('returns null when no room is named', () => {
    expect(roomFromUtterance('the faucet is leaking', rooms)).toBeNull();
  });
});

describe('countItemPhrases (over-add cap)', () => {
  it('a single-phrase request counts as ONE (the bushes bug)', () => {
    expect(countItemPhrases('trim 10 bushes 10 linear feet')).toBe(1);
    expect(countItemPhrases('replace the microwave')).toBe(1);
    expect(countItemPhrases('')).toBe(1);
  });
  it('connectors raise the ceiling to the number of items', () => {
    expect(countItemPhrases('carpet and pad')).toBe(2);
    expect(countItemPhrases('leaves raked and gutter cleaning, 50 linear feet')).toBe(3);
  });
  it('clamps to a max of 5', () => {
    expect(countItemPhrases('carpet, pad, paint, trim, blinds, outlet, faucet')).toBe(5);
  });
});

describe('aliasFor (word-discrepancy normalization)', () => {
  it('maps common mishears to the right catalog query', () => {
    expect(aliasFor('mismatched paint on the wall')?.query).toBe('mist match paint');
    expect(aliasFor('sales clean')?.query).toBe('whole house sales clean');
  });
  it('returns null for phrases that need no alias', () => {
    expect(aliasFor('replace the carpet')).toBeNull();
  });
});
