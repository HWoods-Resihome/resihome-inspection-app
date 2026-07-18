/**
 * Shared card chrome for the Insights dashboard (dark theme, fixed grid — no
 * drag). A titled frame: icon + 13px Raleway title, optional subtitle, optional
 * header-right control. Card bg #18181c, hairline white/10 borders, 12px radius.
 *
 * Brand pink (#ff0060) is reserved for KPI emphasis / links, so titles stay
 * primary-text colored here.
 */
import { type ReactNode } from 'react';
import { useCardSlotCollapse } from './cardHost';

export function CardFrame({
  title, subtitle, icon, children, headerRight, bodyClassName,
}: {
  title: string;
  subtitle?: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  headerRight?: ReactNode;
  /** Override the body wrapper (e.g. scroll height, padding) when needed. */
  bodyClassName?: string;
}) {
  // When rendered inside a <CardSlot>, expose a collapse/expand chevron (top-right)
  // that hides just this card's body — the header stays so it's never lost.
  const slot = useCardSlotCollapse();
  const collapsed = slot?.collapsed ?? false;
  return (
    <div className="bg-[#18181c] rounded-xl border border-white/10 flex flex-col overflow-hidden">
      <div className={`flex items-center gap-2 px-4 py-3 ${collapsed ? '' : 'border-b border-white/10'}`}>
        {icon && <span className="text-[#71717a] shrink-0">{icon}</span>}
        <div className="flex-1 min-w-0">
          <h3 className="font-heading font-semibold text-[13px] text-[#f4f4f5] truncate leading-tight">{title}</h3>
          {subtitle != null && !collapsed && <div className="text-[11px] text-[#71717a] truncate mt-0.5">{subtitle}</div>}
        </div>
        {headerRight && !collapsed && <div className="shrink-0">{headerRight}</div>}
        {slot && (
          <button
            type="button" onClick={slot.toggle}
            title={collapsed ? 'Expand card' : 'Collapse card'} aria-label={collapsed ? 'Expand card' : 'Collapse card'}
            aria-expanded={!collapsed}
            className="shrink-0 text-[#71717a] hover:text-[#ff0060] transition-colors -mr-1 p-1"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${collapsed ? '-rotate-90' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>
          </button>
        )}
      </div>
      {!collapsed && <div className={bodyClassName ?? 'p-4'}>{children}</div>}
    </div>
  );
}

/** Small empty/placeholder note used when a card has nothing honest to show. */
export function CardNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-center text-center text-sm text-[#71717a] px-4 py-8">
      {children}
    </div>
  );
}
