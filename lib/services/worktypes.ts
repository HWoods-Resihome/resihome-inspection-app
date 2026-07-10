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

export interface Subtype { id: string; label: string; defaultRate?: number; }
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
      { id: 'cut', label: 'Grass Cut', defaultRate: 45 },
      { id: 'flowers', label: 'Flowers' },
      { id: 'tree_trimming', label: 'Tree Trimming' },
      { id: 'mulch_pine_straw', label: 'Mulch / Pine Straw' },
    ],
  },
  {
    id: 'cleaning', label: 'Cleaning', scopes: ['property', 'community'],
    defaultDescription: 'Full clean per the subtype standard — floors, surfaces, kitchen, baths, and fixtures; remove all debris and leave show-ready.',
    subtypes: [
      { id: 'common_area', label: 'Common Area', defaultRate: 125 },
      { id: 'model_home', label: 'Model Home', defaultRate: 100 },
      { id: 'move_in_clean', label: 'Move-In Clean', defaultRate: 75 },
      { id: 'vacant_clean', label: 'Vacant Clean', defaultRate: 75 },
      { id: 'one_time_clean', label: 'One-Time Clean', defaultRate: 75 },
      { id: 'on_market_clean', label: 'On-Market Clean', defaultRate: 75 },
    ],
  },
  {
    id: 'pools', label: 'Pools', scopes: ['property', 'community'],
    defaultDescription: 'Skim, brush, and vacuum as needed; empty baskets; test and balance chemicals; confirm equipment is running properly.',
    subtypes: [{ id: 'pool_cleaning', label: 'Pool Cleaning', defaultRate: 100 }],
  },
  {
    id: 'trash_removal', label: 'Trash Removal', scopes: ['property', 'community'],
    defaultDescription: 'Remove and dispose of trash/debris and return bins/area to a clean state.',
    subtypes: [{ id: 'trash_pickup', label: 'Trash Pickup' }],
  },
  {
    id: 'trip_fee', label: 'Trip Fee', scopes: ['property', 'community'],
    defaultDescription: 'Trip fee for a dispatched visit.',
    subtypes: [{ id: 'base_trip_fee', label: 'Base Trip Fee' }],
  },
];

export const worktypeLabel = (id: string): string => WORKTYPES.find((w) => w.id === id)?.label || id;
export const worktypeDescription = (id: string): string => WORKTYPES.find((w) => w.id === id)?.defaultDescription || '';
export const subtypesFor = (worktype: string): Subtype[] => WORKTYPES.find((w) => w.id === worktype)?.subtypes || [];
export const subtypeLabel = (worktype: string, subtype: string): string =>
  subtypesFor(worktype).find((s) => s.id === subtype)?.label || subtype;
export const defaultRateFor = (worktype: string, subtype: string): number | undefined =>
  subtypesFor(worktype).find((s) => s.id === subtype)?.defaultRate;
