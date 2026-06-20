/**
 * Maps a 1099 Leasing Agent inspection's answers to the standardized reporting
 * fields stamped onto the Inspection object at completion (and by the backfill).
 *
 * The two source questions are matched by their text (carried in each answer's
 * `answer_summary`), so a form-builder rename of unrelated questions won't break
 * the mapping:
 *   - "Evaluate Listing Price"  → response (answer), recommendation (the
 *      dependent recommended-rent number), feedback (the required note)
 *   - "Grass Condition"         → response (answer), feedback (the required note)
 *
 * The Utilities answers (Electric / Water / Gas / Trash Bins) live in the Final
 * Checklist blob (one `qa` record whose `note` is a JSON map of FcAnswers), so
 * they're read from there and stamped as their own inspection fields.
 */
import type { SavedAnswer } from '@/lib/hubspot';

const LISTING_RE = /evaluate listing price|listing price/i;
const GRASS_RE = /grass condition/i;

export interface LeasingAgent1099Fields {
  listing_price_response_1099?: string;
  listing_price_recommendation_1099?: number | '';
  listing_price_feedback_1099?: string;
  landscaping_response_1099?: string;
  landscaping_feedback_1099?: string;
  // Utilities (from the Final Checklist) — the selected value as shown on the
  // form (On / Off / N/A, or Present / Missing / N/A).
  electric?: string;
  water?: string;
  gas?: string;
  trash_bins?: string;
}

/** Build the inspection-property set from the answers. Only includes a field
 *  when its source answer exists, so a partial inspection writes what it has. */
export function extractLeasingAgent1099Fields(answers: SavedAnswer[]): LeasingAgent1099Fields {
  const qa = answers.filter((a) => (a.answerType || 'qa') === 'qa');
  const listing = qa.find((a) => LISTING_RE.test(a.answerSummary || ''));
  const grass = qa.find((a) => GRASS_RE.test(a.answerSummary || ''));

  const out: LeasingAgent1099Fields = {};
  if (listing) {
    out.listing_price_response_1099 = listing.answerValue || '';
    out.listing_price_feedback_1099 = listing.note || '';
    // '' clears the number field when no recommendation was entered (Keep).
    out.listing_price_recommendation_1099 = listing.recommendedAmount != null ? listing.recommendedAmount : '';
  }
  if (grass) {
    out.landscaping_response_1099 = grass.answerValue || '';
    out.landscaping_feedback_1099 = grass.note || '';
  }

  // Utilities live in the Final Checklist blob: one `qa` record (questionIdExternal
  // 'fc__all' / answerIdExternal 'FINALCHECKLIST-*') whose `note` is JSON-encoded
  // FcAnswers keyed by question id (fc_electric, fc_water, fc_gas, fc_trash_bins).
  const fcBlob = answers.find(
    (a) => a.questionIdExternal === 'fc__all' || String(a.answerIdExternal || '').startsWith('FINALCHECKLIST-'),
  );
  if (fcBlob) {
    try {
      const fc = JSON.parse(fcBlob.note || '{}') as Record<string, { value?: string }>;
      const val = (k: string) => String(fc[k]?.value ?? '').trim();
      if (fc.fc_electric) out.electric = val('fc_electric');
      if (fc.fc_water) out.water = val('fc_water');
      if (fc.fc_gas) out.gas = val('fc_gas');
      if (fc.fc_trash_bins) out.trash_bins = val('fc_trash_bins');
    } catch { /* malformed blob → skip utilities */ }
  }
  return out;
}
