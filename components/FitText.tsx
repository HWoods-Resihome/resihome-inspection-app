import { useEffect, useRef, useState } from 'react';

// Renders text on a single line, shrinking the font until it fits the available
// width (down to a floor) so long titles/addresses never wrap or truncate.
// Re-measures when the text, bounds, or container width changes.
//
// Optional `copyLink`: when provided, PRESS-AND-HOLD (long-press, ~500ms) on the
// text copies that link to the clipboard and shows a brief "Link copied" toast —
// e.g. hold the inspection title to copy a shareable link to it, at any status. A
// relative path ("/inspection/123") is resolved against the current origin.
export function FitText({ text, className, max = 14, min = 11, copyLink }: {
  text: string; className?: string; max?: number; min?: number; copyLink?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState(max);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPt = useRef<{ x: number; y: number } | null>(null);

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

  // Clean up the long-press timer on unmount.
  useEffect(() => () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
  }, []);

  const cancelPress = () => {
    if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; }
    startPt.current = null;
  };

  const doCopy = async () => {
    if (!copyLink) return;
    const url = /^https?:/i.test(copyLink)
      ? copyLink
      : (typeof window !== 'undefined' ? `${window.location.origin}${copyLink}` : copyLink);
    let ok = false;
    try {
      await navigator.clipboard.writeText(url);
      ok = true;
    } catch {
      // Fallback for webviews/older browsers without the async clipboard API.
      try {
        const ta = document.createElement('textarea');
        ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.focus(); ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch { ok = false; }
    }
    // No in-app toast — the device shows its own copy confirmation; a subtle
    // haptic is the only extra feedback.
    if (ok) { try { navigator.vibrate?.(15); } catch { /* no haptics — fine */ } }
  };

  const bind = copyLink ? {
    onPointerDown: (e: React.PointerEvent) => {
      startPt.current = { x: e.clientX, y: e.clientY };
      if (pressTimer.current) clearTimeout(pressTimer.current);
      pressTimer.current = setTimeout(() => { pressTimer.current = null; void doCopy(); }, 500);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const s = startPt.current;
      if (s && (Math.abs(e.clientX - s.x) > 10 || Math.abs(e.clientY - s.y) > 10)) cancelPress();
    },
    onPointerUp: cancelPress,
    onPointerLeave: cancelPress,
    onPointerCancel: cancelPress,
    // Suppress the desktop right-click / iOS text-selection callout on hold.
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); },
  } : {};

  return (
    <div
      ref={ref}
      className={className}
      style={{
        whiteSpace: 'nowrap', overflow: 'hidden', fontSize: `${size}px`, lineHeight: 1.2,
        ...(copyLink ? { cursor: 'copy', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' } as React.CSSProperties : {}),
      }}
      title={copyLink ? 'Press & hold to copy a link to this inspection' : text}
      {...bind}
    >
      {text}
    </div>
  );
}
