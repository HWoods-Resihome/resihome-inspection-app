/**
 * SAMPLE data for the Services preview (Step 1).
 *
 * The real `service_work_order` HubSpot object doesn't exist yet (Step 3), so the
 * Services home and rules-engine screens render against this illustrative set so
 * the layout, filters, and sorting are reviewable on the preview. It is only ever
 * imported by flag-gated Services screens (never shipped to production behavior)
 * and is clearly labelled "sample" in the UI. Delete once the Services list is
 * wired to the real object.
 */

import type { Worktype, ServiceScope } from './worktypes';

// Pipeline: Estimated → Assigned → Submitted → AI Processing → (Completed | Review) → Completed.
// A submitted service enters ai_processing; the AI review either auto-completes it or
// routes it to review for a human. Canceled is terminal (hidden from list/counts).
export type ServiceStatus = 'estimated' | 'assigned' | 'submitted' | 'ai_processing' | 'review' | 'completed' | 'canceled';

export interface SampleService {
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
  propertyStatus?: string; // the PROPERTY's status (SFR only), like the inspection cards
  petStations?: boolean;   // community services that include dedicated pet-station photos
  vendor: string | null;
  dueDate: string;        // ISO date (YYYY-MM-DD)
  onTime?: boolean;       // completed services only — landed on/before due date
  lat: number;            // approximate property coordinates (for the map view)
  lng: number;
}

export const SAMPLE_VENDORS = ['GreenBlade Lawn Co.', 'Peachtree Grounds', 'Metro Cut LLC', 'AquaPro Pools'];
export const SAMPLE_REGIONS = ['GA: Atlanta', 'GA: Columbus'];
// Unique communities (stand-in for the Community object list) — name + location.
// Real display pulls community_city / state / community_zipcode from the Community
// object (see lib/hubspot listCommunities on main); property falls back to its own
// city/state/zip.
export const SAMPLE_COMMUNITIES: { name: string; locality: string }[] = [
  { name: 'Woodbine Crossing', locality: 'Riverdale, GA 30296' },
  { name: 'River Glen', locality: 'Riverdale, GA 30296' },
  { name: 'Camden Pointe', locality: 'Atlanta, GA 30331' },
  { name: 'Harlow Trace', locality: 'Marietta, GA 30060' },
  { name: 'Stonecreek', locality: 'Columbus, GA 31904' },
  { name: 'Maple Run', locality: 'Decatur, GA 30032' },
];

// Fixed "today" for the preview so Past-Due is deterministic against the sample
// due dates (real code uses the actual date).
export const REFERENCE_TODAY = '2026-07-18';

export const SAMPLE_SERVICES: SampleService[] = [
  { id: 'S-1041', scope: 'property',  address: '935 River Glen Pl',  locality: 'Riverdale, GA 30296', portfolio: 'Amherst Sunbelt', region: 'GA: Atlanta',  worktype: 'landscaping', subtype: 'cut',          status: 'estimated',   propertyStatus: 'Vacant',           vendor: 'GreenBlade Lawn Co.', dueDate: '2026-07-22', lat: 33.573, lng: -84.413 },
  { id: 'S-1042', scope: 'property',  address: '7558 Woodbine Pl',   locality: 'Riverdale, GA 30296', portfolio: 'Amherst Sunbelt', region: 'GA: Atlanta',  worktype: 'landscaping', subtype: 'cut',          status: 'assigned',  propertyStatus: 'Pending MOI/Rekey', vendor: 'GreenBlade Lawn Co.', dueDate: '2026-07-19', lat: 33.560, lng: -84.405 },
  { id: 'S-1043', scope: 'property',  address: '412 Camden Loop',    locality: 'Atlanta, GA 30331',   portfolio: 'Tricon GA',       region: 'GA: Atlanta',  worktype: 'pools',       subtype: 'pool_cleaning', status: 'submitted', propertyStatus: 'Vacant',           vendor: 'AquaPro Pools',       dueDate: '2026-07-17', lat: 33.720, lng: -84.510 },
  { id: 'S-1044', scope: 'property',  address: '88 Harlow Trace',    locality: 'Marietta, GA 30060',  portfolio: 'Tricon GA',       region: 'GA: Atlanta',  worktype: 'landscaping', subtype: 'tree_trimming', status: 'review',   propertyStatus: 'Vacant',           vendor: 'Metro Cut LLC',       dueDate: '2026-07-15', lat: 33.952, lng: -84.549 },
  { id: 'S-1045', scope: 'property',  address: '2201 Stone Manor Ct',locality: 'Lithonia, GA 30058',  portfolio: 'Progress',        region: 'GA: Atlanta',  worktype: 'cleaning',    subtype: 'vacant_clean',  status: 'completed',   propertyStatus: 'Occupied',         vendor: 'Peachtree Grounds',   dueDate: '2026-07-11', onTime: true, lat: 33.712, lng: -84.105 },
  { id: 'S-1046', scope: 'community', address: 'Woodbine Crossing',  locality: 'Riverdale, GA 30296', community: 'Woodbine Crossing', portfolio: 'Amherst Sunbelt', region: 'GA: Atlanta', worktype: 'landscaping', subtype: 'cut',       status: 'estimated',   petStations: true, vendor: 'GreenBlade Lawn Co.', dueDate: '2026-07-24', lat: 33.579, lng: -84.420 },
  { id: 'S-1047', scope: 'community', address: 'River Glen',         locality: 'Riverdale, GA 30296', community: 'River Glen',        portfolio: 'Amherst Sunbelt', region: 'GA: Atlanta', worktype: 'cleaning',    subtype: 'common_area',   status: 'assigned',  vendor: 'Peachtree Grounds',   dueDate: '2026-07-20', lat: 33.566, lng: -84.398 },
  { id: 'S-1048', scope: 'community', address: 'Camden Pointe',      locality: 'Columbus, GA 31904',  community: 'Camden Pointe',     portfolio: 'Tricon GA',       region: 'GA: Columbus', worktype: 'trash_removal', subtype: 'trash_pickup', status: 'submitted', vendor: 'Metro Cut LLC',       dueDate: '2026-07-16', lat: 32.510, lng: -84.987 },
  { id: 'S-1049', scope: 'community', address: 'Harlow Trace',       locality: 'Columbus, GA 31909',  community: 'Harlow Trace',      portfolio: 'Progress',        region: 'GA: Columbus', worktype: 'landscaping', subtype: 'cut',      status: 'review',   petStations: true, vendor: null,                  dueDate: '2026-07-16', lat: 32.552, lng: -84.902 },
  { id: 'S-1050', scope: 'property',  address: '19 Maple Run Dr',    locality: 'Decatur, GA 30032',   portfolio: 'Progress',        region: 'GA: Atlanta',  worktype: 'landscaping', subtype: 'cut',          status: 'canceled',    propertyStatus: 'Occupied', vendor: null,                  dueDate: '2026-07-08', lat: 33.740, lng: -84.263 },
  { id: 'S-1051', scope: 'property',  address: '640 Oakvale Rd',     locality: 'Decatur, GA 30032',   portfolio: 'Amherst Sunbelt', region: 'GA: Atlanta',  worktype: 'landscaping', subtype: 'cut',          status: 'completed',   propertyStatus: 'Occupied', vendor: 'GreenBlade Lawn Co.', dueDate: '2026-07-04', onTime: true, lat: 33.772, lng: -84.281 },
  { id: 'S-1052', scope: 'property',  address: '77 Pinehurst Way',   locality: 'Columbus, GA 31904',  portfolio: 'Tricon GA',       region: 'GA: Columbus', worktype: 'pools',       subtype: 'pool_cleaning', status: 'completed',   propertyStatus: 'Occupied', vendor: 'AquaPro Pools',       dueDate: '2026-07-02', onTime: false, lat: 32.505, lng: -84.995 },
];

export const SAMPLE_STATUS_ORDER: ServiceStatus[] =
  ['estimated', 'assigned', 'submitted', 'ai_processing', 'review', 'completed', 'canceled'];

// Sample PROPERTY records for the rules-engine coverage drill-down (Portfolio →
// Region → individual properties). Real data comes from the Property object later.
export interface SampleProperty { id: string; address: string; locality: string; portfolio: string; region: string; }
export const SAMPLE_PROPERTIES: SampleProperty[] = (() => {
  const portfolios = ['Amherst Sunbelt', 'Tricon GA', 'Progress', 'Invitation Homes', 'FirstKey', 'VineBrook'];
  const streets = ['River Glen Pl', 'Woodbine Pl', 'Camden Loop', 'Harlow Trace', 'Maple Run Dr', 'Oakvale Rd', 'Pinehurst Way', 'Stone Manor Ct', 'Birch Hollow Dr', 'Cedar Bend Ct'];
  const out: SampleProperty[] = [];
  let n = 100;
  portfolios.forEach((pf, pi) => {
    const count = 5 + (pi % 2); // 5–6 per portfolio
    for (let i = 0; i < count; i++) {
      const columbus = (pi + i) % 3 === 0;
      out.push({
        id: `P-${n}`,
        address: `${120 + n} ${streets[(pi + i) % streets.length]}`,
        locality: columbus ? 'Columbus, GA 31904' : 'Atlanta, GA 30331',
        portfolio: pf,
        region: columbus ? 'GA: Columbus' : 'GA: Atlanta',
      });
      n++;
    }
  });
  return out;
})();
