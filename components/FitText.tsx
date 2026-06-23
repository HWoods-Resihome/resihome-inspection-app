import { useEffect, useRef, useState } from 'react';

// iOS/iPadOS WebKit. iOS shows NO system confirmation for a programmatic clipboard
// write (unlike Android), so we surface our own "Link copied" toast only there.
const IS_IOS = typeof navigator !== 'undefined'
  && (/iP(hone|ad|od)/i.test(navigator.userAgent || '')
    || (/Macintosh/.test(navigator.userAgent || '') && ((navigator as any).maxTouchPoints || 0) > 1));

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
  const [copied, setCopied] = useState(false);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPt = useRef<{ x: number; y: number } | null>(null);
  const longPressFired = useRef(false);
  const copiedNative = useRef(false);

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

  // Clean up timers on unmount.
  useEffect(() => () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);

  // iOS-only "Link copied" toast (Android shows its own system confirmation).
  const showCopiedToast = () => {
    if (!IS_IOS) return;
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1600);
  };

  const cancelPress = () => {
    if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; }
    startPt.current = null;
    longPressFired.current = false;
    copiedNative.current = false;
  };

  const resolvedUrl = () => {
    if (!copyLink) return '';
    return /^https?:/i.test(copyLink)
      ? copyLink
      : (typeof window !== 'undefined' ? `${window.location.origin}${copyLink}` : copyLink);
  };

  // Native (Capacitor) clipboard — works in the iOS/Android webview WITHOUT a
  // user-gesture requirement (the reason the web clipboard API silently failed on
  // a long-press in the iOS WKWebView). Uses the runtime-registered global plugin
  // so @capacitor/clipboard isn't pulled into the web bundle. Returns true if it
  // handled the copy. No-op (false) in a normal browser.
  const nativeCopy = (text: string): boolean => {
    if (typeof window === 'undefined') return false;
    const cap = (window as any).Capacitor;
    if (!cap?.isNativePlatform?.()) return false;
    const clip = cap.Plugins?.Clipboard;
    if (!clip?.write) return false;
    try { void clip.write({ string: text }); return true; } catch { return false; }
  };

  // Web clipboard (needs a user gesture — call from pointerUp). Async API first,
  // then an execCommand fallback for older webviews.
  const webCopy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); return; }
    catch { /* fall through to execCommand */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch { /* nothing else to try */ }
  };

  const haptic = () => { try { navigator.vibrate?.(15); } catch { /* iOS has no vibrate — fine */ } };

  const bind = copyLink ? {
    onPointerDown: (e: React.PointerEvent) => {
      startPt.current = { x: e.clientX, y: e.clientY };
      longPressFired.current = false;
      copiedNative.current = false;
      if (pressTimer.current) clearTimeout(pressTimer.current);
      // When the hold is recognized: copy IMMEDIATELY via the native plugin (no
      // gesture needed in the webview). On plain web the native path is a no-op
      // and we instead copy on pointerUp, which is a valid user gesture.
      pressTimer.current = setTimeout(() => {
        pressTimer.current = null;
        longPressFired.current = true;
        copiedNative.current = nativeCopy(resolvedUrl());
        if (copiedNative.current) showCopiedToast();
        haptic();
      }, 500);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const s = startPt.current;
      if (s && (Math.abs(e.clientX - s.x) > 10 || Math.abs(e.clientY - s.y) > 10)) cancelPress();
    },
    onPointerUp: () => {
      const fired = longPressFired.current;
      const already = copiedNative.current;
      cancelPress();
      // Native already copied on the hold; on web, copy now inside this pointerup
      // gesture (the only place iOS Safari permits clipboard.writeText).
      if (fired && !already) { void webCopy(resolvedUrl()); showCopiedToast(); }
    },
    onPointerLeave: cancelPress,
    onPointerCancel: cancelPress,
    // Suppress the desktop right-click / iOS text-selection callout on hold.
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); },
  } : {};

  const textDiv = (
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

  if (!copyLink) return textDiv;
  return (
    <>
      {textDiv}
      {copied && (
        <div style={{
          position: 'fixed', left: '50%', bottom: 28, transform: 'translateX(-50%)', zIndex: 9999,
          background: '#111827', color: '#fff', fontSize: 13, fontWeight: 600,
          padding: '8px 14px', borderRadius: 9999, boxShadow: '0 4px 16px rgba(0,0,0,.25)', pointerEvents: 'none',
        }}>
          Link copied
        </div>
      )}
    </>
  );
}
