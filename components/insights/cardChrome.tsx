/**
 * Shared card chrome for the Insights dashboard: a titled, draggable frame with
 * an icon and a "..." menu (Remove). The drag handle is the header (class
 * `insights-card-drag`); react-grid-layout is told to use that selector so the
 * card body (charts, tables, menus) stays interactive.
 *
 * Brand: titles use font-heading (Raleway); pink (#ff0060) is reserved for KPI
 * emphasis, so card titles stay ink-colored here.
 */
import { useState, type ReactNode } from 'react';

/** Selector react-grid-layout uses for its drag handle (see Dashboard). */
export const DRAG_HANDLE_CLASS = 'insights-card-drag';

export function CardFrame({
  title, icon, onRemove, children, headerRight,
}: {
  title: string;
  icon?: ReactNode;
  onRemove?: () => void;
  children: ReactNode;
  headerRight?: ReactNode;
}) {
  const [menu, setMenu] = useState(false);
  return (
    <div className="h-full w-full bg-white rounded-2xl border border-gray-200 shadow-sm flex flex-col overflow-hidden">
      <div className={`${DRAG_HANDLE_CLASS} flex items-center gap-2 px-4 py-2.5 border-b border-gray-100 cursor-move select-none`}>
        {icon && <span className="text-gray-400 shrink-0">{icon}</span>}
        <h3 className="font-heading font-bold text-sm text-ink truncate flex-1 min-w-0">{title}</h3>
        {/* headerRight (toggles etc.) — stop drag so the controls are clickable. */}
        {headerRight && (
          <div className="shrink-0" onMouseDown={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()}>
            {headerRight}
          </div>
        )}
        {onRemove && (
          <div className="relative shrink-0" onMouseDown={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()}>
            <button
              type="button"
              aria-label="Card menu"
              onClick={() => setMenu((o) => !o)}
              className="text-gray-400 hover:text-ink rounded p-1 leading-none"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
            </button>
            {menu && (
              <>
                <button type="button" aria-hidden tabIndex={-1} className="fixed inset-0 z-40 cursor-default" onClick={() => setMenu(false)} />
                <div role="menu" className="absolute right-0 top-full mt-1 z-50 w-36 bg-white rounded-lg border border-gray-200 shadow-lg overflow-hidden">
                  <button
                    type="button" role="menuitem"
                    onClick={() => { setMenu(false); onRemove(); }}
                    className="w-full text-left px-3 py-2 text-sm font-heading font-semibold text-gray-700 hover:bg-gray-50"
                  >
                    Remove
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-4">{children}</div>
    </div>
  );
}

/** Small empty/placeholder note used when a card has nothing honest to show. */
export function CardNote({ children }: { children: ReactNode }) {
  return (
    <div className="h-full flex items-center justify-center text-center text-sm text-gray-400 px-4">
      {children}
    </div>
  );
}
