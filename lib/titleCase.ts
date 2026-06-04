/**
 * titleCase — "Proper Text" for labels/options across the app.
 *
 * Rules (per product spec):
 *   - Capitalize the first letter of every word…
 *   - …EXCEPT minor "filler" words (of, in, the, a, to, …), which stay
 *     lowercase unless they are the first word.
 *   - Preserve existing ALL-CAPS acronyms (HVAC, OK, N/A, ID, USA) as-is.
 *   - Hyphenated words are title-cased per segment ("Pump-Out", "Pre-Filled").
 *
 * Intentionally conservative: tokens containing digits (e.g. "16x20x1",
 * "Vendor 1") and acronyms are left untouched so we never mangle data values.
 */

const MINOR_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'nor', 'of', 'on',
  'or', 'per', 'the', 'to', 'vs', 'via', 'with',
]);

/** True for tokens we must leave exactly as-is (acronyms like HVAC, OK, N/A). */
function isAcronym(word: string): boolean {
  return word.length >= 2 && word === word.toUpperCase() && /[A-Z]/.test(word);
}

function capitalize(word: string): string {
  if (!word) return word;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Title-case a single hyphenated word, applying the minor-word rule per segment
 *  (the first segment is always capitalized). */
function titleCaseHyphenated(word: string): string {
  return word
    .split('-')
    .map((seg, j) => {
      if (isAcronym(seg)) return seg;
      const lower = seg.toLowerCase();
      if (j !== 0 && MINOR_WORDS.has(lower)) return lower;
      return capitalize(seg);
    })
    .join('-');
}

export function titleCase(input: string | null | undefined): string {
  if (!input) return '';
  const words = String(input).trim().split(/\s+/);
  return words
    .map((word, i) => {
      if (isAcronym(word)) return word;            // HVAC, OK, N/A, ID …
      const lower = word.toLowerCase();
      if (i !== 0 && MINOR_WORDS.has(lower)) return lower;  // filler words
      if (word.includes('-')) return titleCaseHyphenated(word);
      return capitalize(word);
    })
    .join(' ');
}
