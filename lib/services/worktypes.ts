/**
 * ResiWalk - Services — canonical worktype taxonomy.
 *
 * One source of truth for the worktypes the rules engine, Services records, and
 * (future) HubSpot enum options all share. `scopes` says whether a worktype can be
 * dispatched per-property (SFR), per-community (contract), or both.
 * `defaultDescription` is the starting scope-of-work language shown when a worktype
 * is picked; it's editable per rule in the Rules Engine (Step 1).
 *
 * (Step 1 pulls this forward from the Step-2 "taxonomy" work because the rules-
 * engine + list + new-service UI need the labels/descriptions now.)
 */

export type ServiceScope = 'property' | 'community';
export type Worktype = 'grass_cut' | 'pool_service' | 'house_cleaning';

export interface WorktypeDef {
  id: Worktype;
  label: string;
  scopes: ServiceScope[];
  defaultDescription: string;
}

export const WORKTYPES: WorktypeDef[] = [
  {
    id: 'grass_cut', label: 'Grass Cut', scopes: ['property', 'community'],
    defaultDescription: 'Mow all turf areas, edge along walks, beds, and driveway, and blow off all hard surfaces. Bag or mulch clippings and leave the yard clean.',
  },
  {
    id: 'pool_service', label: 'Pool Service', scopes: ['property', 'community'],
    defaultDescription: 'Skim the surface, brush walls and steps, vacuum as needed, empty baskets, test and balance chemicals, and confirm equipment is running properly.',
  },
  {
    id: 'house_cleaning', label: 'House Cleaning', scopes: ['property', 'community'],
    defaultDescription: 'Full make-ready clean: floors, surfaces, kitchen, bathrooms, fixtures, and window sills. Remove all debris and leave the home show-ready.',
  },
];

export const worktypeLabel = (id: string): string =>
  WORKTYPES.find((w) => w.id === id)?.label || id;
export const worktypeDescription = (id: string): string =>
  WORKTYPES.find((w) => w.id === id)?.defaultDescription || '';
