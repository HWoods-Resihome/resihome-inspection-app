/**
 * Card collapse/expand plumbing for the Insights dashboard.
 *
 * Goal: let any CardFrame-based card be collapsed IN PLACE (header stays, body
 * hides) and expanded again — WITHOUT prop-drilling a callback through every card
 * component. We use two contexts:
 *   - HostContext: the dashboard-level api ({ collapsed, toggle }).
 *   - SlotContext: the CURRENT card's collapse state + toggle, from <CardSlot>.
 * CardFrame reads SlotContext and renders its own collapse chevron when present.
 *
 * The grid/sizing structure is untouched: a collapsed card keeps its header row
 * (so it's never lost from view) and simply drops its body; the row reflows via
 * the existing auto-fit columns.
 */
import { createContext, useContext, type ReactNode } from 'react';

export interface CardHostApi {
  collapsed: Set<string>;
  toggle: (id: string) => void;
}

const HostContext = createContext<CardHostApi | null>(null);
const SlotContext = createContext<{ collapsed: boolean; toggle: () => void } | null>(null);

/** Read the current card's collapse state + toggle (CardFrame uses this for its
 *  header chevron). */
export function useCardSlotCollapse() { return useContext(SlotContext); }

export function CardHost({ value, children }: { value: CardHostApi; children: ReactNode }) {
  return <HostContext.Provider value={value}>{children}</HostContext.Provider>;
}

/** Wrap a card with an id so it can be collapsed. Always renders (the card's own
 *  header stays visible); CardFrame hides just the body when collapsed. */
export function CardSlot({ id, children }: { id: string; children: ReactNode }) {
  const host = useContext(HostContext);
  const slot = host ? { collapsed: host.collapsed.has(id), toggle: () => host.toggle(id) } : null;
  return <SlotContext.Provider value={slot}>{children}</SlotContext.Provider>;
}

/** Static catalog of minimizable cards (id → title) for the restore dropdown.
 *  Ids must match the <CardSlot id> used in the dashboard. */
export const CARD_CATALOG: { id: string; title: string }[] = [
  { id: 'passfail', title: 'Pass / Fail' },
  { id: 'roster', title: 'Inspector Performance' },
  { id: 'grass', title: '1099 Grass Condition Fails' },
  { id: 'scope-cost', title: 'Scope Cost' },
  { id: 'scope-approvals', title: 'Scope Approvals' },
  { id: 'ratecard-lines', title: 'Most-Used Rate Card Line Items' },
  { id: 'trend', title: 'Completion-Time Trend' },
  { id: 'overrides-ai', title: 'AI Overrides' },
];
