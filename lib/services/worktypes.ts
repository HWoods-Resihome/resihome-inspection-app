/**
 * ResiWalk - Services — canonical worktype + subtype taxonomy.
 *
 * Every worktype has one or more SUBTYPES (uniform: single-service worktypes still
 * carry one default subtype). Subtypes hold the default vendor rate; the worktype
 * holds the default scope-of-work description (editable per rule in the Rules
 * Engine). Kept in lockstep with the future HubSpot enums.
 */

export type ServiceScope = 'property' | 'community';
export type Worktype = 'landscaping' | 'cleaning' | 'pools' | 'trash_removal' | 'trip_fee';

export interface Subtype { id: string; label: string; defaultRate?: number; description?: string; }
export interface WorktypeDef {
  id: Worktype;
  label: string;
  scopes: ServiceScope[];
  defaultDescription: string;
  subtypes: Subtype[];
}

export const WORKTYPES: WorktypeDef[] = [
  {
    id: 'landscaping', label: 'Landscaping', scopes: ['property', 'community'],
    defaultDescription: 'Complete the landscaping scope for this visit — leave the property clean, edged, and blown off with all debris removed.',
    subtypes: [
      { id: 'cut', label: 'Grass Cut', defaultRate: 45, description: 'Mow all turf areas, edge walkways and beds, and blow off all hard surfaces. Remove all clippings and debris and leave the property clean.' },
      { id: 'flowers', label: 'Flowers', description: 'Install/refresh seasonal annuals in the designated beds, water in, and remove all spent material and debris.' },
      { id: 'tree_trimming', label: 'Tree Trimming', description: 'Trim trees and shrubs to shape and clearance, remove deadwood, and haul off all cuttings and debris.' },
      { id: 'mulch_pine_straw', label: 'Mulch / Pine Straw', description: 'Refresh mulch/pine straw to an even depth across all beds; edge as needed and remove any debris.' },
    ],
  },
  {
    id: 'cleaning', label: 'Cleaning', scopes: ['property', 'community'],
    defaultDescription: 'Full clean per the subtype standard — floors, surfaces, kitchen, baths, and fixtures; remove all debris and leave show-ready.',
    subtypes: [
      { id: 'common_area', label: 'Common Area', defaultRate: 125, description: 'Clean all shared common areas — floors, surfaces, glass, and fixtures; empty trash and leave the space presentable.' },
      { id: 'model_home', label: 'Model Home', defaultRate: 100, description: 'Detail-clean the model home to show-ready standard — floors, surfaces, kitchen, baths, glass, and fixtures.' },
      { id: 'move_in_clean', label: 'Move-In Clean', defaultRate: 75, description: 'Full move-in clean — floors, surfaces, kitchen, baths, and fixtures; ready the home for a new resident.' },
      { id: 'vacant_clean', label: 'Vacant Clean', defaultRate: 75, description: 'Clean the vacant home throughout — floors, surfaces, kitchen, baths, and fixtures; remove all debris.' },
      { id: 'one_time_clean', label: 'One-Time Clean', defaultRate: 75, description: 'One-time full clean — floors, surfaces, kitchen, baths, and fixtures; leave the home show-ready.' },
      { id: 'on_market_clean', label: 'On-Market Clean', defaultRate: 75, description: 'Clean the home to on-market/show-ready standard — floors, surfaces, kitchen, baths, glass, and fixtures.' },
    ],
  },
  {
    id: 'pools', label: 'Pools', scopes: ['property', 'community'],
    defaultDescription: 'Skim, brush, and vacuum as needed; empty baskets; test and balance chemicals; confirm equipment is running properly.',
    subtypes: [{ id: 'pool_cleaning', label: 'Pool Cleaning', defaultRate: 100, description: 'Skim, brush, and vacuum as needed; empty skimmer/pump baskets; test and balance chemicals; confirm equipment is running properly.' }],
  },
  {
    id: 'trash_removal', label: 'Trash Removal', scopes: ['property', 'community'],
    defaultDescription: 'Remove and dispose of trash/debris and return bins/area to a clean state.',
    subtypes: [{ id: 'trash_pickup', label: 'Trash Pickup', description: 'Remove and dispose of trash/debris and return bins and the surrounding area to a clean state.' }],
  },
  {
    id: 'trip_fee', label: 'Trip Fee', scopes: ['property', 'community'],
    defaultDescription: 'Trip fee for a dispatched visit.',
    subtypes: [{ id: 'base_trip_fee', label: 'Base Trip Fee', defaultRate: 35, description: 'Trip fee for a dispatched visit.' }],
  },
];

export const worktypeLabel = (id: string): string => WORKTYPES.find((w) => w.id === id)?.label || id;
export const worktypeDescription = (id: string): string => WORKTYPES.find((w) => w.id === id)?.defaultDescription || '';
/** Default scope-of-work language for a worktype+subtype: the subtype's own text when set, else the worktype default. */
export const descriptionFor = (worktype: string, subtype: string): string =>
  subtypesFor(worktype).find((s) => s.id === subtype)?.description || worktypeDescription(worktype);
export const subtypesFor = (worktype: string): Subtype[] => WORKTYPES.find((w) => w.id === worktype)?.subtypes || [];
// Bid items (vendor-requested additional work) carry a universal 'bid_item'
// subtype under the original service's work type.
export const BID_SUBTYPE = 'bid_item';
export const subtypeLabel = (worktype: string, subtype: string): string =>
  subtype === BID_SUBTYPE ? 'Bid Item' : (subtypesFor(worktype).find((s) => s.id === subtype)?.label || subtype);
export const defaultRateFor = (worktype: string, subtype: string): number | undefined =>
  subtypesFor(worktype).find((s) => s.id === subtype)?.defaultRate;
