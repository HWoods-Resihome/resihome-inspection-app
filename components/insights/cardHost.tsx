/**
 * Card minimize/restore plumbing for the Insights dashboard.
 *
 * Goal: let any CardFrame-based card be minimized (hidden) from the canvas and
 * restored from a dropdown — WITHOUT prop-drilling a callback through every card
 * component. We use two contexts:
 *   - HostContext: the dashboard-level api ({ hidden, minimize }).
 *   - SlotContext: the CURRENT card's minimize handler, provided by <CardSlot>.
 * CardFrame reads SlotContext and renders its own minimize button when present.
 *
 * The grid/sizing structure is untouched: a minimized card simply renders null
 * in place (its row reflows via the existing auto-fit columns); restoring snaps
 * it back exactly where it was declared.
 */
import { createContext, useContext, type ReactNode } from 'react';

export interface CardHostApi {
  hidden: Set<string>;
  minimize: (id: string) => void;
}

const HostContext = createContext<CardHostApi | null>(null);
const SlotContext = createContext<{ minimize: () => void } | null>(null);

/** Read the current card's minimize handler (CardFrame uses this for its button). */
export function useCardSlotMinimize() { return useContext(SlotContext); }

export function CardHost({ value, children }: { value: CardHostApi; children: ReactNode }) {
  return <HostContext.Provider value={value}>{children}</HostContext.Provider>;
}

/** Wrap a card with an id so it can be minimized. Renders null while hidden. */
export function CardSlot({ id, children }: { id: string; children: ReactNode }) {
  const host = useContext(HostContext);
  if (host && host.hidden.has(id)) return null;
  const slot = host ? { minimize: () => host.minimize(id) } : null;
  return <SlotContext.Provider value={slot}>{children}</SlotContext.Provider>;
}

/** Static catalog of minimizable cards (id → title) for the restore dropdown.
 *  Ids must match the <CardSlot id> used in the dashboard. */
export const CARD_CATALOG: { id: string; title: string }[] = [
  { id: 'passfail', title: 'Pass / fail by inspector' },
  { id: 'propstatus', title: 'Inspections by property status' },
  { id: 'roster', title: 'Inspector performance' },
  { id: 'grass', title: '1099 Grass Condition fails' },
  { id: 'completed', title: 'Completed inspections' },
  { id: 'scope-cost', title: 'Scope cost by inspector' },
  { id: 'scope-approvals', title: 'Scope approvals by reviewer' },
  { id: 'trend', title: 'Completion-time trend' },
  { id: 'gauges', title: 'Quality gauges' },
  { id: 'velocity', title: 'AI learning velocity' },
  { id: 'overrides', title: 'Inspector preference overrides' },
  { id: 'overrides-inspector', title: 'AI overrides by inspector' },
  { id: 'overrides-category', title: 'AI overrides by category' },
  { id: 'kb', title: 'AI Knowledge Base changes' },
];
