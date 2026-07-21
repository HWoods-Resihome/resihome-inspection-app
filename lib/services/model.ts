/**
 * ResiWalk — Services shared model: the live Service Work Order record shape plus
 * the status vocabulary and formatting helpers used across every Services screen
 * and API route. (Formerly co-located with preview sample data in sampleData.ts,
 * which has been retired — Services now render against the real HubSpot object.)
 */

import type { Worktype, ServiceScope } from './worktypes';

// Reserved key in a service's answers_json holding a vendor "proof of service"
// attachment (their own company invoice/PDF, usually already containing job
// photos). When present it stands in for before/after photos: the completion form
// no longer requires them, and the AI reviews the attachment under the knowledge-
// base rules instead of the before/after comparison. Kept out of the form-question
// namespace so it never renders as an answer row.
export const PROOF_URL_KEY = 'proof_of_service_url';
// Companion key holding the original uploaded filename (for display only).
export const PROOF_NAME_KEY = 'proof_of_service_name';

// Pipeline: Estimated → Assigned → Submitted → (Completed | Review).
// On submit the service STAYS in Submitted with an "AI Processing" tag while the AI
// reviews; the AI then either auto-completes it or routes it to Review for a human.
// AI Processing is a tag, not its own status. Canceled is terminal (hidden).
export type ServiceStatus = 'estimated' | 'assigned' | 'submitted' | 'review' | 'completed' | 'canceled';

/** A Service Work Order as consumed by the UI (mapped from the HubSpot object). */
export interface ServiceRecord {
  id: string;
  scope: ServiceScope;
  address: string;        // street line
  locality: string;       // "City, ST ZIP"
  community?: string;
  portfolio: string;
  region: string;         // matches the Property region set (e.g. "GA: Atlanta")
  worktype: Worktype;
  subtype: string;
  status: ServiceStatus;
  isBidItem?: boolean;     // a vendor-requested bid awaiting approval (no real due date yet)
  propertyStatus?: string; // the PROPERTY's status (SFR only), like the inspection cards
  petStations?: boolean;   // community services that include dedicated pet-station photos
  vendor: string | null;
  vendorEmail?: string | null; // assigned vendor's email — used to scope a vendor's view to their own
  dueDate: string;        // ISO date (YYYY-MM-DD)
  estimatedAt?: string;   // ISO date — when an estimated (bid) service was created
  completedAt?: string;   // ISO datetime — completed services only (drives day-view route order)
  onTime?: boolean;       // completed services only — landed on/before due date
  lat?: number;           // approximate property coordinates (for the map view)
  lng?: number;
  propertyId?: string;    // Property (or Community) record id — lets the map geocode
                          // via the property's stored coords when lat/lng are absent
  masterServiceId?: string; // set on a per-property billing line split from a community master
  forBilling?: boolean;     // this record is a billing line (children after split; masters before)
}

export const SERVICE_STATUS_ORDER: ServiceStatus[] =
  ['estimated', 'assigned', 'submitted', 'review', 'completed', 'canceled'];

// Shared status chip label + color (used on the home list AND the service record
// header so a status reads identically everywhere).
export const SERVICE_STATUS_LABEL: Record<ServiceStatus, string> = {
  estimated: 'Estimate', assigned: 'Assigned', submitted: 'Submitted',
  review: 'Review', completed: 'Completed', canceled: 'Canceled',
};
export const SERVICE_STATUS_STYLE: Record<ServiceStatus, string> = {
  estimated: 'bg-rose-100 text-rose-700 border-rose-200',
  assigned: 'bg-sky-100 text-sky-800 border-sky-300',
  submitted: 'bg-amber-100 text-amber-800 border-amber-300',
  review: 'bg-purple-100 text-purple-800 border-purple-300',
  completed: 'bg-green-100 text-green-800 border-green-300',
  canceled: 'bg-gray-100 text-gray-500 border-gray-300 line-through',
};

// App-wide service date format: M-D-YY (e.g. 2026-07-11 → 7-11-26). Accepts a
// YYYY-MM-DD string, an epoch-ms string, or any Date-parseable string.
export function fmtMDY(v: string): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${Number(m[2])}-${Number(m[3])}-${m[1].slice(2)}`;
  const d = /^\d{10,}$/.test(s) ? new Date(Number(s)) : new Date(s);
  return isNaN(d.getTime()) ? s : `${d.getUTCMonth() + 1}-${d.getUTCDate()}-${String(d.getUTCFullYear()).slice(-2)}`;
}

// Status text as shown to a viewer. Vendors (external) never see the internal AI
// step: a submitted service reads "Submitted - Under Review" for them; internal
// users see "Submitted" (plus the internal-only AI Processing tag elsewhere).
export function serviceStatusText(status: ServiceStatus | string, isInternal: boolean): string {
  if (status === 'submitted' && !isInternal) return 'Submitted - Under Review';
  return SERVICE_STATUS_LABEL[status as ServiceStatus] || String(status);
}

// Business-timezone "today" (canonical source lives in lib/services/time.ts).
export { easternTodayISO } from '@/lib/services/time';
