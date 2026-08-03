import { describe, it, expect } from 'vitest';
import { jobsPerYear, perServiceFromMonthly, perServiceFromAnnual, monthlyFromPerService, annualFromPerService } from '@/lib/services/cadenceJobs';

const ALL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

describe('jobsPerYear', () => {
  it('weekly all year → 52', () => {
    expect(jobsPerYear([{ unit: 'days', interval: '7', months: ALL }])).toBe(52);
  });
  it('every 4 weeks (28 days) all year → 13 (52 ÷ 4)', () => {
    expect(jobsPerYear([{ unit: 'days', interval: '28', months: ALL }])).toBe(13);
  });
  it('every 2 weeks (14 days) → 26', () => {
    expect(jobsPerYear([{ unit: 'days', interval: '14', months: ALL }])).toBe(26);
  });
  it('legacy weeks unit is read as ×7 days', () => {
    expect(jobsPerYear([{ unit: 'weeks', interval: '1', months: ALL }])).toBe(52);
  });
  it('monthly every 1 → 12; every 3 → 4', () => {
    expect(jobsPerYear([{ unit: 'months', interval: '1', months: ALL }])).toBe(12);
    expect(jobsPerYear([{ unit: 'months', interval: '3', months: ALL }])).toBe(4);
  });
  it('seasonal weekly (8 active months) scales down', () => {
    // 8/12 × 52.14 ≈ 34.8 → 35
    expect(jobsPerYear([{ unit: 'days', interval: '7', months: [2, 3, 4, 5, 6, 7, 8, 9] }])).toBe(35);
  });
  it('skip months are removed from the count', () => {
    // weekly over 12 months, but 2 skipped → 10 active
    expect(jobsPerYear([{ unit: 'days', interval: '7', months: ALL }], [0, 1])).toBe(43); // round(10/12×52.14)=43
  });
  it('sums across multiple cadences', () => {
    expect(jobsPerYear([
      { unit: 'days', interval: '7', months: [3, 4, 5, 6, 7, 8] },      // 6 mo weekly ≈ 26
      { unit: 'days', interval: '28', months: [0, 1, 2, 9, 10, 11] },    // 6 mo every-4-wk ≈ 7
    ])).toBe(33);
  });
  it('no cadences / no months → 0', () => {
    expect(jobsPerYear([])).toBe(0);
    expect(jobsPerYear([{ unit: 'days', interval: '7', months: [] }])).toBe(0);
  });
});

describe('cost derivation round-trips', () => {
  it('monthly → per-cut → monthly (weekly = 52/yr)', () => {
    const jpy = 52;
    const perCut = perServiceFromMonthly(200, jpy);       // 200×12/52 = 46.15
    expect(perCut).toBeCloseTo(46.15, 2);
    expect(monthlyFromPerService(perCut, jpy)).toBeCloseTo(200, 0);
  });
  it('annual → per-service → annual (every-4-weeks = 13/yr)', () => {
    const jpy = 13;
    const perSvc = perServiceFromAnnual(2600, jpy);       // 2600/13 = 200
    expect(perSvc).toBe(200);
    expect(annualFromPerService(perSvc, jpy)).toBe(2600);
  });
  it('zero jobs/year → zero (never divide by zero)', () => {
    expect(perServiceFromMonthly(200, 0)).toBe(0);
    expect(perServiceFromAnnual(2600, 0)).toBe(0);
  });
});
