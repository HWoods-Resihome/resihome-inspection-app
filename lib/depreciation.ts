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
  { months: 6, paint: 85, flooring: 90 },
  { months: 12, paint: 75, flooring: 90 },
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
 * Classify a catalog item as paint/flooring (depreciable) or null. This is the
 * coarse auto-apply signal; the AI review still applies the finer
 * cap-eligibility rules. Pass the description so exceptions can be excluded —
 * notably TUB/SHOWER REFINISH (reglaze/resurface), which is billed under
 * Painting but is NOT wall paint and must stay full tenant responsibility.
 */
export function depKindForCategory(category: string | undefined | null, description?: string | null): DepKind | null {
  const c = (category || '').toLowerCase();
  const d = (description || '').toLowerCase();

  // NEVER cap-eligible, regardless of category or is_flooring_like/is_paint_like
  // tags. These are billed under Painting/Flooring/Tile but are damage,
  // replacement, or non-wear scopes that stay full tenant responsibility — so
  // the automated tenant % must NOT auto-depreciate them. When the scope text
  // conflicts with the tag, the text wins. The AI review enforces the same list.
  //   - tub / shower refinish / reglaze / resurface / strip (billed under
  //     Painting but NOT wall paint)
  //   - caulk / re-caulk
  //   - ceiling tile
  //   - transition / threshold strips
  //   - countertops
  //   - shower surrounds / wall tile
  //   - baseboards / trim
  //   - screens / spline
  if (
    (/refinish|reglaze|resurface|strip/.test(d) && /tub|shower|surround|bath/.test(d)) ||
    /caulk/.test(d) ||
    /ceiling tile/.test(d) ||
    /transition|threshold/.test(d) ||
    /countertop|counter top/.test(d) ||
    /shower surround|wall tile/.test(d) ||
    /baseboard|\btrim\b/.test(d) ||
    /\bscreen\b|spline/.test(d)
  ) {
    return null;
  }

  // Flooring-MATERIAL cleaning is cap-eligible even when tenant filth or pets
  // are the cause — carpet cleaning is the single most common cap-miss. Detect
  // it by description so it's capped even when filed under a Cleaning category.
  // (Non-flooring cleaning — sales clean, wall cleaner, appliance cleaning — is
  // NOT flooring and is handled by the category checks below = no cap.)
  if (/(carpet|tile|grout)/.test(d) && /(clean|shampoo|stain|odor|odour|pet)/.test(d)) {
    return 'flooring';
  }

  if (c.includes('paint')) return 'paint';
  if (c.includes('floor')) return 'flooring';
  return null;
}

/** Both rates at a given month count — handy for prompts / display. */
export function depreciationRates(months: number): { paint: number; flooring: number } {
  return { paint: depreciationTenantPct('paint', months), flooring: depreciationTenantPct('flooring', months) };
}

/**
 * For a cap-eligible (paint/flooring) line, report whether the current tenant %
 * sits ABOVE the depreciation-schedule cap for the tenant's time in home.
 *
 * Used to surface a small alert next to a tenant % that an inspector manually
 * raised past the cap. Returns null for non-cap-eligible lines (no alert). Since
 * the auto-set value always EQUALS the cap, `over` is true only when the value
 * was manually pushed higher — and drops back to false the moment it's lowered
 * to the cap or below.
 */
export interface CapStatus { kind: DepKind; cap: number; months: number; over: boolean }
export function tenantPctCapStatus(
  category: string | undefined | null,
  description: string | undefined | null,
  tenantPct: number,
  months: number | null | undefined,
): CapStatus | null {
  const kind = depKindForCategory(category, description);
  if (!kind) return null;
  const m = typeof months === 'number' && months > 0 ? months : 12;
  const cap = depreciationTenantPct(kind, m);
  return { kind, cap, months: m, over: tenantPct > cap };
}
