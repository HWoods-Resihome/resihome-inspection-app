import { useState } from 'react';

/**
 * Compact multi-select used in the Services home, both calendars, and the Rules
 * Engine filter rows + editor. Shows a short label (with a count when active) and,
 * when tapped, opens a CENTERED modal with a scrollable checkbox list — so a long
 * option list (e.g. property-status values) never rolls off the edge of the screen
 * the way an anchored dropdown did. Selecting nothing means "no filter" (all).
 */
export function MultiFilter({ label, options, selected, onChange, className }: {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const active = selected.length > 0;
  const toggle = (v: string) => onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  const summary = active ? `${label} (${selected.length})` : label;
  const base = className ??
    `w-full truncate text-[11px] font-heading font-semibold pl-2 pr-1 py-1.5 border rounded-md bg-white flex items-center justify-between ${active ? 'border-brand text-brand' : 'border-gray-300 text-gray-700 hover:border-brand/50'}`;

  // Search only when the list is long enough to warrant it.
  const searchable = options.length > 8;
  const shown = q.trim() ? options.filter((o) => o.label.toLowerCase().includes(q.trim().toLowerCase())) : options;

  return (
    <div className="w-full">
      <button type="button" onClick={() => { setQ(''); setOpen(true); }} aria-expanded={open} className={base}>
        <span className="truncate">{summary}</span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {open && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setOpen(false)}>
          <div className="bg-white w-full max-w-sm rounded-2xl max-h-[75vh] flex flex-col overflow-hidden shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 shrink-0">
              <div className="font-heading font-bold text-[15px] text-ink">{label}{active ? ` · ${selected.length}` : ''}</div>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="text-gray-400 hover:text-ink text-lg leading-none">✕</button>
            </div>
            {searchable && (
              <div className="px-3 pt-2.5 shrink-0">
                <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${label.toLowerCase()}…`} autoFocus
                  className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:border-brand" />
              </div>
            )}
            <div className="overflow-y-auto py-1 flex-1">
              {shown.map((o) => {
                const on = selected.includes(o.value);
                return (
                  <button key={o.value} type="button" onClick={() => toggle(o.value)}
                    className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm font-semibold text-left hover:bg-gray-50">
                    <span className={`w-5 h-5 rounded-md border-2 flex items-center justify-center text-[11px] font-bold shrink-0 ${on ? 'bg-brand border-brand text-white' : 'border-gray-300'}`}>{on ? '✓' : ''}</span>
                    <span className="text-ink">{o.label}</span>
                  </button>
                );
              })}
              {shown.length === 0 && <div className="px-4 py-6 text-center text-[13px] text-gray-400">{options.length === 0 ? 'No options' : 'No matches'}</div>}
            </div>
            <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-gray-100 shrink-0">
              <button type="button" onClick={() => onChange([])} disabled={!active} className="text-[13px] font-heading font-semibold text-gray-500 hover:text-brand disabled:opacity-40">Clear</button>
              <button type="button" onClick={() => setOpen(false)} className="rounded-xl px-6 py-2 text-sm font-heading font-bold bg-brand text-white">Done</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
