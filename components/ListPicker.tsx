import { useEffect, useRef, useState } from 'react';

export interface ListOption {
  value: string;
  label: string;
}

interface Props {
  value: string;
  options: ListOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;       // sheet title
  placeholder?: string;     // trigger text when nothing is selected
  disabled?: boolean;
  className?: string;       // trigger button classes
}

/**
 * A branded selector that opens a centered pop-up with a scrollable, tappable
 * list — tapping a row selects it and closes immediately (no Done). The pop-up
 * auto-sizes to its contents up to a cap, so a short list doesn't leave wasted
 * white space. Used for Category / Sub-category, where a tap-to-pick list reads
 * better than a spin wheel.
 */
export function ListPicker({ value, options, onChange, ariaLabel, placeholder, disabled, className }: Props) {
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
        <span className="truncate">{selected?.label ?? placeholder ?? value}</span>
        <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" className="ml-2 shrink-0 text-brand">
          <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" clipRule="evenodd" />
        </svg>
      </button>
      {open && (
        <ListSheet
          options={options}
          value={value}
          ariaLabel={ariaLabel}
          onClose={() => setOpen(false)}
          onPick={(v) => { setOpen(false); onChange(v); }}
        />
      )}
    </>
  );
}

function ListSheet({
  options, value, ariaLabel, onClose, onPick,
}: {
  options: ListOption[];
  value: string;
  ariaLabel?: string;
  onClose: () => void;
  onPick: (value: string) => void;
}) {
  const selectedRef = useRef<HTMLButtonElement>(null);
  // Bring the current selection into view when the list opens.
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'center' });
  }, []);

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        className="relative w-72 max-w-[88vw] max-h-[70vh] bg-white rounded-2xl shadow-xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-gray-100 shrink-0">
          <span className="text-sm font-heading font-semibold text-ink">{ariaLabel}</span>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none w-7 h-7 flex items-center justify-center" aria-label="Close">×</button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto py-1">
          {options.map((o) => {
            const isSel = o.value === value;
            return (
              <button
                key={o.value}
                ref={isSel ? selectedRef : undefined}
                type="button"
                onClick={() => onPick(o.value)}
                className={`w-full text-left px-4 py-3 text-base flex items-center justify-between gap-2 ${isSel ? 'bg-brand/5 text-ink font-semibold' : 'text-ink hover:bg-gray-50'}`}
              >
                <span className="truncate">{o.label}</span>
                {isSel && (
                  <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" className="shrink-0 text-brand">
                    <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0l-3.5-3.5a1 1 0 011.4-1.4l2.8 2.79 6.8-6.79a1 1 0 011.4 0z" clipRule="evenodd" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
