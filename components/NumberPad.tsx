/**
 * NumberField + branded on-screen NumberPad.
 *
 * WHY: on phones the native numeric keyboard drags in chrome we can't remove —
 * Android Chrome stacks an autofill bar ("passwords / addresses / payment") and
 * Gboard's suggestion strip above the keys, and Chrome deliberately ignores
 * autocomplete="off" for its own autofill. So instead of fighting the OS
 * keyboard we suppress it entirely (`inputMode="none"`) and drive the value with
 * our OWN keypad — branded to the app, identical behavior for every number
 * field, and zero OS suggestion/autofill rows.
 *
 * - Touch devices: focusing the field pops our keypad (a bottom sheet rendered
 *   in a portal, above any modal) and the OS keyboard stays down.
 * - Desktop (fine pointer): no pad — the physical keyboard types straight in
 *   (inputMode="none" has no downside there). Values are sanitized either way.
 * - When the pad opens we pad the modal scroller and scroll the field to centre
 *   so it never hides behind the keypad. Keys fire on pointerdown + preventDefault
 *   so a tap never blurs the field; "Done" blurs to close.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type NumberFieldProps = {
  value: string;
  onChange: (next: string) => void;
  /** Allow a decimal point. Default true. */
  allowDecimal?: boolean;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
  disabled?: boolean;
  /** Run when the field gains focus (e.g. clear-on-focus). */
  onFocusField?: () => void;
  /** Run when editing ends (Done / blur) — mirrors the old onBlur. */
  onDone?: () => void;
};

const isTouch = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(pointer: coarse)').matches;

function sanitize(raw: string, allowDecimal: boolean): string {
  let t = raw.replace(/[^0-9.]/g, '');
  if (!allowDecimal) return t.replace(/\./g, '');
  // collapse to a single decimal point
  const i = t.indexOf('.');
  if (i !== -1) t = t.slice(0, i + 1) + t.slice(i + 1).replace(/\./g, '');
  return t;
}

export function NumberField({
  value,
  onChange,
  allowDecimal = true,
  placeholder,
  className,
  ariaLabel,
  disabled,
  onFocusField,
  onDone,
}: NumberFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const padRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Make room for the keypad when it opens, then restore on close.
  //  - Inside a modal (marked [data-modal-overlay] + [data-modal-scroll]): LIFT
  //    the whole modal above the keypad so its Save/Cancel footer stays visible
  //    and tappable (otherwise the keypad covers Cancel and a tap there hits the
  //    keypad instead — making Cancel behave like keeping the edit), and shrink
  //    the scroll area so the edited field clears the keypad.
  //  - On a plain page: pad the body so the field can scroll above the keypad.
  useEffect(() => {
    if (!open) return;
    const inp = inputRef.current;
    if (!inp) return;
    const h = (padRef.current?.offsetHeight ?? 300) + 12; // keypad height + gap
    const overlay = inp.closest('[data-modal-overlay]') as HTMLElement | null;
    const scroller = inp.closest('[data-modal-scroll]') as HTMLElement | null;

    const restore: Array<() => void> = [];
    if (overlay) {
      const prev = overlay.style.paddingBottom;
      overlay.style.paddingBottom = `${h}px`;
      restore.push(() => { overlay.style.paddingBottom = prev; });
    }
    if (scroller) {
      const prev = scroller.style.maxHeight;
      scroller.style.maxHeight = `calc(100dvh - ${h + 16}px)`;
      restore.push(() => { scroller.style.maxHeight = prev; });
    }
    if (!overlay && !scroller) {
      const prev = document.body.style.paddingBottom;
      document.body.style.paddingBottom = `${h}px`;
      restore.push(() => { document.body.style.paddingBottom = prev; });
    }

    const raf = requestAnimationFrame(() =>
      inp.scrollIntoView({ block: 'center', behavior: 'smooth' }),
    );
    return () => {
      cancelAnimationFrame(raf);
      restore.forEach((fn) => fn());
    };
  }, [open]);

  const commit = (next: string) => onChange(sanitize(next, allowDecimal));

  const pressDigit = (d: string) => {
    // Replace a lone leading zero so "0" + "5" → "5" (but keep "0." intact).
    const base = value === '0' ? '' : value;
    commit(base + d);
  };
  const pressDot = () => {
    if (!allowDecimal || value.includes('.')) return;
    commit(value === '' ? '0.' : value + '.');
  };
  const pressBack = () => commit(value.slice(0, -1));

  // A key: fire on pointerdown and preventDefault so the field never blurs
  // (keeps focus + caret) and rapid taps register instantly.
  const key = (handler: () => void) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      handler();
      // keep the caret pinned to the end after a controlled re-render
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (el) {
          const end = el.value.length;
          try { el.setSelectionRange(end, end); } catch { /* number-ish input */ }
        }
      });
    },
  });

  const KEY_CLS =
    'h-14 rounded-xl bg-gray-100 active:bg-gray-200 text-2xl font-heading font-semibold text-ink flex items-center justify-center select-none';

  return (
    <>
      <input
        ref={inputRef}
        type="text"
        // The whole point: no OS virtual keyboard (and so none of its
        // autofill/suggestion rows). Caret still shows; our keypad drives it.
        inputMode="none"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="done"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        disabled={disabled}
        className={className}
        onChange={(e) => commit(e.target.value)}
        onFocus={() => {
          if (disabled) return;
          onFocusField?.();
          if (isTouch()) setOpen(true);
        }}
        onBlur={() => {
          if (open) {
            setOpen(false);
            onDone?.();
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
        }}
      />

      {mounted && open &&
        createPortal(
          <div
            ref={padRef}
            data-numberpad
            className="fixed inset-x-0 bottom-0 z-[200] bg-white border-t border-gray-200 rounded-t-2xl shadow-[0_-8px_24px_rgba(0,0,0,0.12)] px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
            // Tapping the sheet background must not blur the field, nor bubble
            // out to any modal/row click handler.
            onPointerDown={(e) => e.preventDefault()}
            onClick={(e) => e.stopPropagation()}
            role="group"
            aria-label="Number pad"
          >
            <div className="mx-auto w-full max-w-md">
              <div className="grid grid-cols-3 gap-2">
                {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                  <button key={d} type="button" className={KEY_CLS} {...key(() => pressDigit(d))}>
                    {d}
                  </button>
                ))}
                <button
                  type="button"
                  className={`${KEY_CLS} ${allowDecimal ? '' : 'invisible'}`}
                  aria-label="Decimal point"
                  {...key(pressDot)}
                >
                  .
                </button>
                <button type="button" className={KEY_CLS} {...key(() => pressDigit('0'))}>
                  0
                </button>
                <button type="button" className={KEY_CLS} aria-label="Delete" {...key(pressBack)}>
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2Z" />
                    <line x1="18" y1="9" x2="12" y2="15" />
                    <line x1="12" y1="9" x2="18" y2="15" />
                  </svg>
                </button>
              </div>
              <button
                type="button"
                className="mt-2 w-full h-12 rounded-xl bg-brand text-white font-heading font-bold text-lg active:opacity-90 select-none"
                // Blur the field → onBlur closes the pad and runs onDone once.
                onPointerDown={(e) => { e.preventDefault(); inputRef.current?.blur(); }}
              >
                Done
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
