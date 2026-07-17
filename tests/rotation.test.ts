import { describe, it, expect } from 'vitest';
import { buildRotationState, pickVendor, type ExistingOrder } from '@/lib/services/rotation';

const OPEN = new Set(['estimated', 'assigned', 'submitted', 'review']);
const isOpen = (s: string) => OPEN.has(s);

describe('vendor rotation', () => {
  it('single-vendor rule always assigns that vendor', () => {
    const state = buildRotationState([], isOpen);
    expect(pickVendor(['Acme'], 'gen:r1:p1', state)).toBe('Acme');
    expect(pickVendor(['Acme'], 'gen:r1:p2', state)).toBe('Acme');
  });

  it('no vendors → null', () => {
    const state = buildRotationState([], isOpen);
    expect(pickVendor([], 'gen:r1:p1', state)).toBeNull();
  });

  it('balances net-new enrollments toward the lowest open volume', () => {
    // Existing open volume 5 / 4 / 2 across A / B / C.
    const existing: ExistingOrder[] = [
      ...Array(5).fill(0).map((_, i) => ({ key: `gen:r1:a${i}`, status: 'assigned', vendor: 'A' })),
      ...Array(4).fill(0).map((_, i) => ({ key: `gen:r1:b${i}`, status: 'assigned', vendor: 'B' })),
      ...Array(2).fill(0).map((_, i) => ({ key: `gen:r1:c${i}`, status: 'assigned', vendor: 'C' })),
    ];
    const state = buildRotationState(existing, isOpen);
    const vendors = ['A', 'B', 'C'];
    // Next two go to C (2→3→4), then it round-robins the lowest.
    expect(pickVendor(vendors, 'gen:r1:n1', state)).toBe('C'); // C:2 lowest
    expect(pickVendor(vendors, 'gen:r1:n2', state)).toBe('C'); // C:3, still < B:4,A:5
    // Now A:5 B:4 C:4 → next lowest is B (tie C? B=4,C=4 → tie broken by order: B first)
    expect(pickVendor(vendors, 'gen:r1:n3', state)).toBe('B'); // B:4 == C:4, B earlier
  });

  it('breaks ties deterministically by the rule vendor order', () => {
    const state = buildRotationState([], isOpen); // all zero
    const vendors = ['X', 'Y', 'Z'];
    expect(pickVendor(vendors, 'k1', state)).toBe('X'); // all 0 → first
    expect(pickVendor(vendors, 'k2', state)).toBe('Y'); // X now 1
    expect(pickVendor(vendors, 'k3', state)).toBe('Z'); // X,Y 1 → Z
    expect(pickVendor(vendors, 'k4', state)).toBe('X'); // all 1 → first again
  });

  it('is sticky: a re-generated enrollment keeps its prior vendor', () => {
    // p1 previously assigned to B (a completed order); rule vendors A,B,C with A idle.
    const existing: ExistingOrder[] = [
      { key: 'gen:r1:p1', status: 'completed', vendor: 'B' },
    ];
    const state = buildRotationState(existing, isOpen);
    // Even though A has 0 open volume, p1 stays with B.
    expect(pickVendor(['A', 'B', 'C'], 'gen:r1:p1', state)).toBe('B');
    // A genuinely new address balances to the idle vendor.
    expect(pickVendor(['A', 'B', 'C'], 'gen:r1:p2', state)).toBe('A');
  });

  it('drops stickiness when the prior vendor is removed from the rule', () => {
    const existing: ExistingOrder[] = [
      { key: 'gen:r1:p1', status: 'completed', vendor: 'GoneVendor' },
    ];
    const state = buildRotationState(existing, isOpen);
    // GoneVendor no longer on the rule → p1 rejoins the balance.
    expect(pickVendor(['A', 'B'], 'gen:r1:p1', state)).toBe('A');
  });

  it('keeps stickiness across multiple orders in one run', () => {
    const state = buildRotationState([], isOpen);
    const vendors = ['A', 'B'];
    const first = pickVendor(vendors, 'gen:r1:p1', state); // net-new → A (tie→first)
    const again = pickVendor(vendors, 'gen:r1:p1', state); // same key → sticky to A
    expect(first).toBe('A');
    expect(again).toBe('A');
  });
});
