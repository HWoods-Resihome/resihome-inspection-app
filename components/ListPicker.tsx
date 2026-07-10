import { useEffect, useRef, useState } from 'react';

export interface ListOption {
  value: string;
  label: string;
  sublabel?: string;   // optional second line (e.g. "City, ST ZIP" under a subdivision)
}

interface Props {
  value: string;
  options: ListOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;       // sheet title
  placeholder?: string;     // trigger text when nothing is selected
  disabled?: boolean;
  className?: string;       // trigger button classes
  large?: boolean;          // bigger, higher-contrast sheet (used on the AI camera)
  // ---- Multi-select (opt-in) ----
  // When `multiple` is set the sheet supports picking several values: a single
  // tap still filters by just that one, but pressing-and-holding a row enters
  // multi-select mode (checkboxes + Apply). The parent owns the array.
  multiple?: boolean;
  selectedValues?: string[];               // current multi selection
  onApply?: (values: string[]) => void;    // commit a multi selection
  triggerLabel?: string;                    // explicit trigger text (multi summary)
  allValue?: string;                        // option value meaning "clear/all" (default 'all')
}

/**
 * A branded selector that opens a centered pop-up with a scrollable, tappable
 * list. Single-select: tapping a row picks it and closes (no Done). Multi-select
 * (opt-in): press-and-hold a row to enter multi mode, tap to toggle several,
 * then Apply.
 */
export function ListPicker({
  value, options, onChange, ariaLabel, placeholder, disabled, className, large,
  multiple, selectedValues, onApply, triggerLabel, allValue = 'all',
}: Props) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        aria-label={ariaLabel}
        className={className || 'h-11 w-full bg-gray-100 rounded-lg px-3 text-base text-ink flex items-center justify-between disabled:opacity-60'}
      >
        <span className="truncate">{triggerLabel ?? selected?.label ?? placeholder ?? value}</span>
        <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor" className="ml-1 shrink-0 text-brand">
          <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" clipRule="evenodd" />
        </svg>
      </button>
      {open && (
        <ListSheet
          options={options}
          value={value}
          ariaLabel={ariaLabel}
          large={!!large}
          multiple={!!multiple}
          selectedValues={selectedValues || []}
          allValue={allValue}
          onClose={() => setOpen(false)}
          onPick={(v) => { setOpen(false); onChange(v); }}
          onApply={(vals) => { setOpen(false); onApply?.(vals); }}
        />
      )}
    </>
  );
}

function ListSheet({
  options, value, ariaLabel, large, multiple, selectedValues, allValue, onClose, onPick, onApply,
}: {
  options: ListOption[];
  value: string;
  ariaLabel?: string;
  large?: boolean;
  multiple: boolean;
  selectedValues: string[];
  allValue: string;
  onClose: () => void;
  onPick: (value: string) => void;
  onApply: (values: string[]) => void;
}) {
  const selectedRef = useRef<HTMLButtonElement>(null);
  // The row the user just tapped — held briefly so the pink selection band is
  // visible before the sheet closes (single-select only).
  const [picked, setPicked] = useState<string | null>(null);
  // Multi-select mode (entered by long-press) + the working selection set.
  const [multiActive, setMultiActive] = useState(false);
  const [sel, setSel] = useState<Set<string>>(() => new Set(selectedValues));
  // Long-press plumbing: a timer that, if it survives the press, flips into
  // multi mode; a flag so the click that follows a long-press is ignored.
  const pressTimer = useRef<number | null>(null);
  const longFired = useRef(false);

  // Bring the current selection into view when the list opens.
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'center' });
  }, []);
  useEffect(() => () => { if (pressTimer.current) window.clearTimeout(pressTimer.current); }, []);

  const choose = (v: string) => {
    setPicked(v);
    window.setTimeout(() => onPick(v), 160);
  };

  const startPress = (v: string) => {
    if (!multiple || v === allValue) return; // "All" and single pickers don't long-press
    longFired.current = false;
    pressTimer.current = window.setTimeout(() => {
      longFired.current = true;
      setMultiActive(true);
      setSel((cur) => new Set(cur).add(v));
    }, 450);
  };
  const cancelPress = () => {
    if (pressTimer.current) { window.clearTimeout(pressTimer.current); pressTimer.current = null; }
  };

  const onRowClick = (v: string) => {
    if (longFired.current) { longFired.current = false; return; } // the press already acted
    if (v === allValue) { multiple ? onApply([]) : onPick(v); return; } // "All" clears
    if (multiple && multiActive) {
      setSel((cur) => {
        const next = new Set(cur);
        if (next.has(v)) next.delete(v); else next.add(v);
        return next;
      });
      return;
    }
    if (multiple) onApply([v]); else choose(v);
  };

  const isChosen = (v: string): boolean => {
    if (multiActive) return sel.has(v);
    if (multiple) return v !== allValue ? selectedValues.includes(v) : selectedValues.length === 0;
    return v === value;
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        className={`relative ${large ? 'w-80 max-w-[92vw] max-h-[82vh]' : 'w-72 max-w-[88vw] max-h-[70vh]'} bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden select-none`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-gray-100 shrink-0">
          <span className="font-heading font-semibold text-ink text-sm">{ariaLabel}</span>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none w-7 h-7 flex items-center justify-center" aria-label="Close">×</button>
        </div>
        {multiple && (
          <div className="px-3 py-1.5 text-[11px] text-gray-400 border-b border-gray-50 shrink-0">
            {multiActive ? 'Tap to add or remove · Apply when done' : 'Tap to filter by one · press & hold to pick several'}
          </div>
        )}
        <div className="flex-1 min-h-0 overflow-y-auto py-1">
          {options.map((o) => {
            const isActive = picked != null ? picked === o.value : isChosen(o.value);
            const showCheckbox = multiActive && o.value !== allValue;
            return (
              <button
                key={o.value}
                ref={o.value === value ? selectedRef : undefined}
                type="button"
                onClick={() => onRowClick(o.value)}
                onPointerDown={() => startPress(o.value)}
                onPointerUp={cancelPress}
                onPointerLeave={cancelPress}
                onPointerCancel={cancelPress}
                onContextMenu={(e) => e.preventDefault()}
                className={`w-full text-left flex items-center justify-between gap-2 transition-colors px-4 py-3 text-base ${
                  isActive
                    ? 'bg-brand/10 border-y-2 border-brand text-ink font-semibold'
                    : 'text-ink border-y-2 border-transparent hover:bg-gray-50 active:bg-brand/10'
                }`}
              >
                <span className="flex items-center gap-2.5 min-w-0">
                  {showCheckbox && (
                    <span className={`shrink-0 w-4 h-4 rounded border flex items-center justify-center ${isActive ? 'bg-brand border-brand' : 'border-gray-300'}`}>
                      {isActive && (
                        <svg width="12" height="12" viewBox="0 0 20 20" fill="white"><path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0l-3.5-3.5a1 1 0 011.4-1.4l2.8 2.79 6.8-6.79a1 1 0 011.4 0z" clipRule="evenodd" /></svg>
                      )}
                    </span>
                  )}
                  <span className="min-w-0 flex flex-col">
                    <span className="truncate">{o.label}</span>
                    {o.sublabel && <span className="truncate text-[12.5px] text-gray-500 font-normal leading-tight">{o.sublabel}</span>}
                  </span>
                </span>
                {isActive && !showCheckbox && (
                  <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" className="shrink-0 text-brand">
                    <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0l-3.5-3.5a1 1 0 011.4-1.4l2.8 2.79 6.8-6.79a1 1 0 011.4 0z" clipRule="evenodd" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
        {multiActive && (
          <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-t border-gray-100 shrink-0">
            <button type="button" onClick={() => onApply([])} className="text-xs font-heading font-semibold text-gray-500 hover:text-gray-700">Clear all</button>
            <button
              type="button"
              onClick={() => onApply(Array.from(sel))}
              className="text-sm font-heading font-semibold text-white bg-brand hover:bg-brand-dark rounded-lg px-4 py-1.5"
            >
              Apply{sel.size ? ` (${sel.size})` : ''}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
