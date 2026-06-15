/**
 * Starter "gold list" of worked examples for the AI Knowledge Base.
 *
 * These are the canonical utterance → correct-action pairs distilled from real
 * field issues. They are imported INTO the editable AI Knowledge Base (admin →
 * "Import starter examples"), where they become normal example entries the
 * operator can edit, add to, or remove. Once in the KB they are injected as
 * worked few-shot examples into EVERY AI surface (voice mic, live camera,
 * still-photo scan, AI review) via getKnowledgeBasePromptText — so this list is
 * the seed of the single, editable source that drives the AI's reasoning.
 *
 * Keep each `expected` phrased as a clear instruction the model can follow. Grow
 * this list from the AI-feedback flywheel (real accept/reject data) and from any
 * new field issue, then re-import (idempotent — existing utterances are skipped).
 *
 * The deterministic guards behind several of these are unit-tested offline in
 * tests/rateCardAiCore.test.ts; semantic matching is gated by the live eval in
 * tests/eval/catalogMatch.gold.json (npm run eval).
 */
export interface KbExampleSeed {
  utterance: string;
  expected: string;
}

export const AI_KNOWLEDGE_EXAMPLE_SEED: KbExampleSeed[] = [
  {
    utterance: 'trim 10 bushes, 10 linear feet',
    expected: 'Add exactly ONE bush-trimming line at 10 LF. Never add stump removal, trash-out, debris haul, or any other work the inspector did not say.',
  },
  {
    utterance: 'level one sales clean',
    expected: 'Add a NEW Level 1 Sales Clean line. Do not edit the previous line and do not record this as a note on another line.',
  },
  {
    utterance: 'level 2 sales clean',
    expected: 'Add the Level 2 Sales Clean tier — never the Lite / Level 1 clean.',
  },
  {
    utterance: 'whole house mismatch',
    expected: 'Mist-match paint for the whole house: route it to the Whole House section and let the app fill the property square footage — do NOT ask how many square feet.',
  },
  {
    utterance: 'sales clean',
    expected: 'One whole-house Sales Clean line (Level 1 by default) in the Whole House section. Never break it into per-room cleaning items.',
  },
  {
    utterance: 'replace light bulb in the kitchen',
    expected: 'Add Replace Light Bulbs and route the line to the Kitchen (the named room), not the current/whole-house room.',
  },
  {
    utterance: 'replace this blind',
    expected: 'Add a Faux Wood Blind replacement. Only use a valance, vertical blind, or wand if the inspector names that exact part.',
  },
  {
    utterance: 'mismatched paint on the wall',
    expected: 'This means MIST-MATCH paint (a paint blending line) — not "something is mismatched". Add mist-match paint.',
  },
  {
    utterance: 'snake the toilet',
    expected: 'A count/EA item — add it at quantity 1 immediately; do not ask "how many".',
  },
  {
    utterance: 'replace the carpet',
    expected: 'Carpet is measured in square feet. If the inspector did not state the square footage, ask once ("How many square feet for the carpet?") before adding — never guess.',
  },
  {
    utterance: 'carpet on the stairs',
    expected: 'Stair carpet is priced PER STAIR. Ask how many stairs and use that count as the quantity — never default it to 1.',
  },
  {
    utterance: 'bid item in the kitchen to replace the disposal and re-caulk the sink',
    expected: 'A bid item: capture the spoken work as the description. If no price was stated, ask one ("Does $X work for this bid item?") before adding; once priced, add it and briefly confirm the price.',
  },
  {
    utterance: 'assign that to PPW',
    expected: 'Edit the most recent line and set its vendor to PPW. Do not add a new line.',
  },
  {
    utterance: 'make that 50 percent tenant',
    expected: 'Edit the most recent line and set the tenant chargeback to 50%. Do not add a new line.',
  },
  {
    utterance: 'trash out',
    expected: 'Ask which trash-out size (small / medium / large by volume), then add only that one labor line. Do not also add a dumpster unless the inspector says "dumpster".',
  },
];
