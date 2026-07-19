/**
 * lib/vendorRegions.ts — parsing + cleanup for the Companies `regions_serviced`
 * string ("GA: Atlanta; TX: Houston").
 *
 * The hand-entered HubSpot data carries three defect shapes this normalizes:
 *   • typo'd city names            "AL: Hunstville"        → "AL: Huntsville"
 *   • broken state prefixes        "O : Oklahoma City"     → "OK: Oklahoma City"
 *   • colon-joined multi-regions   "TX: Dallas: TX: Houston" → two regions
 * Shared by the Vendor Management UI (display + option list) and the API (which
 * lazily repairs mismatched stored values back to HubSpot on read).
 */

// Exact-token fixes applied after splitting (lowercased key → canonical value).
const TOKEN_FIXES: Record<string, string> = {
  'al: hunstville': 'AL: Huntsville',
  'o : oklahoma city': 'OK: Oklahoma City',
  'o: oklahoma city': 'OK: Oklahoma City',
};

/** Canonical form of one region token: trimmed, single-spaced, "ST: City". */
export function canonicalRegion(token: string): string {
  let t = String(token || '').trim().replace(/\s+/g, ' ');
  if (!t) return '';
  const fix = TOKEN_FIXES[t.toLowerCase()];
  if (fix) return fix;
  // Normalize "ST : City" / "ST:City" spacing to "ST: City", uppercase the state,
  // and Title-Case the city's words (first letter only — preserves "McAllen").
  const m = /^([A-Za-z]{2})\s*:\s*(.+)$/.exec(t);
  if (m) {
    const city = m[2].trim().split(' ').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
    t = `${m[1].toUpperCase()}: ${city}`;
  }
  return t;
}

/**
 * Parse a stored regions string into clean tokens. Splits on ; and , then
 * further splits any chunk that concatenates multiple "ST:" prefixes with
 * colons ("TX: Dallas: TX: Houston" → ["TX: Dallas", "TX: Houston"]).
 * De-duplicates case-insensitively, preserving first-seen order.
 */
export function parseRegions(stored: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (tok: string) => {
    const c = canonicalRegion(tok);
    if (!c) return;
    const k = c.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(c); }
  };
  for (const chunk of String(stored || '').split(/[;,]/)) {
    const t = chunk.trim();
    if (!t) continue;
    // A chunk with 2+ state prefixes was colon-joined — extract each "ST: City".
    const multi = t.match(/[A-Za-z]{2}\s*:\s*[^:;,]+/g);
    if (multi && multi.length > 1) { multi.forEach(push); continue; }
    push(t);
  }
  return out;
}

/** Canonical stored form: "; "-joined clean tokens. */
export function joinRegions(tokens: string[]): string {
  // Re-canonicalize + dedupe so callers can pass raw picks.
  return parseRegions(tokens.join('; ')).join('; ');
}

/** Canonical stored form of an existing stored string (for repair comparison). */
export function normalizeRegionsString(stored: string): string {
  return parseRegions(stored).join('; ');
}
