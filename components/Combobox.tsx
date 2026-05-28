import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface ComboboxOption {
  value: string;          // The actual value passed back on selection
  label: string;          // The display label
  sublabel?: string;      // Optional secondary text (e.g., email under name)
}

interface Props {
  options: ComboboxOption[];
  value: string;          // currently selected value
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  loading?: boolean;
  error?: string | null;
  emptyLabel?: string;    // shown when no options match the search
  id?: string;
  // Compact variant: tighter padding, smaller font, ~36px height to match the
  // inline edit row's other inputs. Defaults to false (original modal sizing).
  compact?: boolean;
}

/**
 * A lightweight searchable dropdown. Types-to-filter, click-to-select,
 * keyboard arrow + Enter to select, Escape to close.
 *
 * The dropdown panel uses position:fixed and computes its viewport coordinates
 * from the input's bounding rect. This escapes ancestor overflow:hidden /
 * overflow:auto clipping that would otherwise hide the panel — important when
 * the combobox is rendered inside a table cell.
 */
export function Combobox({
  options,
  value,
  onChange,
  placeholder = 'Select...',
  disabled = false,
  loading = false,
  error = null,
  emptyLabel = 'No matches found',
  id,
  compact = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Panel position (viewport coords)
  const [panelStyle, setPanelStyle] = useState<{ left: number; top: number; width: number } | null>(null);

  // Find the label for the currently selected value
  const selectedLabel = options.find((o) => o.value === value)?.label || '';

  // Filter options by query
  const filtered = query.trim()
    ? options.filter((o) => {
        const q = query.toLowerCase();
        return (
          o.label.toLowerCase().includes(q) ||
          (o.sublabel || '').toLowerCase().includes(q)
        );
      })
    : options;

  // Position the floating panel beneath the input. Re-run on open + on scroll/resize.
  useLayoutEffect(() => {
    if (!open) return;
    function reposition() {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setPanelStyle({
        left: rect.left,
        top: rect.bottom + 4,
        width: rect.width,
      });
    }
    reposition();
    window.addEventListener('scroll', reposition, true);   // capture phase to catch scrollable ancestors
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open]);

  // Close when clicking outside (both the input AND the panel are valid in-scope)
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      const inInput = containerRef.current?.contains(target);
      const inPanel = (e.target as HTMLElement)?.closest?.('[data-combobox-panel="true"]');
      if (!inInput && !inPanel) {
        setOpen(false);
        setQuery('');
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Reset active index when filtered list changes
  useEffect(() => {
    setActiveIndex(filtered.length > 0 ? 0 : -1);
  }, [query, filtered.length]);

  function handleSelect(opt: ComboboxOption) {
    onChange(opt.value);
    setOpen(false);
    setQuery('');
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0 && activeIndex < filtered.length) {
        handleSelect(filtered[activeIndex]);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      setQuery('');
    }
  }

  // Size classes
  const inputBoxClasses = compact
    ? 'flex items-center w-full border rounded px-2 py-1 text-sm bg-white cursor-text transition'
    : 'flex items-center w-full border rounded-lg px-3 py-2.5 text-base bg-white cursor-text transition';
  const inputClasses = compact
    ? 'flex-1 bg-transparent outline-none text-sm text-ink placeholder-gray-400 min-w-0'
    : 'flex-1 bg-transparent outline-none text-ink placeholder-gray-400 min-w-0';

  return (
    <div ref={containerRef} className="relative">
      <div
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        className={`${inputBoxClasses} ${
          open ? 'border-brand ring-2 ring-brand/20' : 'border-gray-300 hover:border-gray-400'
        } ${disabled ? 'bg-gray-100 cursor-not-allowed' : ''}`}
        onClick={() => {
          if (!disabled) {
            setOpen(true);
            inputRef.current?.focus();
          }
        }}
      >
        <input
          ref={inputRef}
          id={id}
          type="text"
          autoComplete="off"
          value={open ? query : selectedLabel}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={loading ? 'Loading...' : placeholder}
          disabled={disabled || loading}
          className={inputClasses}
        />
        <button
          type="button"
          aria-label="Toggle dropdown"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); inputRef.current?.focus(); }}
          disabled={disabled}
          className="ml-2 text-gray-400 hover:text-gray-700 flex-shrink-0"
        >
          <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" clipRule="evenodd" />
          </svg>
        </button>
      </div>
      {error && (
        <div className="text-xs text-red-600 mt-1">{error}</div>
      )}

      {/* Floating panel — uses fixed positioning to escape ancestor overflow */}
      {open && !disabled && panelStyle && (
        <div
          data-combobox-panel="true"
          style={{
            position: 'fixed',
            left: panelStyle.left,
            top: panelStyle.top,
            width: panelStyle.width,
            maxHeight: 280,
            zIndex: 9999,
          }}
          className="overflow-y-auto bg-white rounded-lg border border-gray-300 shadow-xl"
          onMouseDown={(e) => e.preventDefault()}  /* keep the input focused */
        >
          {filtered.length === 0 ? (
            <div className="p-3 text-sm text-gray-500">{emptyLabel}</div>
          ) : (
            <ul role="listbox" className="py-1">
              {filtered.map((opt, idx) => {
                const isActive = idx === activeIndex;
                const isSelected = opt.value === value;
                return (
                  <li
                    key={opt.value}
                    role="option"
                    aria-selected={isSelected}
                    onMouseDown={(e) => { e.preventDefault(); handleSelect(opt); }}
                    onMouseEnter={() => setActiveIndex(idx)}
                    className={`px-3 py-2 cursor-pointer text-sm ${
                      isActive ? 'bg-brand/10' : ''
                    } ${isSelected ? 'font-semibold' : ''}`}
                  >
                    <div className="text-ink">{opt.label}</div>
                    {opt.sublabel && (
                      <div className="text-xs text-gray-500 truncate">{opt.sublabel}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
