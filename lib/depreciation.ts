/**
 * Tenant chargeback depreciation schedule for PAINT and FLOORING.
 *
 * Keyed by "months since move-in" (the tenant's time in the home). The schedule
 * is a step function at 6-month marks: a given month count uses the largest
 * threshold at or below it (so 37 months is treated the same as 36). Under 6
 * months is full tenant responsibility (100%). 120+ uses the final row.
 *
 * Used to auto-set the tenant % on paint/flooring lines in voice adds, manual
 * entry, and the AI review (so depreciation is applied consistently).
 */
export type DepKind = 'paint' | 'flooring';

interface Row { months: number; paint: number; flooring: number }

const SCHEDULE: Row[] = [
  { months: 6, paint: 85, flooring: 95 },
  { months: 12, paint: 75, flooring: 95 },
  { months: 18, paint: 65, flooring: 90 },
  { months: 24, paint: 50, flooring: 85 },
  { months: 30, paint: 35, flooring: 80 },
  { months: 36, paint: 20, flooring: 75 },
  { months: 42, paint: 15, flooring: 70 },
  { months: 48, paint: 10, flooring: 65 },
  { months: 54, paint: 10, flooring: 60 },
  { months: 60, paint: 10, flooring: 55 },
  { months: 66, paint: 10, flooring: 50 },
  { months: 72, paint: 10, flooring: 45 },
  { months: 78, paint: 10, flooring: 40 },
  { months: 84, paint: 10, flooring: 35 },
  { months: 90, paint: 10, flooring: 30 },
  { months: 96, paint: 10, flooring: 25 },
  { months: 102, paint: 10, flooring: 20 },
  { months: 108, paint: 10, flooring: 15 },
  { months: 114, paint: 10, flooring: 10 },
  { months: 120, paint: 10, flooring: 10 },
];

/** Tenant chargeback % for a paint/flooring scope at the given tenant months. */
export function depreciationTenantPct(kind: DepKind, months: number): number {
  // null / 0 / missing / invalid → backfill to 12 months. (A genuine 1-5 month
  // tenancy still resolves to 100% below; only absent/zero data backfills.)
  const m = Number.isFinite(months) && months > 0 ? months : 12;
  if (m < 6) return 100; // less than 6 months in home → full tenant responsibility
  let row = SCHEDULE[0];
  for (const r of SCHEDULE) if (r.months <= m) row = r;
  return kind === 'paint' ? row.paint : row.flooring;
}

/**
 * Classify a catalog category as paint/flooring (depreciable) or null. This is
 * the coarse auto-apply signal; the AI review still applies the finer
 * cap-eligibility rules (e.g. tenant-damage paint patches are NOT capped).
 */
export function depKindForCategory(category: string | undefined | null): DepKind | null {
  const c = (category || '').toLowerCase();
  if (c.includes('paint')) return 'paint';
  if (c.includes('floor')) return 'flooring';
  return null;
}

/** Both rates at a given month count — handy for prompts / display. */
export function depreciationRates(months: number): { paint: number; flooring: number } {
  return { paint: depreciationTenantPct('paint', months), flooring: depreciationTenantPct('flooring', months) };
}
