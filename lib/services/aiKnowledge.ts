/**
 * ResiWalk - Services — AI review knowledge base.
 *
 * When a vendor SUBMITS a service it enters AI Processing. The AI evaluates the
 * evidence (photos, timing, form selections) against these checks: if everything
 * is clean it auto-moves to Completed; if any high/medium check raises a concern
 * it routes to Review for a human. This is the services analog of the scope
 * rate-card AI-review knowledge base — admins add / edit / delete checks here.
 *
 * Preview/sample only (local state). Step 2 persists to the Services AI knowledge
 * store and feeds them into the review prompt.
 */

export type Severity = 'high' | 'medium' | 'low';
export const SEVERITY_LABEL: Record<Severity, string> = { high: 'High', medium: 'Medium', low: 'Low' };
export const SEVERITY_STYLE: Record<Severity, string> = {
  high: 'bg-red-100 text-red-700 border-red-300',
  medium: 'bg-amber-100 text-amber-800 border-amber-300',
  low: 'bg-gray-100 text-gray-600 border-gray-300',
};

export interface AiCheck {
  id: string;
  category: string;    // grouping (Timing, Photo coverage, Landscaping, Cleaning, …)
  check: string;       // what the AI must verify
  severity: Severity;  // high/medium fail → route to Review; low → note only
  worktype: string;    // '' = applies to all worktypes, else scoped (e.g. 'landscaping')
  active: boolean;
}

export const AI_CATEGORIES = ['Timing', 'Photo Coverage', 'Landscaping', 'Cleaning', 'Pools', 'Integrity'];

// Foundational knowledge — seeded from the initial review criteria.
export const SAMPLE_AI_CHECKS: AiCheck[] = [
  { id: 'k1', category: 'Timing', check: 'Service duration is realistic for the work — not completed suspiciously fast for the scope.', severity: 'high', worktype: '', active: true },
  { id: 'k2', category: 'Timing', check: 'Before and after photos are spaced apart in time (not taken within seconds of each other).', severity: 'high', worktype: '', active: true },
  { id: 'k3', category: 'Photo Coverage', check: 'Both before AND after photos are present, in focus, and show the actual work area.', severity: 'high', worktype: '', active: true },
  { id: 'k4', category: 'Photo Coverage', check: 'Photos are GPS-stamped at/near the property (within the geofence).', severity: 'medium', worktype: '', active: true },
  { id: 'k5', category: 'Integrity', check: 'Photos are not reused/duplicated from a prior visit and match the correct property.', severity: 'high', worktype: '', active: true },
  { id: 'k6', category: 'Landscaping', check: 'Pre-cut grass height in the photos matches the height tier the vendor selected.', severity: 'high', worktype: 'landscaping', active: true },
  { id: 'k7', category: 'Photo Coverage', check: 'Back yard is clearly shown (not just the front).', severity: 'high', worktype: 'landscaping', active: true },
  { id: 'k8', category: 'Photo Coverage', check: 'All 4 sides of the house are captured.', severity: 'medium', worktype: 'landscaping', active: true },
  { id: 'k9', category: 'Cleaning', check: 'Photos show actual cleaning evidence (supplies present, surfaces cleared/wiped).', severity: 'medium', worktype: 'cleaning', active: true },
  { id: 'k10', category: 'Pools', check: 'Water is clear and equipment/baskets are shown; chemical test evidence where required.', severity: 'medium', worktype: 'pools', active: true },
];

let _kid = 500;
export const newCheck = (): AiCheck =>
  ({ id: `k${++_kid}`, category: 'Photo Coverage', check: '', severity: 'medium', worktype: '', active: true });
