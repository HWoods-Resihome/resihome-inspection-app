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
  'Eviction Vendor',
];

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
  'Eviction Vendor':     { bg: 'bg-rose-600',    text: 'text-white' },     // rose (distinguishable from brand pink)
};

/** Get pill styling for a vendor; falls back to neutral gray if not in the map. */
export function vendorPillStyle(vendor: string): VendorPillStyle {
  return VENDOR_COLORS[vendor] || { bg: 'bg-gray-100', text: 'text-gray-700', border: 'border border-gray-300' };
}
