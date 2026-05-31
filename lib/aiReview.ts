/**
 * AI rate-card review — shared types + helpers.
 *
 * The AI review evaluates a Scope rate card against the investment-property
 * standard (SAFE / CLEAN / FUNCTIONAL) and the depreciation/tenant rules, then
 * returns a list of suggested adjustments the inspector approves or declines.
 *
 * Gating: a review is only valid for the EXACT scope it ran against. Any line
 * change invalidates it (see scopeHash). The "passed" marker is persisted per
 * inspection so it survives a page reload. (Stored client-side for now; see
 * getPassedReviewHash — swap to a HubSpot field for cross-device durability.)
 */

export type AiAdjustmentType = 'edit' | 'remove' | 'add';

/** A single suggested change the inspector can approve/decline. */
export interface AiAdjustment {
  id: string;
  type: AiAdjustmentType;
  sectionId: string;
  sectionName?: string;
  /** Target line (edit/remove). Omitted for 'add'. */
  lineExternalId?: string;
  title: string;        // short headline, e.g. "Reduce tenant % on carpet (depreciation cap)"
  rationale: string;    // why, in the inspector's terms
  severity?: 'high' | 'medium' | 'low';
  /** The line's damage/tenant claim isn't supported by a photo. The inspector
   *  should either add a photo of the damage (attaches to the room + line) or
   *  remove the line — not a plain approve/decline. */
  needsPhoto?: boolean;
  /** Snapshot of the line as it is now (for display on edit/remove). */
  current?: {
    description?: string;
    quantity?: number;
    tenantBillBackPercent?: number;
    tenantDollars?: number;
    vendorCost?: number;
    unit?: string;        // labor unit of measure (EA/SF/LF…) for labeling the qty input
    lineItemCode?: string;
  };
  /** The change to apply if approved. */
  suggested?: {
    lineItemCode?: string;       // 'add' (and 'edit' if swapping item)
    description?: string;        // display label for 'add'
    quantity?: number;
    tenantBillBackPercent?: number;
    customVendorCost?: number | null;
    assignedTo?: string;
    unit?: string;
  };
  /** Estimated tenant $ after the change (display aid). */
  suggestedTenantDollars?: number;
}

export interface AiReviewResult {
  summary: string;
  adjustments: AiAdjustment[];
}

/** Minimal line shape the scope hash cares about. */
export interface HashableLine {
  externalId: string;
  lineItemCode: string;
  quantity: number;
  tenantBillBackPercent: number;
  customVendorCost?: number | null;
  assignedTo: string;
}

// FNV-1a 32-bit — small, fast, dependency-free; we only need change-detection,
// not cryptographic strength.
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Deterministic fingerprint of the priced scope (lines across all rooms). Two
 * scopes that price identically hash identically; any add/remove/qty/tenant%/
 * vendor-cost/vendor change flips it, which is exactly when a re-review is due.
 */
export function scopeHash(linesBySection: Record<string, HashableLine[]>): string {
  const rows: string[] = [];
  for (const sid of Object.keys(linesBySection)) {
    for (const l of linesBySection[sid] || []) {
      rows.push([
        sid,
        l.lineItemCode,
        Number(l.quantity) || 0,
        Number(l.tenantBillBackPercent) || 0,
        l.customVendorCost == null ? '' : Number(l.customVendorCost),
        l.assignedTo || '',
      ].join('|'));
    }
  }
  rows.sort();
  return fnv1a(rows.join('\n'));
}

// ----- Persisted "passed review" marker (per inspection) -------------------
// Survives reload on the same device. Keyed by inspection record id → the
// scope hash that passed. Submit is allowed only while the current scope hash
// still matches this.
const STORE_KEY = 'resiwalk_ai_review_passed_v1';

function readStore(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try { return JSON.parse(window.localStorage.getItem(STORE_KEY) || '{}') || {}; }
  catch { return {}; }
}

export function getPassedReviewHash(inspectionId: string): string | null {
  return readStore()[inspectionId] || null;
}

export function setPassedReviewHash(inspectionId: string, hash: string): void {
  if (typeof window === 'undefined') return;
  try {
    const all = readStore();
    all[inspectionId] = hash;
    window.localStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch { /* storage disabled — gating falls back to in-memory state */ }
}
