/**
 * ResiWalk - Services — canonical worktype taxonomy.
 *
 * One source of truth for the worktypes the rules engine, Services records, and
 * (future) HubSpot enum options all share. `scopes` says whether a worktype can be
 * dispatched per-property (SFR), per-community (contract), or both — some (pet
 * station, trash pickup) are community-only. Keep this list in lockstep with the
 * HubSpot enum once the Services object exists (Step 3).
 *
 * (Step 1 pulls this forward from the Step-2 "taxonomy" work because the rules-
 * engine + list UI need the labels now.)
 */

export type ServiceScope = 'property' | 'community';
export type Worktype =
  | 'grass_cut'
  | 'pool_service'
  | 'house_cleaning'
  | 'pet_station'
  | 'trash_pickup'
  | 'model_clean';

export interface WorktypeDef {
  id: Worktype;
  label: string;
  scopes: ServiceScope[];
}

export const WORKTYPES: WorktypeDef[] = [
  { id: 'grass_cut',      label: 'Grass Cut',      scopes: ['property', 'community'] },
  { id: 'pool_service',   label: 'Pool Service',   scopes: ['property', 'community'] },
  { id: 'house_cleaning', label: 'House Cleaning', scopes: ['property', 'community'] },
  { id: 'model_clean',    label: 'Model Clean',    scopes: ['community'] },
  { id: 'pet_station',    label: 'Pet Station',    scopes: ['community'] },
  { id: 'trash_pickup',   label: 'Trash Pickup',   scopes: ['community'] },
];

export const worktypeLabel = (id: string): string =>
  WORKTYPES.find((w) => w.id === id)?.label || id;
