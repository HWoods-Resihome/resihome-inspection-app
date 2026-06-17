/**
 * Vendor list for Rate Card line item assignments.
 *
 * Per Phase 1 decision (Q-C), this is a JSON-style file rather than a HubSpot object.
 * To add or change vendors:
 *   1. Edit the VENDORS array below
 *   2. Update VENDOR_COLORS if a new vendor needs a distinct pill color
 *   3. Commit + push to Vercel
 *   4. Inspectors see the new options immediately (no cache invalidation needed)
 *
 * Internal Resolution is always FIRST in the dropdown (most common selection).
 *
 * Color pills use brand-adjacent hues + accessible contrast for quick visual
 * scanning in the line item table.
 */

export const VENDORS: string[] = [
  'Internal Resolution',  // always first per Hayden 2026-05
  'Vendor 1',
  'Vendor 2',
  'PPW',
  'GE Appliances',
  'CapEx Vendor',
  'Eviction Vendor (Past)',
];

// The in-house vendor. Lines assigned here are work ResiHome resolves itself,
// so they REQUIRE after-photos (proof the work was completed) before finalize.
export const INTERNAL_RESOLUTION_VENDOR = 'Internal Resolution';

// Per-catalog-code DEFAULT vendor. When a NEW line with one of these codes is
// added, its vendor pre-selects to the mapped vendor instead of the generic
// "Vendor 1" — the inspector can still change it. Matched case-insensitively.
// To add a rule, drop a code → vendor entry here (the vendor must be in VENDORS).
const CODE_VENDOR_DEFAULTS: Record<string, string> = {
  // Eviction trash-out / cleanouts → the eviction vendor.
  TRSHL1041: 'Eviction Vendor (Past)',
  TRSHL1039: 'Eviction Vendor (Past)',
  TRSHL1015: 'Eviction Vendor (Past)',
  // Flooring → Vendor 2.
  FLORL1011: 'Vendor 2',
};

// Description/keyword DEFAULT vendor rules — for work whose catalog code varies
// (e.g. grass cuts are priced per lot size, so a single code list is brittle).
// Matched case-insensitively against the line item's description/category; first
// match wins. Applied AFTER the per-code rules above (code rules take priority).
// To add a rule, drop a { test, vendor } entry (the vendor must be in VENDORS).
const DESC_VENDOR_DEFAULTS: Array<{ test: RegExp; vendor: string }> = [
  // All grass cuts / mowing → PPW (our landscaping vendor). Covers every
  // grass-cut catalog code regardless of lot size, current or future.
  { test: /\b(grass[\s-]*cut(?:ting)?|mow(?:ing)?|lawn[\s-]*(?:cut|mow))\b/i, vendor: 'PPW' },
];

/** The default vendor for a catalog code, or null if it has no special rule. */
export function defaultVendorForCode(lineItemCode: string | null | undefined): string | null {
  const c = (lineItemCode || '').trim().toUpperCase();
  return CODE_VENDOR_DEFAULTS[c] || null;
}

/**
 * The default vendor for a catalog ITEM: the per-code rule first (eviction,
 * flooring…), then the description/keyword rules (grass cuts → PPW). Use this
 * wherever the full item is available so the inspector's NEW line pre-selects the
 * right vendor automatically (still editable). Returns null when no rule matches.
 */
export function defaultVendorForItem(
  item: { lineItemCode?: string | null; laborShortDescription?: string | null; laborFullDescription?: string | null; description?: string | null; category?: string | null; subcategory?: string | null } | null | undefined,
): string | null {
  if (!item) return null;
  const byCode = defaultVendorForCode(item.lineItemCode);
  if (byCode) return byCode;
  const hay = [item.laborShortDescription, item.laborFullDescription, item.description, item.category, item.subcategory]
    .filter(Boolean).join(' ');
  if (!hay) return null;
  for (const r of DESC_VENDOR_DEFAULTS) if (r.test.test(hay)) return r.vendor;
  return null;
}

/** True when a line's vendor is the in-house Internal Resolution team. */
export function isInternalResolution(vendor: string | null | undefined): boolean {
  return (vendor || '').trim().toLowerCase() === 'internal resolution';
}

// Vendors that should NOT get their own per-vendor PDF at finalize. Their lines
// still appear on the Master and Tenant Chargeback PDFs — they just don't get a
// standalone vendor packet. Matched case-insensitively and tolerant of the older
// "Eviction Vendor" label on historical lines.
export function vendorGetsOwnPdf(vendor: string): boolean {
  return !/eviction vendor/i.test(vendor || '');
}

/**
 * Tailwind classes for each vendor pill. bgColor + textColor combined produce
 * an accessible color combination. Each vendor gets a distinct hue.
 * Fallback (gray) used for any vendor not in this map.
 */
export interface VendorPillStyle {
  bg: string;
  text: string;
  border?: string;
}

// Curated palette: distinct hues with consistent saturation. Brand pink is reserved
// for app chrome only (no vendor uses it).
export const VENDOR_COLORS: Record<string, VendorPillStyle> = {
  'Internal Resolution': { bg: 'bg-slate-800',   text: 'text-white' },     // deep slate — internal/Resihome
  'Vendor 1':            { bg: 'bg-sky-500',     text: 'text-white' },     // sky blue
  'Vendor 2':            { bg: 'bg-teal-500',    text: 'text-white' },     // teal (echoes the brand accent but not identical)
  'PPW':                 { bg: 'bg-emerald-500', text: 'text-white' },     // emerald green
  'GE Appliances':       { bg: 'bg-violet-500',  text: 'text-white' },     // violet
  'CapEx Vendor':        { bg: 'bg-amber-500',   text: 'text-white' },     // amber/gold
  'Eviction Vendor (Past)': { bg: 'bg-rose-600', text: 'text-white' },       // rose (distinguishable from brand pink)
  'Eviction Vendor':        { bg: 'bg-rose-600', text: 'text-white' },       // legacy label on historical lines
};

/** Get pill styling for a vendor; falls back to neutral gray if not in the map. */
export function vendorPillStyle(vendor: string): VendorPillStyle {
  return VENDOR_COLORS[vendor] || { bg: 'bg-gray-100', text: 'text-gray-700', border: 'border border-gray-300' };
}
