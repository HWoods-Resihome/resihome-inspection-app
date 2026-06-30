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
  'Pest Share',
  'Eviction Vendor',
];

// ---- Eviction vendor timing -------------------------------------------------
// Eviction trash-outs split by WHEN the work happens. The inspector picks the one
// "Eviction Vendor" option, then an "Eviction Work Timing" sub-control:
//   • Previously Completed → stored "Eviction Vendor (Past)"   — already done,
//     historical only: rides the Master/Tenant PDFs, NO standalone packet
//     (the long-standing behavior, unchanged).
//   • Needs Completed      → stored "Eviction Vendor (Future)" — work still owed:
//     gets its OWN per-vendor packet, which the finalize → HBMM ticket flow
//     attaches so the eviction vendor actually receives the work order.
// Timing is encoded in the assignedTo string, so the existing per-vendor-PDF and
// ticket-attach machinery treats the two as separate vendors with NO new field —
// and no backfill (legacy "Eviction Vendor (Past)" / bare "Eviction Vendor"
// already read as Past).
export const EVICTION_VENDOR = 'Eviction Vendor';
export const EVICTION_VENDOR_PAST = 'Eviction Vendor (Past)';
export const EVICTION_VENDOR_FUTURE = 'Eviction Vendor (Future)';
export type EvictionTiming = 'past' | 'future';

export function isEvictionVendor(vendor: string | null | undefined): boolean {
  return /eviction vendor/i.test(vendor || '');
}
/** Future ONLY when explicitly marked; bare / legacy / (Past) all read as past. */
export function evictionTimingOf(vendor: string | null | undefined): EvictionTiming {
  return /future/i.test(vendor || '') ? 'future' : 'past';
}
export function evictionVendorFor(timing: EvictionTiming): string {
  return timing === 'future' ? EVICTION_VENDOR_FUTURE : EVICTION_VENDOR_PAST;
}
/** Collapse a stored eviction vendor (any timing) to the single dropdown label;
 *  other vendors pass through unchanged. */
export function baseVendorLabel(vendor: string | null | undefined): string {
  return isEvictionVendor(vendor) ? EVICTION_VENDOR : (vendor || '');
}

/** Label for a vendor's OWN packet/footer — drops the internal timing suffix so
 *  the eviction work-order packet simply reads "Eviction Vendor" to the recipient
 *  (only the Future variant gets a packet, so there's nothing to disambiguate). */
export function vendorDocLabel(vendor: string | null | undefined): string {
  return baseVendorLabel(vendor) || (vendor || '');
}

// ---- HBMM ticket routing ----------------------------------------------------
// A Scope finalize can create up to THREE HoneyBadger tickets, and a vendor's
// per-vendor PDF is routed to exactly one of them:
//   • 'turnkey'  → the main Turnkey ticket (Master + the standard trade vendors).
//   • 'eviction' → its OWN "Evictions"-type ticket (the Eviction Vendor FUTURE
//                  packet — work still owed).
//   • 'capex'    → its OWN Maintenance-type ticket (the CapEx Vendor packet).
// Only vendors that actually get a packet (vendorGetsOwnPdf) are ever routed, so
// eviction-Past (no packet) never reaches here.
export const CAPEX_VENDOR = 'CapEx Vendor';
export function isCapexVendor(vendor: string | null | undefined): boolean {
  return (vendor || '').trim().toLowerCase() === CAPEX_VENDOR.toLowerCase();
}
export type TicketKind = 'turnkey' | 'eviction' | 'capex';
export function vendorTicketKind(vendor: string | null | undefined): TicketKind {
  if (isCapexVendor(vendor)) return 'capex';
  if (isEvictionVendor(vendor) && evictionTimingOf(vendor) === 'future') return 'eviction';
  return 'turnkey';
}

// Pest-control vendor. Lines default here for the pest-treatment code (PESTL1007)
// ONLY when the property is enrolled in pest control (pest_control_enrolled=Yes);
// gets its own per-vendor PDF at finalize like the others.
export const PEST_SHARE_VENDOR = 'Pest Share';
export const PEST_CONTROL_CODE = 'PESTL1007';

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
// `match` runs against the line item's description/category (lower-cased); first
// match wins. Applied AFTER the per-code rules above (code rules take priority).
// To add a rule, drop a { match, vendor } entry (the vendor must be in VENDORS).
const DESC_VENDOR_DEFAULTS: Array<{ match: (s: string) => boolean; vendor: string }> = [
  // All grass cuts / mowing → PPW (our landscaping vendor). Covers every
  // grass-cut catalog code regardless of lot size, current or future.
  {
    match: (s) => /\b(grass[\s-]*cut(?:ting)?|mow(?:ing)?|lawn[\s-]*(?:cut|mow))\b/i.test(s),
    vendor: 'PPW',
  },
  // FULL major-appliance REPLACEMENTS → GE Appliances. Must be a whole-unit
  // replace (description says replac* + a major-appliance noun) and NOT a repair
  // or a part/component swap (filter, rack, ice maker, element, hood, etc.) —
  // those, and all other appliance work, stay on Vendor 1.
  {
    match: (s) =>
      /\breplac/i.test(s)
      && /\b(refrigerator|fridge|dishwasher|microwave|range|oven|stove|cooktop|dryer|washing\s*machine)\b/i.test(s)
      && !/\b(repair|filter|rack|shelf|bin|drawer|ice[\s-]*maker|water[\s-]*(?:line|valve|filter)|element|igniter|burner|knob|handle|gasket|seal|hose|valve|board|light|bulb|hinge|vent|hood|cord|leveling|anti[\s-]*tip|grate|tray|duct|part)\b/i.test(s),
    vendor: 'GE Appliances',
  },
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
  opts?: { pestControlEnrolled?: boolean },
): string | null {
  if (!item) return null;
  // Pest treatment on a pest-control-enrolled property → Pest Share (conditional;
  // no default otherwise).
  if (opts?.pestControlEnrolled
    && (item.lineItemCode || '').trim().toUpperCase() === PEST_CONTROL_CODE) {
    return PEST_SHARE_VENDOR;
  }
  const byCode = defaultVendorForCode(item.lineItemCode);
  if (byCode) return byCode;
  const hay = [item.laborShortDescription, item.laborFullDescription, item.description, item.category, item.subcategory]
    .filter(Boolean).join(' ');
  if (!hay) return null;
  for (const r of DESC_VENDOR_DEFAULTS) if (r.match(hay)) return r.vendor;
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
  // Eviction "Needs Completed" (Future) DOES get its own packet — it's the work
  // order the HBMM ticket flow attaches. "Previously Completed" (Past) and the
  // legacy bare label do NOT (already-done work just rides the Master/Tenant PDFs).
  if (isEvictionVendor(vendor)) return evictionTimingOf(vendor) === 'future';
  return true;
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
  'Pest Share':          { bg: 'bg-orange-500',  text: 'text-white' },     // orange — pest control
  'Eviction Vendor':          { bg: 'bg-rose-600', text: 'text-white' },     // the dropdown label (+ legacy historical lines)
  'Eviction Vendor (Future)': { bg: 'bg-rose-600', text: 'text-white' },     // strong rose — work still owed
  'Eviction Vendor (Past)':   { bg: 'bg-rose-300', text: 'text-rose-900' },  // muted rose — already completed
};

/** Get pill styling for a vendor; falls back to neutral gray if not in the map. */
export function vendorPillStyle(vendor: string): VendorPillStyle {
  return VENDOR_COLORS[vendor] || { bg: 'bg-gray-100', text: 'text-gray-700', border: 'border border-gray-300' };
}
