/**
 * Shared rate-card AI core.
 *
 * The two AI surfaces — the microphone/voice assistant (auto-adds a line) and
 * the in-camera AI (suggests a chip the inspector confirms) — must apply the
 * SAME catalog-resolution rules so a fix or rule change lands on BOTH at once.
 * Their plumbing legitimately differs (the voice path is a conversational tool
 * loop; the camera path is a single vision/voice pass), but every domain
 * decision below is shared here:
 *
 *   - aliasFor()            phrase normalization (re-exported; both call it)
 *   - correctCleanLevel()   honor an explicit "level 1/2" clean tier
 *   - correctBlinds()       a bare "blind" is a faux-wood blind replacement
 *   - wholeHouseExempt()    a Whole-House SF line auto-fills the property sqft
 *                           (don't ask for a measurement)
 *   - measuredUnitOf()      SF/LF/SY detection
 *   - measurementWord()     spoken unit name
 *   - isStairCount()        carpet/tread on stairs is priced per stair
 *   - resolveTenantPct()    depreciation-aware default tenant %
 *   - normalizeVendor()     map a spoken vendor to an allowed vendor
 *
 * Keep all such rules HERE, not inlined in either endpoint.
 */
import type { RateCardLineItem } from '@/lib/types';
import { depKindForCategory, depreciationTenantPct } from '@/lib/depreciation';
import { VENDORS } from '@/lib/vendors';

export { aliasFor } from '@/lib/voiceAliases';

const isCleanText = (s: string) => /clean/i.test(s);

/**
 * Correct a matched CLEAN to the tier the inspector explicitly named. If they
 * said "level 2" but the match is a lower tier (Lite / Level 1), swap to the
 * Level-2 sibling in the same category + subcategory; and the reverse for
 * "level 1". No-op for non-clean items, when no level was stated, or when no
 * sibling exists. `userText` is the inspector's phrasing (their full utterance,
 * which still carries the level even after alias normalization drops it).
 */
export function correctCleanLevel(item: RateCardLineItem, userText: string, catalog: RateCardLineItem[]): RateCardLineItem {
  const desc = item.laborShortDescription || '';
  if (!isCleanText(`${desc} ${item.category} ${item.subcategory}`)) return item;
  const wantsL2 = /\blevel\s*(2|two)\b/i.test(userText) || /\bl2\b/i.test(userText);
  const wantsL1 = /\blevel\s*(1|one)\b/i.test(userText) || /\bl1\b/i.test(userText);
  if (!wantsL2 && !wantsL1) return item;
  const isL2 = (d: string) => /level\s*2|level\s*two|\bl2\b/i.test(d);
  const isL1 = (d: string) => /level\s*1|level\s*one|\bl1\b|\blite\b/i.test(d);
  const sibling = (pred: (d: string) => boolean) => catalog.find((c) =>
    c.isActive !== false
    && (c.category || '') === (item.category || '')
    && (c.subcategory || '') === (item.subcategory || '')
    && isCleanText(c.laborShortDescription || '')
    && pred(c.laborShortDescription || ''));
  if (wantsL2 && !isL2(desc)) { const s = sibling(isL2); if (s) return s; }
  else if (wantsL1 && !isL1(desc)) { const s = sibling(isL1); if (s) return s; }
  return item;
}

/**
 * A broken/missing/damaged "blind" is a FAUX WOOD BLIND replacement unless the
 * inspector named a specific part (valance / wand / vertical). If the match
 * landed on one of those parts but the request just said "blind", swap to a
 * faux-wood-blind item.
 */
export function correctBlinds(item: RateCardLineItem, userText: string, catalog: RateCardLineItem[]): RateCardLineItem {
  if (!/\bblind/i.test(userText)) return item;
  if (/valance|wand|vertical/i.test(userText)) return item;                 // a specific part was named
  if (!/valance|wand|vertical/i.test(item.laborShortDescription || '')) return item; // already not a part item
  const faux = catalog.find((c) => c.isActive !== false && /faux\s*wood\s*blind/i.test(c.laborShortDescription || ''));
  return faux || item;
}

/** Does the catalog item's own description say whole/full house? */
export function isWholeHouseItem(item: RateCardLineItem): boolean {
  return /\b(whole|full)\s*house\b/i.test(item.laborShortDescription || '');
}

/**
 * Whether a measured (SF/LF/SY) line should SKIP asking for a measurement
 * because the Whole House section auto-fills the property square footage. True
 * when the item itself is whole-house, OR the work is attributed to the Whole
 * House room — the current section, the model's room input, OR the inspector
 * said "whole house" AND a Whole House section exists to route the line into.
 */
export function wholeHouseExempt(opts: {
  item: RateCardLineItem;
  sectionName?: string;
  roomInput?: string;
  utterance?: string;
  hasWholeHouseRoom?: boolean;
}): boolean {
  const { item, sectionName = '', roomInput = '', utterance = '', hasWholeHouseRoom = false } = opts;
  return isWholeHouseItem(item)
    || /whole\s*house/i.test(sectionName)
    || /\b(whole|full)\s*house\b/i.test(roomInput)
    || (/\b(whole|full)\s*house\b/i.test(utterance) && hasWholeHouseRoom);
}

export function measuredUnitOf(item: RateCardLineItem): { unit: string; isMeasured: boolean } {
  const unit = (item.laborMeas || '').trim().toUpperCase();
  return { unit, isMeasured: unit === 'SF' || unit === 'LF' || unit === 'SY' };
}

export function measurementWord(unit: string): string {
  const u = (unit || '').toUpperCase();
  return u === 'SF' ? 'square feet' : u === 'LF' ? 'linear feet' : u === 'SY' ? 'square yards' : '';
}

/** Carpet/tread/runner on stairs is priced PER STAIR even though the unit reads
 *  "each", so a defaulted quantity of 1 is almost always wrong. */
export function isStairCount(item: RateCardLineItem): boolean {
  return /\bstair/i.test(item.laborShortDescription || '');
}

/** Depreciation-aware default tenant chargeback %, clamped to 0-100 step 5. */
export function resolveTenantPct(item: RateCardLineItem, tenantMonths: number): number {
  const depKind = depKindForCategory(item.category, item.laborShortDescription);
  const pct = depKind ? depreciationTenantPct(depKind, tenantMonths) : 100;
  return Math.max(0, Math.min(100, Math.round(pct / 5) * 5));
}

/** Map a spoken/proposed vendor to an allowed vendor, defaulting to "Vendor 1". */
export function normalizeVendor(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s) return 'Vendor 1';
  const exact = VENDORS.find((x) => x.toLowerCase() === s.toLowerCase());
  if (exact) return exact;
  const partial = VENDORS.find((x) => x.toLowerCase().includes(s.toLowerCase()) || s.toLowerCase().includes(x.toLowerCase()));
  return partial || 'Vendor 1';
}
