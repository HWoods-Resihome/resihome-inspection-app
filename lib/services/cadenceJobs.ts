/**
 * How many service orders a rule's cadence(s) generate in a year — the divisor
 * the recurring-services costs use to turn a per-YEAR common-area contract or a
 * per-MONTH cut cost into the per-SERVICE value each generated order carries.
 *
 * Uses the "52 ÷ N" CONTRACT model (weekly = 52, every 4 weeks = 13, monthly
 * every N = 12 ÷ N), scaled by the active months a cadence covers. This is the
 * intended pricing count — NOT an exact day-by-day simulation of the generator
 * (every-28-days reads as 13 = 52 ÷ 4, which is how these contracts are priced).
 *
 * Cadence shape is intentionally loose so it accepts BOTH the rules-UI cadence
 * (unit 'days'|'months', interval string) and any legacy 'weeks' cadence.
 */
export interface JobsCadence {
  unit?: string;                 // 'days' | 'weeks' | 'months'
  interval?: number | string;    // every N of `unit`
  months?: Array<number | string>; // 0-11 the cadence covers
}

/** Jobs/year a single cadence contributes (0 when it covers no active month). */
export function cadenceJobsPerYear(c: JobsCadence, skip: Set<number>): number {
  const active = (c.months || []).map(Number).filter((m) => Number.isFinite(m) && !skip.has(m)).length;
  if (!active) return 0;
  const n = Math.max(1, Math.floor(Number(c.interval) || 1));
  if (String(c.unit) === 'months') return Math.round(active / n);
  // day/week cadence — the UI stores days (legacy weeks were migrated ×7); accept both.
  const days = String(c.unit) === 'weeks' ? n * 7 : n;
  return Math.round((active / 12) * (365 / days));
}

/** Total jobs/year across all of a rule's cadences (each owns disjoint months). */
export function jobsPerYear(cadences: JobsCadence[], skipMonths: Array<number | string> = []): number {
  const skip = new Set((skipMonths || []).map(Number).filter((m) => Number.isFinite(m)));
  let total = 0;
  for (const c of cadences || []) total += cadenceJobsPerYear(c, skip);
  return Math.max(0, total);
}

/** Round a dollar value to cents (returns a Number, not a string). */
export function round2(n: number): number { return Math.round(n * 100) / 100; }

/** per-SERVICE from a per-MONTH cost: monthly × 12 ÷ jobs/year. 0 when no jobs. */
export function perServiceFromMonthly(monthly: number, jpy: number): number {
  return jpy > 0 && Number.isFinite(monthly) ? round2((monthly * 12) / jpy) : 0;
}
/** per-SERVICE from a per-YEAR contract: annual ÷ jobs/year. 0 when no jobs. */
export function perServiceFromAnnual(annual: number, jpy: number): number {
  return jpy > 0 && Number.isFinite(annual) ? round2(annual / jpy) : 0;
}
/** Inverse (backfill): the per-MONTH cost implied by a per-service value. */
export function monthlyFromPerService(perService: number, jpy: number): number {
  return jpy > 0 && Number.isFinite(perService) ? round2((perService * jpy) / 12) : 0;
}
/** Inverse (backfill): the per-YEAR contract implied by a per-service value. */
export function annualFromPerService(perService: number, jpy: number): number {
  return jpy > 0 && Number.isFinite(perService) ? round2(perService * jpy) : 0;
}
