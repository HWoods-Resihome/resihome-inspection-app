/**
 * AutoGrowTextarea — a <textarea> that grows to fit its content (so the whole
 * note is visible without an inner scrollbar) AND stays hand-resizable: drag the
 * bottom-right corner to make it taller/shorter. Once the user drags it, we stop
 * auto-growing and respect their size. Works on every inspection status — a
 * read-only/locked completed inspection can still be expanded to read the note.
 *
 * Drop-in for <textarea>: same props. Manage `value`/`onChange` as usual.
 */
import { useEffect, useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react';

export function AutoGrowTextarea({ className = '', style, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const lastAuto = useRef(-1);       // last height we set programmatically
  const userResized = useRef(false); // true once the user drags the handle

  const grow = () => {
    const el = ref.current;
    if (!el || userResized.current) return;
    el.style.height = 'auto';
    const h = el.scrollHeight;
    el.style.height = `${h}px`;
    lastAuto.current = h;
  };

  // Re-fit whenever the content (value) changes or on first paint.
  useLayoutEffect(grow);

  // Detect a manual drag-resize: a height change that isn't one we made. Once the
  // user resizes, hand control over to them (and enable scrolling if they shrink
  // it below the content).
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const node = ref.current;
      if (!node || userResized.current) return;
      if (lastAuto.current >= 0 && Math.abs(node.clientHeight - lastAuto.current) > 3) {
        userResized.current = true;
        node.style.overflowY = 'auto';
      }
    });
    ro.observe(el);
    const onWinResize = () => grow();
    window.addEventListener('resize', onWinResize);
    return () => { ro.disconnect(); window.removeEventListener('resize', onWinResize); };
  }, []);

  return (
    <textarea
      ref={ref}
      onInput={grow}
      className={`resize-y ${className}`}
      // Hidden overflow while auto-fitting (no scrollbar since it fits); the
      // ResizeObserver flips it to auto if the user shrinks it below the content.
      style={{ overflowY: 'hidden', ...style }}
      {...rest}
    />
  );
}
