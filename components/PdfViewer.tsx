// In-app PDF viewer overlay.
//
// Renders a PDF with pdf.js (canvas) so it works EVERYWHERE — including the
// Android system WebView, which can't display PDFs in an <iframe>. The overlay
// pushes a browser history entry on open, so a back/swipe (browser, PWA, or the
// native Android back gesture) pops that entry and closes the viewer, returning
// to the last screen rather than exiting the app.
//
// The pdf.js worker is vendored at /public/pdf.worker.min.js (kept in lockstep
// with the pinned pdfjs-dist version) so it loads same-origin with no CDN.

import { useCallback, useEffect, useRef, useState } from 'react';

type Props = { url: string; title?: string; onClose: () => void };

export default function PdfViewer({ url, title, onClose }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pagesRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  // Visual zoom applied on top of the fit-width base render (CSS transform).
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  zoomRef.current = zoom;

  // ---- history-backed close ----
  // Push one entry on open; ANY back (button, browser, native gesture) pops it
  // and fires popstate → onClose. The close button calls history.back() so it
  // travels the same path (and never leaves a dangling entry).
  useEffect(() => {
    window.history.pushState({ __pdfViewer: true }, '');
    const onPop = () => onClose();
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const requestClose = useCallback(() => {
    if (typeof window !== 'undefined') window.history.back();
  }, []);

  // ESC closes (desktop).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') requestClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [requestClose]);

  // ---- pinch-to-zoom (touch) ----
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let pinchStart = 0;
    let startZoom = 1;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) { pinchStart = dist(e.touches); startZoom = zoomRef.current; }
    };
    const onMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && pinchStart > 0) {
        e.preventDefault();
        const next = Math.max(0.5, Math.min(4, startZoom * (dist(e.touches) / pinchStart)));
        setZoom(+next.toFixed(3));
      }
    };
    const onEnd = (e: TouchEvent) => { if (e.touches.length < 2) pinchStart = 0; };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
    };
  }, []);

  // ---- render the PDF pages to canvases (fit container width) ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pdfjs: any = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.js';
        const pdf = await pdfjs.getDocument({ url }).promise;
        const pagesEl = pagesRef.current;
        if (cancelled || !pagesEl) return;
        pagesEl.innerHTML = '';
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const containerWidth = Math.min((scrollRef.current?.clientWidth || 800) - 16, 1100);
        for (let n = 1; n <= pdf.numPages; n++) {
          if (cancelled) return;
          const page = await pdf.getPage(n);
          const base = page.getViewport({ scale: 1 });
          const cssScale = containerWidth / base.width;
          const viewport = page.getViewport({ scale: cssScale * dpr });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.style.width = `${containerWidth}px`;
          canvas.style.height = `${base.height * cssScale}px`;
          canvas.style.display = 'block';
          canvas.style.margin = '0 auto 10px';
          canvas.style.background = '#fff';
          canvas.style.boxShadow = '0 1px 6px rgba(0,0,0,0.35)';
          const cctx = canvas.getContext('2d');
          pagesEl.appendChild(canvas);
          await page.render({ canvasContext: cctx, viewport }).promise;
        }
        if (!cancelled) setStatus('ready');
      } catch (e) {
        console.error('[PdfViewer] render failed:', e);
        if (!cancelled) setStatus('error');
      }
    })();
    return () => { cancelled = true; };
  }, [url]);

  const iconBtn: React.CSSProperties = {
    width: 34, height: 34, borderRadius: 8, border: 'none', cursor: 'pointer',
    background: 'rgba(255,255,255,0.12)', color: '#fff', fontSize: 20, lineHeight: '34px',
    textAlign: 'center', padding: 0, flex: '0 0 auto',
  };
  const center: React.CSSProperties = {
    color: '#fff', textAlign: 'center', padding: '40px 16px', fontSize: 14,
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(18,18,20,0.97)', display: 'flex', flexDirection: 'column' }}>
      {/* Header: back/close · title · zoom · open externally (escape hatch) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: '#1b1b1e', color: '#fff' }}>
        <button onClick={requestClose} aria-label="Close PDF" title="Back" style={{ ...iconBtn, fontSize: 26, lineHeight: '32px' }}>‹</button>
        <div style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {title || 'PDF Report'}
        </div>
        <button onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))} aria-label="Zoom out" style={iconBtn}>−</button>
        <button onClick={() => setZoom((z) => Math.min(4, +(z + 0.25).toFixed(2)))} aria-label="Zoom in" style={iconBtn}>+</button>
        <a href={url} target="_blank" rel="noreferrer" aria-label="Open or download" title="Open / download"
           style={{ ...iconBtn, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3v12" />
            <path d="M7 11l5 5 5-5" />
            <path d="M5 21h14" />
          </svg>
        </a>
      </div>

      {/* Body */}
      <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', WebkitOverflowScrolling: 'touch', padding: 8 }}>
        {status === 'loading' && <div style={center}>Loading PDF…</div>}
        {status === 'error' && (
          <div style={center}>
            Couldn’t render the PDF here.{' '}
            <a href={url} target="_blank" rel="noreferrer" style={{ color: '#ff5fa0', textDecoration: 'underline' }}>Open it in a new tab</a>.
          </div>
        )}
        <div ref={pagesRef} style={{ transform: `scale(${zoom})`, transformOrigin: 'top center', transition: 'transform 120ms ease-out' }} />
      </div>
    </div>
  );
}
