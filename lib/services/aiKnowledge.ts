/**
 * ResiWalk - Services — AI review knowledge base.
 *
 * When a vendor SUBMITS a service it enters AI Processing. The AI evaluates the
 * evidence (photos, timing, form selections) against these checks: if everything
 * is clean it auto-moves to Completed; if ANY check raises a concern it routes to
 * Review for a human. Every check is equally important. Analog of the scope
 * rate-card AI-review knowledge base — admins add / edit / delete checks here.
 *
 * Each check is scoped by work type + subtype. Empty worktype = ALL work types;
 * empty subtype = ALL subtypes (of that work type, or all if worktype is empty).
 *
 * Preview/sample only (local state). Step 2 persists these and feeds them into
 * the review prompt.
 */

export interface AiCheck {
  id: string;
  check: string;     // what the AI must verify
  worktype: string;  // '' = all work types
  subtype: string;   // '' = all subtypes
  active: boolean;
}

// Foundational knowledge — seeded from the initial review criteria.
export const SAMPLE_AI_CHECKS: AiCheck[] = [
  { id: 'k1', check: 'Service duration is realistic for the work — not completed suspiciously fast for the scope.', worktype: '', subtype: '', active: true },
  { id: 'k2', check: 'Before and after photos are spaced apart in time (not taken within seconds of each other).', worktype: '', subtype: '', active: true },
  { id: 'k3', check: 'Both before AND after photos are present, in focus, and show the actual work area.', worktype: '', subtype: '', active: true },
  { id: 'k4', check: 'Photos are GPS-stamped at/near the property (within the geofence).', worktype: '', subtype: '', active: true },
  { id: 'k5', check: 'Photos are not reused/duplicated from a prior visit and match the correct property.', worktype: '', subtype: '', active: true },
  { id: 'k6', check: 'Pre-cut grass height in the photos matches the height tier the vendor selected.', worktype: 'landscaping', subtype: 'cut', active: true },
  { id: 'k7', check: 'Back yard is clearly shown (not just the front).', worktype: 'landscaping', subtype: '', active: true },
  { id: 'k8', check: 'All 4 sides of the house are captured.', worktype: 'landscaping', subtype: '', active: true },
  { id: 'k9', check: 'Photos show actual cleaning evidence (supplies present, surfaces cleared/wiped).', worktype: 'cleaning', subtype: '', active: true },
  { id: 'k10', check: 'Water is clear and equipment/baskets are shown; chemical test evidence where required.', worktype: 'pools', subtype: '', active: true },
];

let _kid = 500;
export const newCheck = (): AiCheck =>
  ({ id: `k${++_kid}`, check: '', worktype: '', subtype: '', active: true });
