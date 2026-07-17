import { useRef, useState } from 'react';

/**
 * Compact multi-select filter dropdown used in the Services home, both calendars,
 * and the Rules Engine filter rows. Shows a short label (with a count when active)
 * and a checkbox list; selecting nothing means "no filter" (all).
 *
 * The menu is positioned with fixed coordinates measured from the trigger and
 * CLAMPED to the viewport, so it never runs off-screen on right-side filters.
 * Long option labels scroll horizontally inside the (viewport-capped) menu.
 */
export function MultiFilter({ label, options, selected, onChange, className, sheet }: {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
  className?: string;
  /** Render the options as a centered, scrollable modal (bottom sheet on mobile)
   *  instead of an anchored dropdown — for long lists on mid-page triggers that
   *  would otherwise run off-screen. */
  sheet?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  const btnRef = useRef<HTMLButtonElement>(null);
  const active = selected.length > 0;
  const toggle = (v: string) => onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  const summary = active ? `${label} (${selected.length})` : label;
  const base = className ??
    `w-full truncate text-[11px] font-heading font-semibold pl-2 pr-1 py-1.5 border rounded-md bg-white flex items-center justify-between ${active ? 'border-brand text-brand' : 'border-gray-300 text-gray-700 hover:border-brand/50'}`;

  if (sheet) {
    return (
      <div className="relative w-full">
        <button ref={btnRef} type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={base}>
          <span className="truncate">{summary}</span>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>
        </button>
        {open && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setOpen(false)}>
            <div className="bg-white w-full sm:max-w-sm sm:rounded-2xl rounded-t-2xl p-3 flex flex-col max-h-[80vh]" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between px-1 pb-2 shrink-0 border-b border-gray-100">
                <span className="font-heading font-bold text-[14px] text-ink">{label}{active ? ` · ${selected.length}` : ''}</span>
                <button type="button" onClick={() => setOpen(false)} className="text-sm text-brand font-heading font-semibold px-2 py-1">Done</button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto py-1">
                {options.map((o) => {
                  const on = selected.includes(o.value);
                  return (
                    <button key={o.value} type="button" onClick={() => toggle(o.value)}
                      className="w-full flex items-center gap-2.5 px-2 py-2.5 text-sm font-semibold text-left hover:bg-gray-50 rounded-lg">
                      <span className={`w-5 h-5 rounded border flex items-center justify-center text-[11px] font-bold shrink-0 ${on ? 'bg-brand border-brand text-white' : 'border-gray-300'}`}>{on ? '✓' : ''}</span>
                      <span className="text-ink">{o.label}</span>
                    </button>
                  );
                })}
                {options.length === 0 && <div className="px-3 py-4 text-center text-[13px] text-gray-400">No options</div>}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r && typeof window !== 'undefined') {
      const m = 8;                                   // viewport margin
      const width = Math.min(280, window.innerWidth - m * 2);
      let left = r.left;
      if (left + width > window.innerWidth - m) left = window.innerWidth - m - width;
      if (left < m) left = m;
      setMenuStyle({ position: 'fixed', top: Math.round(r.bottom + 4), left: Math.round(left), width, maxHeight: '60vh' });
    }
    setOpen(true);
  };

  return (
    <div className="relative w-full">
      <button ref={btnRef} type="button" onClick={() => (open ? setOpen(false) : openMenu())} aria-expanded={open} className={base}>
        <span className="truncate">{summary}</span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {open && (<>
        <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
        <div style={menuStyle} className="z-50 bg-white border border-gray-200 rounded-lg shadow-lg overflow-auto py-1">
          {options.map((o) => {
            const on = selected.includes(o.value);
            return (
              <button key={o.value} type="button" onClick={() => toggle(o.value)}
                className="w-max min-w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold text-left hover:bg-gray-50 whitespace-nowrap">
                <span className={`w-4 h-4 rounded border flex items-center justify-center text-[10px] font-bold shrink-0 ${on ? 'bg-brand border-brand text-white' : 'border-gray-300'}`}>{on ? '✓' : ''}</span>
                <span className="text-ink">{o.label}</span>
              </button>
            );
          })}
          {options.length === 0 && <div className="px-3 py-3 text-center text-[11px] text-gray-400">No options</div>}
        </div>
      </>)}
    </div>
  );
}
