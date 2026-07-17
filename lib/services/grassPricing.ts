// Grass-cut tier pricing — ONE resolver shared by the submit path (server payout)
// and the detail live-cost preview (client), so the tier amounts can never drift
// between the two (they used to be triplicated). Amounts default here; a later
// step lets a rule override them by passing its own `tiers`.

export interface GrassTiers { standard: number; overgrown: number; heavy: number; }

export const DEFAULT_GRASS_TIERS: GrassTiers = { standard: 45, overgrown: 60, heavy: 90 };

/**
 * Vendor payout for a grass cut given the "grass height at arrival" answer.
 * Standard (< 6 in) / Overgrown (6–12 in) / Heavy (> 12 in). Unknown → Standard.
 */
export function grassTierAmount(heightAnswer: string, tiers: GrassTiers = DEFAULT_GRASS_TIERS): number {
  const h = String(heightAnswer || '').toLowerCase();
  if (h.includes('heavy') || h.includes('over 12') || h.includes('12"+') || h.includes('12+')) return tiers.heavy;
  if (h.includes('overgrown') || h.includes('6-12') || h.includes('6–12') || h.includes('6 - 12')) return tiers.overgrown;
  return tiers.standard;
}
