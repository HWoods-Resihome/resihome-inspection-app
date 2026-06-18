import { useEffect, useRef, useState } from 'react';

// Renders text on a single line, shrinking the font until it fits the available
// width (down to a floor) so long titles/addresses never wrap or truncate.
// Re-measures when the text, bounds, or container width changes.
export function FitText({ text, className, max = 14, min = 11 }: {
  text: string; className?: string; max?: number; min?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState(max);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      let s = max;
      el.style.fontSize = `${s}px`;
      while (s > min && el.scrollWidth > el.clientWidth) {
        s -= 0.5;
        el.style.fontSize = `${s}px`;
      }
      setSize(s);
    };
    fit();
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(fit);
      ro.observe(el);
    }
    return () => { ro?.disconnect(); };
  }, [text, max, min]);
  return (
    <div
      ref={ref}
      className={className}
      style={{ whiteSpace: 'nowrap', overflow: 'hidden', fontSize: `${size}px`, lineHeight: 1.2 }}
      title={text}
    >
      {text}
    </div>
  );
}
