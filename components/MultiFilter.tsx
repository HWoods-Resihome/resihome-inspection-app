import { useState } from 'react';

/**
 * Compact multi-select filter dropdown used in the Services home and Rules
 * Engine filter rows. Shows a short label (with a count when active) and a
 * checkbox list; selecting nothing means "no filter" (all).
 */
export function MultiFilter({ label, options, selected, onChange, className }: {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const active = selected.length > 0;
  const toggle = (v: string) => onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  const summary = active ? `${label} (${selected.length})` : label;
  const base = className ??
    `w-full truncate text-[11px] font-heading font-semibold pl-2 pr-1 py-1.5 border rounded-md bg-white flex items-center justify-between ${active ? 'border-brand text-brand' : 'border-gray-300 text-gray-700 hover:border-brand/50'}`;
  return (
    <div className="relative w-full">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={base}>
        <span className="truncate">{summary}</span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {open && (<>
        <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
        <div className="absolute left-0 z-40 mt-1 min-w-[9rem] max-w-[70vw] bg-white border border-gray-200 rounded-lg shadow-lg py-1 max-h-60 overflow-y-auto">
          {options.map((o) => {
            const on = selected.includes(o.value);
            return (
              <button key={o.value} type="button" onClick={() => toggle(o.value)}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold text-left hover:bg-gray-50">
                <span className={`w-4 h-4 rounded border flex items-center justify-center text-[10px] font-bold shrink-0 ${on ? 'bg-brand border-brand text-white' : 'border-gray-300'}`}>{on ? '✓' : ''}</span>
                <span className="flex-1 truncate text-ink">{o.label}</span>
              </button>
            );
          })}
          {options.length === 0 && <div className="px-3 py-3 text-center text-[11px] text-gray-400">No options</div>}
        </div>
      </>)}
    </div>
  );
}
