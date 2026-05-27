import { useEffect, useRef, useState } from 'react';

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
}

/**
 * A lightweight searchable dropdown. Types-to-filter, click-to-select,
 * keyboard arrow + Enter to select, Escape to close.
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
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

  // Close when clicking outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
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

  return (
    <div ref={containerRef} className="relative">
      <div
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        className={`flex items-center w-full border rounded-lg px-3 py-2.5 text-base bg-white cursor-text transition ${
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
          className="flex-1 bg-transparent outline-none text-ink placeholder-gray-400"
        />
        <button
          type="button"
          aria-label="Toggle dropdown"
          onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
          disabled={disabled}
          className="ml-2 text-gray-400 hover:text-gray-700"
        >
          <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" clipRule="evenodd" />
          </svg>
        </button>
      </div>
      {error && (
        <div className="text-xs text-red-600 mt-1">{error}</div>
      )}

      {open && !disabled && (
        <div className="combobox-panel absolute z-20 top-full mt-1 left-0 right-0 max-h-64 overflow-y-auto bg-white rounded-lg">
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
                      <div className="text-xs text-gray-500">{opt.sublabel}</div>
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
