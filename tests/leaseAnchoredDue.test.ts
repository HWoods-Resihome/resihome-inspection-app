import { describe, it, expect } from 'vitest';
import { computeLeaseAnchoredDue } from '@/lib/services/generate';

// Owner's spec: B=2 days before lease start, F=3 days after enrollment (fallback),
// evaluated as of today = 2026-07-22.
const TODAY = '2026-07-22';
const B = 2;
const F = 3;
const run = (leaseStart: string) => computeLeaseAnchoredDue({ leaseStart, daysBefore: B, fallbackDays: F, todayISO: TODAY });

describe('computeLeaseAnchoredDue', () => {
  it('lease unknown → fallback due = today + F, flagged pending', () => {
    for (const unknown of ['', 'TBD', 'tbd']) {
      const r = run(unknown);
      expect(r.cancel).toBe(false);
      if (!r.cancel) { expect(r.pending).toBe(true); expect(r.due).toBe('2026-07-25'); }
    }
  });

  it('lease 7-31 → due 7-29 (leaseStart − 2, well before today)', () => {
    const r = run('2026-07-31');
    expect(r.cancel).toBe(false);
    if (!r.cancel) { expect(r.pending).toBe(false); expect(r.due).toBe('2026-07-29'); }
  });

  it('lease 7-26 → due 7-24', () => {
    const r = run('2026-07-26');
    if (!r.cancel) expect(r.due).toBe('2026-07-24');
    else throw new Error('should not cancel');
  });

  it('lease 7-24 → floored to tomorrow 7-23 (leaseStart−2 = 7-22 is not > today)', () => {
    const r = run('2026-07-24');
    if (!r.cancel) expect(r.due).toBe('2026-07-23');
    else throw new Error('should not cancel');
  });

  it('lease 7-23 (tomorrow) → cancel (no runway before move-in)', () => {
    expect(run('2026-07-23').cancel).toBe(true);
  });

  it('lease 7-22 (today) → cancel', () => {
    expect(run('2026-07-22').cancel).toBe(true);
  });

  it('lease in the past → cancel', () => {
    expect(run('2026-07-10').cancel).toBe(true);
  });

  it('accepts a datetime / epoch lease value (normalized to date)', () => {
    const r = run('2026-07-31T09:00:00Z');
    if (!r.cancel) expect(r.due).toBe('2026-07-29');
    else throw new Error('should not cancel');
  });

  it('respects a different days-before (B=5, lease 8-01 → 7-27)', () => {
    const r = computeLeaseAnchoredDue({ leaseStart: '2026-08-01', daysBefore: 5, fallbackDays: F, todayISO: TODAY });
    if (!r.cancel) expect(r.due).toBe('2026-07-27');
    else throw new Error('should not cancel');
  });
});
