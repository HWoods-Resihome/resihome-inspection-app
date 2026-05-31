/**
 * Voice phrase aliases — a small, deterministic rules layer that normalizes
 * common inspector phrasings into the catalog query (and category hint) that
 * actually finds the right line. This runs BEFORE the semantic matcher so
 * high-frequency phrases ("sales clean", "mist match") match reliably instead
 * of depending on embedding luck.
 *
 * Keep this tight: only add rules for phrases that are genuinely ambiguous or
 * that the matcher gets wrong, so it never hijacks a legitimate different item.
 */
export interface QueryAlias {
  query: string;          // the query to search instead
  categoryHint?: string;  // bias the matcher toward this catalog category
  roomHint?: string;      // the room this typically belongs to (informational)
}

const RULES: { test: RegExp; alias: QueryAlias }[] = [
  // Whole-house clean: "sales clean", "turn clean", "full/whole house clean(ing)",
  // "clean the (whole/entire) house", "house clean". → the single whole-house
  // Sales Clean line, NOT per-room cleaning items.
  {
    test: /\b(sales?\s*clean|turn\s*clean|(full|whole|entire)\s*house\s*clean(ing)?|clean\s*(the\s*)?(whole|entire)\s*house|house\s*clean(ing)?)\b/i,
    alias: { query: 'whole house sales clean', categoryHint: 'Cleaning', roomHint: 'Whole House' },
  },
  // "mist match" paint (often transcribed "mismatch"/"missed match").
  {
    test: /\bmis(s|t)?\s*-?\s*match(ed)?\b/i,
    alias: { query: 'mist match paint', categoryHint: 'Painting' },
  },
];

/** Return the alias for a phrase, or null if no rule matches. */
export function aliasFor(phrase: string): QueryAlias | null {
  const p = (phrase || '').trim();
  if (!p) return null;
  for (const r of RULES) if (r.test.test(p)) return r.alias;
  return null;
}
