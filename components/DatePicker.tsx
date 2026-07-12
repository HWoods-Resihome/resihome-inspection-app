import { useState } from 'react';

/**
 * Branded in-app date picker — a drop-in replacement for <input type="date">.
 * The trigger matches the app's other themed controls (like ListPicker replaced
 * the grey native selects); tapping it opens a centered calendar modal in the
 * brand theme instead of the phone's default date UI. Value is a 'YYYY-MM-DD'
 * string (same contract as the native input); onChange emits the same, or '' when
 * cleared.
 */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const pad = (n: number) => String(n).padStart(2, '0');
const toYMD = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYMD = (s?: string): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};
const fmtMDY = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${Number(m[2])}-${Number(m[3])}-${m[1].slice(2)}` : s;
};
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function DatePicker({ value, onChange, className, placeholder = 'Select date', min, clearable = true, ariaLabel }: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
  placeholder?: string;
  min?: string;             // 'YYYY-MM-DD' — earliest selectable day
  clearable?: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<Date>(() => parseYMD(value) || new Date());
  const selected = parseYMD(value);
  const minD = parseYMD(min);
  const today = new Date();
  const base = className ??
    'w-full text-sm border border-gray-300 rounded-lg px-3 py-2.5 bg-white text-ink focus:outline-none focus:border-brand flex items-center justify-between';

  const openIt = () => { setView(parseYMD(value) || new Date()); setOpen(true); };
  const y = view.getFullYear(), mo = view.getMonth();
  const first = new Date(y, mo, 1);
  const gridStart = new Date(y, mo, 1 - first.getDay());
  const daysInMonth = new Date(y, mo + 1, 0).getDate();
  const weeks = Math.ceil((first.getDay() + daysInMonth) / 7);
  const cells = Array.from({ length: weeks * 7 }, (_, i) => { const d = new Date(gridStart); d.setDate(gridStart.getDate() + i); return d; });
  const disabled = (d: Date) => (minD ? d < new Date(minD.getFullYear(), minD.getMonth(), minD.getDate()) : false);
  const pick = (d: Date) => { if (disabled(d)) return; onChange(toYMD(d)); setOpen(false); };

  return (
    <>
      <button type="button" onClick={openIt} aria-label={ariaLabel} className={base}>
        <span className={value ? '' : 'opacity-50'}>{value ? fmtMDY(value) : placeholder}</span>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-gray-400"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
      </button>
      {open && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setOpen(false)}>
          <div className="bg-white w-full max-w-xs rounded-2xl overflow-hidden shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-3 py-2.5 border-b border-gray-100">
              <button type="button" aria-label="Previous month" onClick={() => setView(new Date(y, mo - 1, 1))} className="w-8 h-8 grid place-items-center rounded-lg text-gray-600 hover:text-brand hover:bg-brand/5">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
              </button>
              <div className="font-heading font-extrabold text-ink text-sm">{MONTHS[mo]} {y}</div>
              <button type="button" aria-label="Next month" onClick={() => setView(new Date(y, mo + 1, 1))} className="w-8 h-8 grid place-items-center rounded-lg text-gray-600 hover:text-brand hover:bg-brand/5">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
              </button>
            </div>
            <div className="px-3 py-2">
              <div className="grid grid-cols-7 text-center text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">
                {DOW.map((d) => <div key={d} className="py-1">{d}</div>)}
              </div>
              <div className="grid grid-cols-7 gap-0.5">
                {cells.map((d, i) => {
                  const inMonth = d.getMonth() === mo;
                  const sel = !!selected && sameDay(d, selected);
                  const dis = disabled(d);
                  const isToday = sameDay(d, today);
                  return (
                    <button key={i} type="button" disabled={dis} onClick={() => pick(d)}
                      className={`aspect-square rounded-lg text-[13px] font-semibold grid place-items-center transition-colors ${
                        sel ? 'bg-brand text-white'
                          : dis ? 'text-gray-300 cursor-not-allowed'
                          : inMonth ? 'text-ink hover:bg-brand/10' : 'text-gray-300 hover:bg-gray-50'} ${isToday && !sel ? 'ring-1 ring-brand/40' : ''}`}>
                      {d.getDate()}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex items-center justify-between px-3 py-2.5 border-t border-gray-100">
              {clearable
                ? <button type="button" onClick={() => { onChange(''); setOpen(false); }} className="text-[12px] font-heading font-semibold text-gray-500 hover:text-brand">Clear</button>
                : <span />}
              <button type="button" onClick={() => { if (!disabled(today)) pick(today); }} className="text-[12px] font-heading font-semibold text-brand disabled:opacity-40" disabled={disabled(today)}>Today</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
