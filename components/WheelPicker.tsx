import { useEffect, useRef, useState } from 'react';

export interface WheelOption {
  value: string;
  label: string;
}

interface Props {
  value: string;
  options: WheelOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;       // shown as the sheet title
  disabled?: boolean;
  className?: string;       // trigger button classes (defaults to a select-like field)
  large?: boolean;          // bigger, higher-contrast sheet (used on the AI camera)
}

const ITEM_H = 44;          // px per row (comfortable touch target)
const ITEM_H_LG = 60;       // larger touch target for the big (camera) variant

/**
 * A wheel/spinner selector (like the iOS picker). The closed state looks like a
 * normal field; tapping opens a bottom sheet where the user spins a vertical
 * list and the centered row is the selection — nicer than a long dropdown on
 * mobile. Confirm with Done (or tap a row); Cancel/backdrop discards.
 */
export function WheelPicker({ value, options, onChange, ariaLabel, disabled, className, large }: Props) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        aria-label={ariaLabel}
        className={className || 'h-11 w-full border border-gray-300 rounded-lg px-3 text-base bg-white flex items-center justify-between disabled:bg-gray-100'}
      >
        <span className="truncate">{selected?.label ?? value}</span>
        <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" className="ml-2 shrink-0 text-brand">
          <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" clipRule="evenodd" />
        </svg>
      </button>
      {open && (
        <WheelSheet
          options={options}
          value={value}
          ariaLabel={ariaLabel}
          large={!!large}
          onClose={() => setOpen(false)}
          onPick={(v) => { onChange(v); setOpen(false); }}
        />
      )}
    </>
  );
}

function WheelSheet({
  options, value, ariaLabel, large, onClose, onPick,
}: {
  options: WheelOption[];
  value: string;
  ariaLabel?: string;
  large?: boolean;
  onClose: () => void;
  onPick: (value: string) => void;
}) {
  const itemH = large ? ITEM_H_LG : ITEM_H;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pendingIdx, setPendingIdx] = useState(() => {
    const i = options.findIndex((o) => o.value === value);
    return i >= 0 ? i : 0;
  });
  // Size the wheel to a share of the viewport: pick an ODD number of visible rows
  // (so one is centered) that fills that height. The large variant fills more.
  const [rows, setRows] = useState(5);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let r = Math.round((window.innerHeight * (large ? 0.55 : 0.4)) / itemH);
    if (r % 2 === 0) r -= 1;             // keep it odd
    setRows(Math.max(5, Math.min(large ? 9 : 11, r)));
  }, [large, itemH]);
  const PAD = ((rows - 1) / 2) * itemH;
  const containerH = rows * itemH;
  const settleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Position the wheel on the current value when it opens (re-run if the row
  // count resolves after first paint).
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = pendingIdx * itemH;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const idx = Math.max(0, Math.min(options.length - 1, Math.round(el.scrollTop / itemH)));
    if (idx !== pendingIdx) setPendingIdx(idx);
    // Belt-and-suspenders snap for browsers with weak scroll-snap support.
    if (settleRef.current) clearTimeout(settleRef.current);
    settleRef.current = setTimeout(() => {
      if (Math.abs(el.scrollTop - idx * itemH) > 1) el.scrollTo({ top: idx * itemH, behavior: 'smooth' });
    }, 90);
  };

  const pickIndex = (i: number) => {
    setPendingIdx(i);
    scrollRef.current?.scrollTo({ top: i * itemH, behavior: 'smooth' });
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        className={`relative ${large ? 'w-96 max-w-[94vw]' : 'w-72 max-w-[88vw]'} bg-white rounded-2xl shadow-xl p-3`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <button type="button" onClick={onClose} className={`font-heading text-gray-500 hover:text-gray-700 px-1 ${large ? 'text-base' : 'text-sm'}`}>Cancel</button>
          {ariaLabel && <span className={`font-heading font-semibold text-ink ${large ? 'text-base' : 'text-sm'}`}>{ariaLabel}</span>}
          <button type="button" onClick={() => onPick(options[pendingIdx].value)} className={`font-heading font-bold text-brand px-1 ${large ? 'text-base' : 'text-sm'}`}>Done</button>
        </div>
        <div className="relative" style={{ height: containerH }}>
          {/* Center selection band. */}
          <div
            className="absolute inset-x-0 pointer-events-none border-y-2 border-brand/40 bg-brand/5 rounded"
            style={{ top: PAD, height: itemH }}
          />
          {/* Soft fade at top/bottom for the "wheel" feel. */}
          <div className="absolute inset-x-0 top-0 pointer-events-none bg-gradient-to-b from-white to-transparent" style={{ height: PAD }} />
          <div className="absolute inset-x-0 bottom-0 pointer-events-none bg-gradient-to-t from-white to-transparent" style={{ height: PAD }} />
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="h-full overflow-y-auto [&::-webkit-scrollbar]:hidden"
            style={{ scrollSnapType: 'y mandatory', scrollbarWidth: 'none', msOverflowStyle: 'none' as any, WebkitOverflowScrolling: 'touch' }}
          >
            <div style={{ height: PAD }} />
            {options.map((o, i) => (
              <div
                key={o.value}
                // Tap a non-centered row to spin it to the middle; tap the row
                // that's already centered to confirm (Done).
                onClick={() => { if (i === pendingIdx) onPick(o.value); else pickIndex(i); }}
                className={`flex items-center justify-center text-center px-3 leading-tight cursor-pointer select-none transition-colors ${i === pendingIdx ? `text-ink font-bold ${large ? 'text-2xl' : 'text-lg'}` : `text-gray-500 ${large ? 'text-xl' : 'text-base'}`}`}
                style={{ height: itemH, scrollSnapAlign: 'center' }}
              >
                {o.label}
              </div>
            ))}
            <div style={{ height: PAD }} />
          </div>
        </div>
      </div>
    </div>
  );
}
