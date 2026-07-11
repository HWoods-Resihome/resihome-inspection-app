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
export function MultiFilter({ label, options, selected, onChange, className }: {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  const btnRef = useRef<HTMLButtonElement>(null);
  const active = selected.length > 0;
  const toggle = (v: string) => onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  const summary = active ? `${label} (${selected.length})` : label;
  const base = className ??
    `w-full truncate text-[11px] font-heading font-semibold pl-2 pr-1 py-1.5 border rounded-md bg-white flex items-center justify-between ${active ? 'border-brand text-brand' : 'border-gray-300 text-gray-700 hover:border-brand/50'}`;

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
