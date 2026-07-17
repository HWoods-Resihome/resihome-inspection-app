import { describe, it, expect } from 'vitest';
import { computeServiceInsights, type SvcInsightsRow } from '@/lib/services/insights';

const row = (o: Partial<SvcInsightsRow>): SvcInsightsRow => ({
  status: 'completed', isBidItem: false, ontime: null, reviewDecision: '', vendor: 'A', vendorCost: null, ...o,
});

describe('computeServiceInsights', () => {
  it('completed % excludes canceled from the denominator', () => {
    const rows = [
      row({ status: 'completed' }), row({ status: 'completed' }),
      row({ status: 'assigned' }), row({ status: 'canceled' }),
    ];
    const { overall } = computeServiceInsights(rows);
    // 2 completed / 3 non-canceled
    expect(overall.completed).toBe(2);
    expect(overall.completedPct).toBeCloseTo(2 / 3, 5);
  });

  it('on-time % is over completed rows with a known ontime only', () => {
    const rows = [
      row({ status: 'completed', ontime: true }),
      row({ status: 'completed', ontime: false }),
      row({ status: 'completed', ontime: null }),   // unknown → excluded from on-time base
    ];
    const { overall } = computeServiceInsights(rows);
    expect(overall.onTimePct).toBeCloseTo(0.5, 5);
  });

  it('bid-item % is over all rows', () => {
    const rows = [row({ isBidItem: true }), row({ isBidItem: false }), row({ isBidItem: false }), row({ isBidItem: false })];
    expect(computeServiceInsights(rows).overall.bidItemPct).toBeCloseTo(0.25, 5);
  });

  it('reject/modify rate is over reviewed rows', () => {
    const rows = [
      row({ reviewDecision: 'approve' }), row({ reviewDecision: 'modify' }),
      row({ reviewDecision: 'reject' }), row({ reviewDecision: '' }),
    ];
    const { overall } = computeServiceInsights(rows);
    expect(overall.reviewedCount).toBe(3);
    expect(overall.rejectModifyRate).toBeCloseTo(2 / 3, 5);
  });

  it('avg vendor cost averages completed rows that carry a cost', () => {
    const rows = [
      row({ status: 'completed', vendorCost: 40 }),
      row({ status: 'completed', vendorCost: 60 }),
      row({ status: 'completed', vendorCost: null }),  // no cost → excluded
      row({ status: 'assigned', vendorCost: 999 }),    // not completed → excluded
    ];
    expect(computeServiceInsights(rows).overall.avgVendorCost).toBe(50);
  });

  it('breaks out per-vendor and rolls blank vendor under Unassigned, sorted by volume', () => {
    const rows = [
      row({ vendor: 'A' }), row({ vendor: 'A' }), row({ vendor: 'A' }),
      row({ vendor: 'B' }),
      row({ vendor: '' }),
    ];
    const { perVendor } = computeServiceInsights(rows);
    expect(perVendor.map((v) => v.vendor)).toEqual(['A', 'B', 'Unassigned']);
    expect(perVendor[0].total).toBe(3);
  });

  it('handles an empty set without dividing by zero', () => {
    const { overall, perVendor, rows } = computeServiceInsights([]);
    expect(rows).toBe(0);
    expect(overall.completedPct).toBe(0);
    expect(overall.avgVendorCost).toBe(0);
    expect(perVendor).toEqual([]);
  });
});
