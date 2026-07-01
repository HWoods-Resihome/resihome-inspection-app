/**
 * Rate Card math.
 *
 * Implements the single source of truth for vendor / client / tenant cost
 * calculations. Used by:
 *   - The line-item save endpoint (authoritative; result gets stored)
 *   - The future Phase 3 client preview (advisory; shown in the modal as the
 *     inspector types, but the server is authoritative on save)
 *
 * Formula (locked in Phase 1 planning):
 *
 *   effective_labor_rate    = region.rate_<category>     (fallback: region GA:Atlanta + Inspections)
 *   adjusted_material_cost  = material_cost
 *                           * region.material_cost_adjustment
 *                           * (1 + region.material_tax_adjustment)
 *
 *   labor_total    = labor_hours * effective_labor_rate * quantity
 *   material_units = MAX(1, material_rate * material_qty * quantity)   // floor the FULL consumption at 1 unit
 *   material_total = 0 if (is_labor_only OR material_rate == 0) else (material_units * adjusted_material_cost)
 *
 *   vendor_cost = labor_total + material_total
 *   client_cost = vendor_cost * 1.20            (markup is hard-coded 20%)
 *   tenant_cost = client_cost * (tenant_bill_back_percent / 100)
 *
 * Bid items: inspector can override `effective_labor_rate` and/or
 * `adjusted_material_cost` via custom inputs. The rest of the formula still
 * applies. `is_custom_priced=true` is recorded.
 *
 * No rounding happens inside this module. Round only at display time.
 */

import type { RateCardLineItem, RegionRate } from './types';

// Hard-coded markup. Decision in Phase 1: always 20%, no override.
export const MARKUP_MULTIPLIER = 1.20;

// Fallback region and category when a property's region or a line's category
// can't be matched. Phase 1 decision.
export const FALLBACK_REGION_KEY = 'GA: Atlanta';
export const FALLBACK_CATEGORY_RATE_PROP = 'rateInspections';

/** Inputs the inspector provides for a single line. */
export interface LineInputs {
  quantity: number;                  // user-entered, accepts decimals
  tenantBillBackPercent: number;     // 0..100, in 5% increments
  // Bid-item overrides. If is_bid_item, these can be present.
  // When provided, they REPLACE the catalog/region-derived values.
  customLaborRate?: number | null;
  customAdjustedMaterialCost?: number | null;
  // Direct vendor cost override (any line, any inspector). When set, REPLACES
  // the computed vendor_cost. Labor/material totals still get snapshotted from
  // the formula but they don't drive the money.
  customVendorCost?: number | null;
}

/** Snapshot fields stored on the answer record so historical math is reproducible. */
export interface LineSnapshot {
  // Catalog-side
  laborHoursSnapshot: number;
  materialRateSnapshot: number;
  materialQtySnapshot: number;
  materialCostSnapshot: number;
  isLaborOnlySnapshot: boolean;
  isBidItemSnapshot: boolean;
  categorySnapshot: string;
  subcategorySnapshot: string;
  // Region-side
  regionSnapshot: string;
  laborHourlyRateSnapshot: number;          // from region matrix
  materialCostAdjustmentSnapshot: number;   // from region matrix
  materialTaxAdjustmentSnapshot: number;    // from region matrix
}

/** Computed totals. Stored alongside snapshot. */
export interface LineTotals {
  laborTotal: number;
  materialTotal: number;
  vendorCost: number;
  clientCost: number;
  tenantCost: number;
}

/** Combined result: everything the answer record needs. */
export interface LineCalcResult extends LineSnapshot, LineTotals {
  isCustomPriced: boolean;
}

/**
 * Look up the labor rate for a given category in a region record.
 *
 * Maps category labels (e.g., "Plumbing") to the `rate_<category>` property
 * names on `region_rate`. Returns null if the category isn't found.
 *
 * Note: we keep this mapping in-sync with phase1_step2_create_region_rate_object.py.
 * If a new category is added in HubSpot, add it here too.
 */
export function rateForCategory(region: RegionRate, category: string): number | null {
  // Normalize for matching: lowercase, strip punctuation/spaces.
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const key = norm(category);

  // Mirror of phase1_step2's CATEGORY_TO_PROPERTY but using TS field names (camelCase).
  // The Region object loaded by the API converts hubspot rate_appliance -> rateAppliance.
  const map: Record<string, keyof RegionRate> = {
    [norm('Appliance')]: 'rateAppliance',
    [norm('Cabinet')]: 'rateCabinet',
    [norm('Carpentry')]: 'rateCarpentry',
    [norm('Cleaning')]: 'rateCleaning',
    [norm('Concrete')]: 'rateConcrete',
    [norm('Doors')]: 'rateDoors',
    [norm('Drywall')]: 'rateDrywall',
    [norm('Electrical')]: 'rateElectrical',
    [norm('Fence')]: 'rateFence',
    [norm('Flooring')]: 'rateFlooring',
    [norm('Garage Doors')]: 'rateGarageDoors',
    [norm('Gutters')]: 'rateGutters',
    [norm('HVAC')]: 'rateHvac',
    [norm('HVAC SIBI Units')]: 'rateHvacSibiUnits',
    [norm('Inspections')]: 'rateInspections',
    [norm('Landscape')]: 'rateLandscape',
    [norm('Painting')]: 'ratePainting',
    [norm('Pest Control')]: 'ratePestControl',
    [norm('Plumbing')]: 'ratePlumbing',
    [norm('Remediation')]: 'rateRemediation',
    [norm('Roofing')]: 'rateRoofing',
    [norm('Septic')]: 'rateSeptic',
    [norm('Siding')]: 'rateSiding',
    [norm('Trash/Debris Removal')]: 'rateTrashDebrisRemoval',
    [norm('Unit Turns (Paint/Clean/Minor Repairs)')]: 'rateUnitTurns',
    [norm('Utility Activation')]: 'rateUtilityActivation',
    [norm('Windows/Glass')]: 'rateWindowsGlass',
  };

  const prop = map[key];
  if (!prop) return null;
  const v = region[prop];
  if (typeof v !== 'number' || !isFinite(v) || v <= 0) return null;
  return v;
}

/**
 * Resolve the effective labor rate using the region matrix, with the GA:Atlanta /
 * Inspections fallback for any missed lookup.
 *
 * @param requestedRegion - the region we *want* to use (from inspection.regionSnapshot)
 * @param category        - the line's category
 * @param allRegions      - all loaded region_rate records (so we can find the fallback if requested isn't there)
 * @returns the rate plus the actual region used (may differ from requested if fallback kicked in)
 */
export function resolveLaborRate(
  requestedRegion: string,
  category: string,
  allRegions: RegionRate[]
): { rate: number; regionUsed: string } {
  // Try exact match on requested region + requested category
  const exactRegion = allRegions.find((r) => r.region === requestedRegion);
  if (exactRegion) {
    const rate = rateForCategory(exactRegion, category);
    if (rate != null) return { rate, regionUsed: requestedRegion };
  }

  // Fallback: GA: Atlanta + Inspections
  const fallback = allRegions.find((r) => r.region === FALLBACK_REGION_KEY);
  if (!fallback) {
    // No GA: Atlanta loaded? Hard error rather than silently using 0.
    throw new Error(
      `Region matrix missing both '${requestedRegion}' and fallback '${FALLBACK_REGION_KEY}'. ` +
      `Cannot calculate line totals.`
    );
  }
  const fallbackRate = fallback.rateInspections;
  if (typeof fallbackRate !== 'number' || fallbackRate <= 0) {
    throw new Error(
      `Region matrix fallback '${FALLBACK_REGION_KEY}.rate_inspections' is missing or invalid.`
    );
  }
  return { rate: fallbackRate, regionUsed: FALLBACK_REGION_KEY };
}

/**
 * Resolve the material adjustments for a region. Falls back to GA: Atlanta's
 * adjustments if the requested region isn't in the matrix.
 */
export function resolveMaterialAdjustments(
  requestedRegion: string,
  allRegions: RegionRate[]
): { costAdj: number; taxAdj: number; regionUsed: string } {
  const exactRegion = allRegions.find((r) => r.region === requestedRegion);
  if (exactRegion) {
    return {
      costAdj: safeCostAdj(exactRegion.materialCostAdjustment),
      taxAdj: safeTaxAdj(exactRegion.materialTaxAdjustment),
      regionUsed: requestedRegion,
    };
  }
  const fallback = allRegions.find((r) => r.region === FALLBACK_REGION_KEY);
  if (!fallback) {
    throw new Error(
      `Region matrix missing both '${requestedRegion}' and fallback '${FALLBACK_REGION_KEY}'.`
    );
  }
  return {
    costAdj: safeCostAdj(fallback.materialCostAdjustment),
    taxAdj: safeTaxAdj(fallback.materialTaxAdjustment),
    regionUsed: FALLBACK_REGION_KEY,
  };
}

// A material COST multiplier must be a finite, positive number — a stored 0 (or
// null/NaN) would silently zero ALL material costs in that region (underbill).
// Fall back to the neutral 1× rather than propagate a corrupting value.
function safeCostAdj(v: number | null | undefined): number {
  return typeof v === 'number' && isFinite(v) && v > 0 ? v : 1;
}
// A material TAX adjustment is an additive fraction (0.07 = +7%); it must be a
// finite, non-negative number. Neutral default is 0 (no tax uplift).
function safeTaxAdj(v: number | null | undefined): number {
  return typeof v === 'number' && isFinite(v) && v >= 0 ? v : 0;
}

/**
 * Compute everything for a single line.
 *
 * Server-authoritative: this is the canonical implementation. The Phase 3 client
 * will run an identical TypeScript copy for preview, but the server's result
 * (this) is what gets stored.
 */
export function calculateLine(
  catalogItem: RateCardLineItem,
  requestedRegion: string,
  allRegions: RegionRate[],
  inputs: LineInputs
): LineCalcResult {
  // --- Resolve rates from the region matrix ---
  const { rate: defaultLaborRate, regionUsed: laborRegionUsed } = resolveLaborRate(
    requestedRegion,
    catalogItem.category,
    allRegions
  );
  // Resolve material adjustments from the SAME region labor resolved to — NOT the
  // raw requested region. If the requested region EXISTS but lacks this line's
  // category rate, resolveLaborRate falls back to GA:Atlanta; pricing material off
  // the requested region here would then mix two regions in one line AND leave the
  // snapshot (which records one region) unable to re-price to the same number.
  // Passing laborRegionUsed keeps both halves on one region (a no-op in the common
  // case where labor didn't fall back, since laborRegionUsed === requestedRegion).
  const { costAdj, taxAdj, regionUsed: matRegionUsed } = resolveMaterialAdjustments(
    laborRegionUsed,
    allRegions
  );
  // Both halves now share a region; record it for the snapshot.
  const regionUsed = laborRegionUsed || matRegionUsed || requestedRegion;

  // --- Apply bid-item overrides if provided ---
  // Require FINITE overrides: a non-finite value (e.g. Infinity from a bad
  // payload) would pass `>= 0`, become the effective cost, and — since
  // roundMoney(Infinity) === 0 — be stored as a silent $0 line (the same
  // financial-integrity failure the quantity guard prevents). Treat garbage as
  // "not a custom override" so the line falls back to the computed price.
  const isCustomLabor = inputs.customLaborRate != null && isFinite(inputs.customLaborRate) && inputs.customLaborRate >= 0;
  const isCustomMaterial = inputs.customAdjustedMaterialCost != null && isFinite(inputs.customAdjustedMaterialCost) && inputs.customAdjustedMaterialCost >= 0;
  const isCustomVendor = inputs.customVendorCost != null && isFinite(inputs.customVendorCost) && inputs.customVendorCost >= 0;
  const isCustomPriced = isCustomLabor || isCustomMaterial || isCustomVendor;

  const effectiveLaborRate = isCustomLabor ? inputs.customLaborRate! : defaultLaborRate;
  const defaultAdjustedMaterialCost = catalogItem.materialCost * costAdj * (1 + taxAdj);
  const effectiveAdjustedMaterialCost = isCustomMaterial
    ? inputs.customAdjustedMaterialCost!
    : defaultAdjustedMaterialCost;

  // --- Apply the formula ---
  // Guard the numeric inputs. A NaN/invalid quantity would otherwise silently
  // propagate through every total and, because roundMoney(NaN) returns 0, get
  // stored as a $0 line — a financial-integrity bug that's hard to spot after
  // the fact. Coerce to a sane number and fail loud on garbage.
  const rawQty = Number(inputs.quantity);
  if (!isFinite(rawQty) || rawQty < 0) {
    throw new Error(
      `Invalid quantity for line calculation: ${JSON.stringify(inputs.quantity)}. ` +
      `Quantity must be a non-negative number.`
    );
  }
  const qty = rawQty;
  const laborTotal = catalogItem.laborHours * effectiveLaborRate * qty;

  let materialTotal = 0;
  // Material consumption = material_rate × material_qty × quantity (the number of
  // material "units" the job uses). Floor it at 1 WHOLE unit: you can't buy a
  // fraction of a unit, and the intent of this floor has always been "charge at
  // least one unit of material." The floor MUST wrap the FULL consumption —
  // including material_rate. Flooring only (material_qty × quantity), as the
  // formula originally did, let a tiny per-unit rate (e.g. 0.0001 on the per-SF
  // Sales Clean lines) silently crush the material toward $0, so the intended
  // $100 / $150 flat material never materialized. Guards:
  //   - quantity 0  → $0 (a deliberately zeroed line costs nothing)
  //   - material_rate 0 → $0 (the item carries no material; unchanged — it was
  //     always $0 because rate multiplied the whole term).
  if (!catalogItem.isLaborOnly && qty > 0 && catalogItem.materialRate > 0) {
    const consumption = catalogItem.materialRate * catalogItem.materialQty * qty;
    const materialUnits = Math.max(1, consumption);
    materialTotal = materialUnits * effectiveAdjustedMaterialCost;
  }

  // Vendor cost: direct override (if set) wins over formula. We keep
  // laborTotal/materialTotal as snapshots regardless, for traceability.
  const computedVendorCost = laborTotal + materialTotal;
  const vendorCost = isCustomVendor ? inputs.customVendorCost! : computedVendorCost;
  const clientCost = vendorCost * MARKUP_MULTIPLIER;
  // Coerce first: Math.max(0, Math.min(100, NaN)) is NaN, so an invalid percent
  // would slip through the clamp and zero out tenant_cost. Default to 0.
  const rawPct = Number(inputs.tenantBillBackPercent);
  const tenantPct = isFinite(rawPct) ? Math.max(0, Math.min(100, rawPct)) : 0;
  const tenantCost = clientCost * (tenantPct / 100);

  return {
    // Snapshot (12 inputs)
    laborHoursSnapshot: catalogItem.laborHours,
    materialRateSnapshot: catalogItem.materialRate,
    materialQtySnapshot: catalogItem.materialQty,
    materialCostSnapshot: catalogItem.materialCost,
    isLaborOnlySnapshot: catalogItem.isLaborOnly,
    isBidItemSnapshot: catalogItem.isBidItem,
    categorySnapshot: catalogItem.category,
    subcategorySnapshot: catalogItem.subcategory,
    regionSnapshot: regionUsed,
    laborHourlyRateSnapshot: effectiveLaborRate,
    materialCostAdjustmentSnapshot: costAdj,
    materialTaxAdjustmentSnapshot: taxAdj,
    // Totals (5 computed)
    laborTotal,
    materialTotal,
    vendorCost,
    clientCost,
    tenantCost,
    // Flag
    isCustomPriced,
  };
}

/**
 * Round a money value to 2 decimal places for display/storage.
 * Math operates on full precision internally; rounding only at the boundary.
 */
export function roundMoney(v: number): number {
  if (!isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}
