import { describe, it, expect } from 'vitest';
import { calculateLine, roundMoney, MARKUP_MULTIPLIER } from '@/lib/rateCardMath';
import type { RateCardLineItem, RegionRate } from '@/lib/types';

// Region matrix must contain the GA: Atlanta fallback or the math hard-fails.
const regions = [{
  region: 'GA: Atlanta', ratePainting: 50, rateInspections: 60,
  materialCostAdjustment: 1, materialTaxAdjustment: 0,
} as any as RegionRate];

// Minimal labor-only catalog item (material path disabled via materialRate 0).
const item = (over: Partial<RateCardLineItem> = {}): RateCardLineItem => ({
  lineItemCode: 'TEST0001', category: 'Painting', subcategory: 'Walls',
  laborShortDescription: 'Test', laborFullDescription: 'Test', laborSubtext: '',
  laborMeas: 'EA', laborHours: 1, materialRate: 0, materialQty: 0, materialCost: 0,
  isLaborOnly: true, isBidItem: false, isActive: true,
  ...(over as any),
} as RateCardLineItem);

describe('rateCardMath.calculateLine', () => {
  it('applies the client markup and scales tenant by %', () => {
    const calc = calculateLine(item(), 'GA: Atlanta', regions, {
      quantity: 1, tenantBillBackPercent: 50, customVendorCost: 100,
    });
    expect(calc.vendorCost).toBe(100);                       // custom override wins
    expect(calc.clientCost).toBeCloseTo(100 * MARKUP_MULTIPLIER, 5); // 120
    expect(calc.tenantCost).toBeCloseTo(120 * 0.5, 5);       // 60
    expect(calc.isCustomPriced).toBe(true);
  });

  it('clamps tenant % to 0..100', () => {
    const hi = calculateLine(item(), 'X', regions, { quantity: 1, tenantBillBackPercent: 250, customVendorCost: 100 });
    expect(hi.tenantCost).toBeCloseTo(120, 5);               // clamped to 100%
    const lo = calculateLine(item(), 'X', regions, { quantity: 1, tenantBillBackPercent: -5, customVendorCost: 100 });
    expect(lo.tenantCost).toBe(0);                            // clamped to 0%
  });

  it('throws on an invalid quantity (no silent $0 line)', () => {
    expect(() => calculateLine(item(), 'X', regions, { quantity: NaN as any, tenantBillBackPercent: 100 })).toThrow();
    expect(() => calculateLine(item(), 'X', regions, { quantity: -1, tenantBillBackPercent: 100 })).toThrow();
  });

  it('quantity 0 yields a $0 line', () => {
    const calc = calculateLine(item(), 'X', regions, { quantity: 0, tenantBillBackPercent: 100 });
    expect(roundMoney(calc.vendorCost)).toBe(0);
    expect(roundMoney(calc.clientCost)).toBe(0);
    expect(roundMoney(calc.tenantCost)).toBe(0);
  });

  it('roundMoney rounds to cents', () => {
    expect(roundMoney(1.005)).toBeCloseTo(1.0, 2);
    expect(roundMoney(2.346)).toBe(2.35);
  });
});
