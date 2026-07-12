import { useEffect, useRef } from 'react';

/**
 * A textarea that GROWS to fit its whole content (no clipped text / tiny inner
 * scrollbar) and can be dragged taller/shorter by the corner handle. Once the user
 * drags to resize, a ResizeObserver hands control over — we stop auto-growing and
 * respect their size. Auto-grow runs on every status, including disabled/locked
 * fields, so a completed note still expands so the whole thing is readable.
 *
 * Drop-in for <textarea>: pass value/onChange/className/etc. as usual. `minPx`
 * sets a floor height; we never shrink below the content otherwise.
 */
type Props = React.TextareaHTMLAttributes<HTMLTextAreaElement> & { minPx?: number };

export function AutoGrowTextarea({ value, className, style, minPx = 38, ...rest }: Props) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const userSized = useRef(false);   // set once the user drags the handle
  const autoSetting = useRef(false);  // guards our own height writes from the ResizeObserver

  const grow = () => {
    const el = ref.current;
    if (!el || userSized.current) return;
    autoSetting.current = true;
    el.style.height = 'auto';
    el.style.height = `${Math.max(minPx, el.scrollHeight)}px`;
    // Clear the guard AFTER the ResizeObserver has had a chance to fire for this write.
    requestAnimationFrame(() => { autoSetting.current = false; });
  };

  // Re-fit whenever the text changes.
  useEffect(grow, [value]);

  // Fit on mount + observe for a manual drag-resize (which disables auto-grow).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    grow();
    let prev = el.offsetHeight;
    const ro = new ResizeObserver(() => {
      const h = el.offsetHeight;
      if (!autoSetting.current && Math.abs(h - prev) > 1) userSized.current = true;
      prev = h;
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <textarea
      ref={ref}
      value={value}
      className={className}
      style={{ resize: 'vertical', overflow: 'hidden', ...style }}
      {...rest}
    />
  );
}
