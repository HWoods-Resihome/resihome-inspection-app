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

export type ServiceStatus =
  | 'scheduled' | 'dispatched' | 'in_progress' | 'submitted' | 'completed' | 'cancelled';

export interface SampleService {
  id: string;
  scope: ServiceScope;
  address: string;        // street line
  locality: string;       // "City, ST ZIP"
  community?: string;
  portfolio: string;
  region: string;         // matches the Property region set (e.g. "GA: Atlanta")
  worktype: Worktype;
  status: ServiceStatus;
  vendor: string | null;
  dueDate: string;        // ISO date (YYYY-MM-DD)
  onTime?: boolean;       // completed services only — landed on/before due date
}

export const SAMPLE_VENDORS = ['GreenBlade Lawn Co.', 'Peachtree Grounds', 'Metro Cut LLC', 'AquaPro Pools'];
export const SAMPLE_REGIONS = ['GA: Atlanta', 'GA: Columbus'];

// Fixed "today" for the preview so Past-Due is deterministic against the sample
// due dates (real code uses the actual date).
export const REFERENCE_TODAY = '2026-07-18';

export const SAMPLE_SERVICES: SampleService[] = [
  { id: 'S-1041', scope: 'property',  address: '935 River Glen Pl',  locality: 'Riverdale, GA 30296', portfolio: 'Amherst Sunbelt', region: 'GA: Atlanta',  worktype: 'grass_cut',      status: 'scheduled',   vendor: 'GreenBlade Lawn Co.', dueDate: '2026-07-22' },
  { id: 'S-1042', scope: 'property',  address: '7558 Woodbine Pl',   locality: 'Riverdale, GA 30296', portfolio: 'Amherst Sunbelt', region: 'GA: Atlanta',  worktype: 'grass_cut',      status: 'dispatched',  vendor: 'GreenBlade Lawn Co.', dueDate: '2026-07-19' },
  { id: 'S-1043', scope: 'property',  address: '412 Camden Loop',    locality: 'Atlanta, GA 30331',   portfolio: 'Tricon GA',       region: 'GA: Atlanta',  worktype: 'pool_service',   status: 'in_progress', vendor: 'AquaPro Pools',       dueDate: '2026-07-17' },
  { id: 'S-1044', scope: 'property',  address: '88 Harlow Trace',    locality: 'Marietta, GA 30060',  portfolio: 'Tricon GA',       region: 'GA: Atlanta',  worktype: 'grass_cut',      status: 'submitted',   vendor: 'Metro Cut LLC',       dueDate: '2026-07-15' },
  { id: 'S-1045', scope: 'property',  address: '2201 Stone Manor Ct',locality: 'Lithonia, GA 30058',  portfolio: 'Progress',        region: 'GA: Atlanta',  worktype: 'house_cleaning', status: 'completed',   vendor: 'Peachtree Grounds',   dueDate: '2026-07-11', onTime: true },
  { id: 'S-1046', scope: 'community', address: 'Woodbine Crossing',  locality: 'Riverdale, GA 30296', community: 'Woodbine Crossing', portfolio: 'Amherst Sunbelt', region: 'GA: Atlanta', worktype: 'grass_cut',    status: 'scheduled',   vendor: 'GreenBlade Lawn Co.', dueDate: '2026-07-24' },
  { id: 'S-1047', scope: 'community', address: 'River Glen',         locality: 'Riverdale, GA 30296', community: 'River Glen',        portfolio: 'Amherst Sunbelt', region: 'GA: Atlanta', worktype: 'pet_station',  status: 'dispatched',  vendor: 'Peachtree Grounds',   dueDate: '2026-07-20' },
  { id: 'S-1048', scope: 'community', address: 'Camden Pointe',      locality: 'Columbus, GA 31904',  community: 'Camden Pointe',     portfolio: 'Tricon GA',       region: 'GA: Columbus', worktype: 'trash_pickup', status: 'in_progress', vendor: 'Metro Cut LLC',       dueDate: '2026-07-16' },
  { id: 'S-1049', scope: 'community', address: 'Harlow Trace',       locality: 'Columbus, GA 31909',  community: 'Harlow Trace',      portfolio: 'Progress',        region: 'GA: Columbus', worktype: 'model_clean',  status: 'submitted',   vendor: null,                  dueDate: '2026-07-16' },
  { id: 'S-1050', scope: 'property',  address: '19 Maple Run Dr',    locality: 'Decatur, GA 30032',   portfolio: 'Progress',        region: 'GA: Atlanta',  worktype: 'grass_cut',      status: 'scheduled',   vendor: null,                  dueDate: '2026-07-26' },
  { id: 'S-1051', scope: 'property',  address: '640 Oakvale Rd',     locality: 'Decatur, GA 30032',   portfolio: 'Amherst Sunbelt', region: 'GA: Atlanta',  worktype: 'grass_cut',      status: 'completed',   vendor: 'GreenBlade Lawn Co.', dueDate: '2026-07-04', onTime: true },
  { id: 'S-1052', scope: 'property',  address: '77 Pinehurst Way',   locality: 'Columbus, GA 31904',  portfolio: 'Tricon GA',       region: 'GA: Columbus', worktype: 'pool_service',   status: 'completed',   vendor: 'AquaPro Pools',       dueDate: '2026-07-02', onTime: false },
];

export const SAMPLE_STATUS_ORDER: ServiceStatus[] =
  ['scheduled', 'dispatched', 'in_progress', 'submitted', 'completed'];
