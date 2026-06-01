import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface ComboboxOption {
  value: string;          // The actual value passed back on selection
  label: string;          // The display label
  sublabel?: string;      // Optional secondary text (e.g., email under name)
  group?: string;         // Optional section header to group options under
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
  // When true, on focus the input scrolls to the top of its scrollable modal so
  // the dropdown is visible above the on-screen keyboard; on blur it scrolls the
  // modal back to the top. Only meaningful inside a `[data-modal-scroll]` sheet.
  scrollIntoViewOnFocus?: boolean;
  // Filled, borderless styling (light grey fill) to match the de-bordered
  // line-editor fields (default keeps the neutral grey-bordered white look).
  filled?: boolean;
  // When true, the first tap OPENS the list without focusing the text input, so
  // the on-screen keyboard doesn't pop up — the user can scroll options first
  // and only gets the keyboard when they tap the field again to type.
  deferKeyboard?: boolean;
  // Fired when the text input gains/loses focus (i.e. the keyboard opens/closes).
  // Lets a parent grow extra scroll room so the dropdown clears the keyboard.
  onFocusChange?: (focused: boolean) => void;
  // Server-search mode: when provided, the parent owns matching. The combobox
  // calls this (debounced) as the user types so the parent can refetch
  // `options` from the API — used for datasets too large to pre-load (e.g.
  // 15k+ properties). In this mode the local filter only *ranks* the supplied
  // options; it never hides them (the server already narrowed the set, possibly
  // matching on a field that isn't displayed, like zip).
  onQueryChange?: (query: string) => void;
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
  scrollIntoViewOnFocus = false,
  onQueryChange,
  filled = false,
  deferKeyboard = false,
  onFocusChange,
}: Props) {
  const serverMode = typeof onQueryChange === 'function';
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  // The option value just tapped — held briefly so its pink band is visible
  // before the panel closes.
  const [picked, setPicked] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Panel position (viewport coords)
  const [panelStyle, setPanelStyle] = useState<{ left: number; top: number; width: number } | null>(null);

  // Find the label for the currently selected value
  const selectedLabel = options.find((o) => o.value === value)?.label || '';

  // Fuzzy, ranked filtering: split the query into tokens; an option matches when
  // EVERY token appears in its label/sublabel (in any order), so "paint wall"
  // finds "Paint 1 Wall". Results are sorted best-match-first.
  const filtered = (() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    const tokens = q.split(/\s+/).filter(Boolean);
    const scored: { o: ComboboxOption; s: number }[] = [];
    for (const o of options) {
      const label = (o.label || '').toLowerCase();
      const sub = (o.sublabel || '').toLowerCase();
      const hay = `${label} ${sub}`;
      // In server mode the parent already filtered; keep every option and only
      // rank. In client mode require all tokens to appear (hides non-matches).
      if (!serverMode && !tokens.every((t) => hay.includes(t))) continue;
      let s = 0;
      if (label.includes(q)) s += 100;            // whole query contiguous in the label
      if (label.startsWith(tokens[0])) s += 40;   // label starts with the first token
      for (const t of tokens) {
        const li = label.indexOf(t);
        if (li >= 0) { s += 12; if (li === 0 || label[li - 1] === ' ') s += 6; } // token in label (word-start bonus)
        else if (hay.includes(t)) s += 3;         // token only in the sublabel
      }
      s += Math.max(0, 24 - label.length) / 4;    // nudge shorter / more specific labels up
      scored.push({ o, s });
    }
    scored.sort((a, b) => b.s - a.s);
    return scored.map((x) => x.o);
  })();

  // Server-search mode: tell the parent to refetch (debounced) as the user types.
  useEffect(() => {
    if (!serverMode) return;
    const handle = setTimeout(() => onQueryChange!(query.trim()), 250);
    return () => clearTimeout(handle);
  }, [query, serverMode, onQueryChange]);

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
    // iOS soft keyboard show/hide moves the input but fires neither a window
    // resize nor a scroll — track the visual viewport so the fixed panel stays
    // attached to the input.
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    vv?.addEventListener('resize', reposition);
    vv?.addEventListener('scroll', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      vv?.removeEventListener('resize', reposition);
      vv?.removeEventListener('scroll', reposition);
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
    // Briefly show the pink selection band on the tapped row before closing
    // (matches the ListPicker), so the choice is visible before the panel goes.
    setPicked(opt.value);
    window.setTimeout(() => {
      onChange(opt.value);
      setOpen(false);
      setQuery('');
      setPicked(null);
      // Dismiss the on-screen keyboard on mobile after a selection — otherwise
      // the search input stays focused and the keyboard covers the form.
      inputRef.current?.blur();
    }, 160);
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

  // Size classes. In compact mode (used in the rate card edit row), style the
  // closed state to look like a native <select>: 36px height, single-line label,
  // dark chevron on the right. When opened, the input behaves as a search field.
  // Compact uses asymmetric padding (pl-2 pr-1) and a tight chevron margin
  // (ml-0.5) so a 4-character value like "100%" fits inside ~72px.
  const fieldBg = filled ? 'bg-gray-100' : 'bg-white';
  const inputBoxClasses = compact
    ? `flex items-center w-full border rounded h-9 pl-2 pr-1 text-sm cursor-pointer transition ${fieldBg}`
    : `flex items-center w-full border rounded-lg px-3 py-2.5 text-base cursor-text transition ${fieldBg}`;
  // Hide the native search-clear (×) that type="search" adds in WebKit/Chrome.
  const noSearchUi = '[&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none';
  const inputClasses = compact
    ? `flex-1 bg-transparent outline-none text-sm text-ink placeholder-gray-400 min-w-0 cursor-pointer ${noSearchUi}`
    : `flex-1 bg-transparent outline-none text-ink placeholder-gray-400 min-w-0 ${noSearchUi}`;

  return (
    <div ref={containerRef} className="relative">
      <div
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        className={`${inputBoxClasses} ${
          filled ? 'border-transparent'
            : open ? 'border-brand ring-2 ring-brand/20' : 'border-gray-300 hover:border-gray-400'
        } ${disabled ? 'bg-gray-100 cursor-not-allowed' : ''}`}
        onClick={() => {
          if (!disabled) {
            setOpen(true);
            // In deferKeyboard mode, don't focus the input on the opening tap —
            // that's what pops the keyboard. The user taps the field again to type.
            if (!deferKeyboard) inputRef.current?.focus();
          }
        }}
      >
        <input
          ref={inputRef}
          id={id}
          // type="search" (not "text"): Android Chrome does NOT offer its
          // address / payment-card / location autofill bar on a search field,
          // so this field behaves like a plain search box — no extra autofill
          // line above the keyboard (unlike a generic text input).
          type="search"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          name="catalog-search"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          inputMode="search"
          enterKeyHint="search"
          data-1p-ignore="true"
          data-lpignore="true"
          data-form-type="other"
          onMouseDown={(e) => {
            // deferKeyboard: block focus on the OPENING tap so no keyboard pops
            // (the wrapper onClick opens the list). Once open, taps focus normally
            // so the user can type. readOnly while closed is the cross-browser way
            // to keep the keyboard down without losing the tap.
            if (deferKeyboard && !open) { e.preventDefault(); setOpen(true); }
          }}
          readOnly={deferKeyboard && !open}
          value={open ? query : selectedLabel}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            setOpen(true);
            onFocusChange?.(true);
            if (scrollIntoViewOnFocus) {
              // Lift the field up near the top of the sheet so the dropdown has
              // room above the keyboard. Re-fire a few times because the on-screen
              // keyboard animates in over a few hundred ms and shifts the layout
              // after a single early scroll would have run.
              const lift = () => {
                const scroller = containerRef.current?.closest('[data-modal-scroll]') as HTMLElement | null;
                const field = containerRef.current;
                if (!scroller || !field) return;
                const fRect = field.getBoundingClientRect();
                const sRect = scroller.getBoundingClientRect();
                const HEADROOM = 80; // clears the ~50px sticky header so the field stays visible
                scroller.scrollTo({ top: scroller.scrollTop + (fRect.top - sRect.top) - HEADROOM, behavior: 'smooth' });
              };
              setTimeout(lift, 300);
              setTimeout(lift, 650);
            }
          }}
          onBlur={() => {
            onFocusChange?.(false);
            if (scrollIntoViewOnFocus) {
              setTimeout(() => {
                const scroller = containerRef.current?.closest('[data-modal-scroll]') as HTMLElement | null;
                scroller?.scrollTo({ top: 0, behavior: 'smooth' });
              }, 180);
            }
          }}
          onKeyDown={handleKeyDown}
          placeholder={loading ? 'Loading...' : placeholder}
          disabled={disabled || loading}
          title={!open && selectedLabel ? selectedLabel : undefined}
          className={inputClasses}
        />
        <button
          type="button"
          aria-label="Toggle dropdown"
          onMouseDown={(e) => e.preventDefault()}
          // The chevron is purely a toggle: open/close the panel and never focus
          // the input (so it can't pop the keyboard). In deferKeyboard mode the
          // only way to type is tapping the text field while the panel is open.
          onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); if (!deferKeyboard) inputRef.current?.focus(); }}
          disabled={disabled}
          className={`flex-shrink-0 ${compact ? 'ml-0.5 text-gray-600 hover:text-gray-900' : 'ml-2 text-gray-400 hover:text-gray-700'}`}
        >
          <svg width={compact ? 16 : 14} height={compact ? 16 : 14} viewBox="0 0 20 20" fill="currentColor">
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
              {(() => {
                // Group options into ordered sections (by first appearance),
                // rendering a non-selectable header before each named group.
                // Keyboard/active indexing still references the flat `filtered`.
                const groups: { name: string; items: { opt: ComboboxOption; idx: number }[] }[] = [];
                const gi = new Map<string, number>();
                filtered.forEach((opt, idx) => {
                  const g = opt.group || '';
                  let i = gi.get(g);
                  if (i === undefined) { i = groups.length; gi.set(g, i); groups.push({ name: g, items: [] }); }
                  groups[i].items.push({ opt, idx });
                });
                return groups.map((grp) => (
                  <li key={grp.name || '__ungrouped'} role="presentation">
                    {grp.name && (
                      <div className="px-3 py-1.5 text-[11px] font-heading font-bold uppercase tracking-wider text-gray-600 bg-gray-100 border-y border-gray-200 sticky top-0 z-10">
                        {grp.name}
                      </div>
                    )}
                    <ul role="group" aria-label={grp.name || undefined}>
                      {grp.items.map(({ opt, idx }) => {
                        const isActive = idx === activeIndex;
                        const isSelected = opt.value === value;
                        // The just-tapped row gets the pink band + top/bottom
                        // border (same as the wheel / list pickers); keyboard/hover
                        // highlight stays a lighter tint.
                        const isPicked = picked === opt.value;
                        return (
                          <li
                            key={opt.value}
                            role="option"
                            aria-selected={isSelected}
                            onMouseDown={(e) => { e.preventDefault(); handleSelect(opt); }}
                            onMouseEnter={() => setActiveIndex(idx)}
                            title={opt.sublabel ? `${opt.label}\n\n${opt.sublabel}` : opt.label}
                            className={`px-3 py-2 cursor-pointer text-sm border-y-2 ${isPicked ? 'bg-brand/10 border-brand' : isActive ? 'bg-brand/5 border-transparent' : 'border-transparent'} ${isSelected ? 'font-semibold' : ''}`}
                          >
                            <div className="text-ink">{opt.label}</div>
                            {opt.sublabel && (
                              <div
                                title={opt.sublabel}
                                className="text-xs text-gray-500 overflow-hidden"
                                style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}
                              >{opt.sublabel}</div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ));
              })()}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
