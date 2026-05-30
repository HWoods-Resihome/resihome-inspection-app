/**
 * PhotoAnnotator — full-screen markup editor for a single photo.
 *
 * Tools: arrow, circle, freehand pen (no text). The inspector marks up damage,
 * then Save flattens the drawing onto the image and returns a JPEG File. Works
 * on touch + mouse via pointer events. Draws on a canvas sized to the (capped)
 * image dimensions so the saved photo is full-resolution.
 *
 * Annotate the LOCAL blob (not a remote URL) to avoid canvas cross-origin taint.
 */
import { useEffect, useRef, useState } from 'react';

type Tool = 'pen' | 'arrow' | 'circle';
type Pt = { x: number; y: number };
type Stroke =
  | { tool: 'pen'; color: string; width: number; points: Pt[] }
  | { tool: 'arrow'; color: string; width: number; a: Pt; b: Pt }
  | { tool: 'circle'; color: string; width: number; a: Pt; b: Pt };

const COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#ffffff'];
const MAX_EDGE = 1920;

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

interface Props {
  src: string;
  onCancel: () => void;
  onSave: (file: File) => void;
}

export function PhotoAnnotator({ src, onCancel, onSave }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const drawingRef = useRef<Stroke | null>(null);
  // Active pointers (for two-finger pinch-to-resize the brush).
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{ startDist: number; startScale: number } | null>(null);

  const [tool, setTool] = useState<Tool>('arrow');
  const [color, setColor] = useState<string>('#ef4444');
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [count, setCount] = useState(0); // strokes count → re-render for undo state
  // Brush thickness multiplier, adjusted by two-finger pinch.
  const [widthScale, setWidthScale] = useState(1);
  const widthScaleRef = useRef(1); widthScaleRef.current = widthScale;
  const [showSize, setShowSize] = useState(false);
  const toolRef = useRef(tool); toolRef.current = tool;
  const colorRef = useRef(color); colorRef.current = color;

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      let w = img.naturalWidth || img.width;
      let h = img.naturalHeight || img.height;
      const longEdge = Math.max(w, h);
      if (longEdge > MAX_EDGE) {
        const s = MAX_EDGE / longEdge;
        w = Math.round(w * s); h = Math.round(h * s);
      }
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = w; canvas.height = h;
      imgRef.current = img;
      setReady(true);
      redraw();
    };
    img.onerror = () => setLoadError(true);
    img.src = src;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  function strokeWidthFor(t: Tool): number {
    const c = canvasRef.current;
    const base = c ? Math.max(c.width, c.height) : 1000;
    const w = Math.max(4, Math.round(base / 200));
    // Arrows read better noticeably thicker by default.
    return t === 'arrow' ? Math.round(w * 1.6) : w;
  }

  function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke) {
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineWidth = s.width;
    if (s.tool === 'pen') {
      ctx.beginPath();
      s.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    } else if (s.tool === 'circle') {
      const cx = (s.a.x + s.b.x) / 2, cy = (s.a.y + s.b.y) / 2;
      const rx = Math.abs(s.b.x - s.a.x) / 2, ry = Math.abs(s.b.y - s.a.y) / 2;
      ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
    } else {
      const { a, b } = s;
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const head = Math.max(s.width * 3.2, s.width + 10);
      // End the shaft at the back of the arrowhead so the round line cap
      // doesn't poke through and blunt the tip.
      const bx = b.x - Math.cos(ang) * head * 0.7;
      const by = b.y - Math.sin(ang) * head * 0.7;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(bx, by); ctx.stroke();
      // Solid triangular head, narrow angle so it clearly reads as an arrow.
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - head * Math.cos(ang - Math.PI / 7), b.y - head * Math.sin(ang - Math.PI / 7));
      ctx.lineTo(b.x - head * Math.cos(ang + Math.PI / 7), b.y - head * Math.sin(ang + Math.PI / 7));
      ctx.closePath(); ctx.fill();
    }
  }

  function redraw() {
    const canvas = canvasRef.current; const img = imgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const s of strokesRef.current) drawStroke(ctx, s);
    if (drawingRef.current) drawStroke(ctx, drawingRef.current);
  }

  function toImg(e: React.PointerEvent): Pt {
    const c = canvasRef.current!;
    const rect = c.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (c.width / rect.width),
      y: (e.clientY - rect.top) * (c.height / rect.height),
    };
  }

  function onDown(e: React.PointerEvent) {
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* noop */ }

    // Second finger down → pinch to resize the brush. Keep the stroke the first
    // finger is drawing so it grows/shrinks live (the inspector doesn't lose it).
    if (pointersRef.current.size >= 2) {
      const [a, b] = [...pointersRef.current.values()];
      pinchRef.current = { startDist: Math.max(1, dist(a, b)), startScale: widthScaleRef.current };
      setShowSize(true);
      redraw();
      return;
    }

    if (!ready) return;
    e.preventDefault();
    const p = toImg(e);
    const t = toolRef.current; const col = colorRef.current;
    const w = Math.max(2, Math.round(strokeWidthFor(t) * widthScaleRef.current));
    drawingRef.current = t === 'pen'
      ? { tool: 'pen', color: col, width: w, points: [p] }
      : { tool: t, color: col, width: w, a: p, b: p };
    redraw();
  }
  function onMove(e: React.PointerEvent) {
    if (pointersRef.current.has(e.pointerId)) {
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    // Pinch: scale the brush by the change in finger distance, and resize the
    // in-progress stroke (if any) live.
    if (pinchRef.current && pointersRef.current.size >= 2) {
      e.preventDefault();
      const [a, b] = [...pointersRef.current.values()];
      const ratio = dist(a, b) / pinchRef.current.startDist;
      const ns = Math.min(5, Math.max(0.3, pinchRef.current.startScale * ratio));
      setWidthScale(ns);
      const d = drawingRef.current;
      if (d) d.width = Math.max(2, Math.round(strokeWidthFor(d.tool) * ns));
      redraw();
      return;
    }
    if (!drawingRef.current) return;
    e.preventDefault();
    const p = toImg(e);
    const d = drawingRef.current;
    if (d.tool === 'pen') d.points.push(p); else d.b = p;
    redraw();
  }
  function onUp(e: React.PointerEvent) {
    pointersRef.current.delete(e.pointerId);
    try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch { /* noop */ }

    // Finishing a pinch — commit the (resized) active stroke instead of dropping it.
    if (pinchRef.current) {
      if (pointersRef.current.size < 2) {
        pinchRef.current = null;
        setTimeout(() => setShowSize(false), 700);
        const d = drawingRef.current;
        if (d) {
          const keep = d.tool === 'pen'
            ? d.points.length > 1
            : Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y) > 4;
          if (keep) strokesRef.current.push(d);
          drawingRef.current = null;
          setCount(strokesRef.current.length);
        }
        redraw();
      }
      return;
    }

    const d = drawingRef.current;
    if (!d) return;
    e.preventDefault();
    const keep = d.tool === 'pen'
      ? d.points.length > 1
      : Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y) > 4;
    if (keep) strokesRef.current.push(d);
    drawingRef.current = null;
    redraw();
    setCount(strokesRef.current.length);
  }

  function undo() { strokesRef.current.pop(); redraw(); setCount(strokesRef.current.length); }
  function clearAll() { strokesRef.current = []; redraw(); setCount(0); }

  function save() {
    const canvas = canvasRef.current;
    if (!canvas) { onCancel(); return; }
    redraw();
    canvas.toBlob((blob) => {
      if (!blob) { onCancel(); return; }
      onSave(new File([blob], `annotated_${Date.now()}.jpg`, { type: 'image/jpeg' }));
    }, 'image/jpeg', 0.9);
  }

  const toolBtn = (t: Tool, label: string, icon: React.ReactNode) => (
    <button
      type="button"
      onClick={() => setTool(t)}
      aria-pressed={tool === t}
      className={`flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-lg text-[11px] font-heading ${
        tool === t ? 'bg-white text-black' : 'text-white/90 hover:bg-white/10'
      }`}
      title={label}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div className="fixed inset-0 z-[60] bg-black flex flex-col animate-fadeIn">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3 bg-black">
        <button type="button" onClick={onCancel} className="text-white/90 font-heading text-sm px-3 py-1.5 rounded hover:bg-white/10">
          Cancel
        </button>
        <span className="text-white/70 text-xs font-heading">Mark up · pinch to resize</span>
        <button type="button" onClick={clearAll} disabled={count === 0} className="text-white/90 font-heading text-sm px-3 py-1.5 rounded hover:bg-white/10 disabled:opacity-30">
          Clear
        </button>
      </div>

      {/* Canvas */}
      <div className="flex-1 min-h-0 relative flex items-center justify-center p-2 overflow-hidden">
        {loadError ? (
          <div className="text-white/80 text-sm text-center px-6">
            Couldn’t open this photo for markup in your browser.
          </div>
        ) : (
          <canvas
            ref={canvasRef}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            style={{ touchAction: 'none' }}
            className="max-w-full max-h-full rounded cursor-crosshair"
          />
        )}
        {/* Live brush-size indicator while pinching */}
        {showSize && (
          <div className="absolute left-1/2 top-4 -translate-x-1/2 bg-black/70 text-white px-4 py-2 rounded-full flex items-center gap-3 pointer-events-none">
            <span
              className="rounded-full inline-block"
              style={{
                width: Math.max(4, Math.min(28, Math.round(8 * widthScale))),
                height: Math.max(4, Math.min(28, Math.round(8 * widthScale))),
                backgroundColor: color,
                boxShadow: color === '#ffffff' ? '0 0 0 1px rgba(255,255,255,0.4)' : undefined,
              }}
            />
            <span className="text-xs font-heading">Brush ×{widthScale.toFixed(1)}</span>
          </div>
        )}
      </div>

      {/* Toolbar (wraps on narrow screens so Save never clips off the edge) */}
      <div className="bg-black px-3 py-3 flex flex-wrap items-center justify-between gap-x-2 gap-y-2">
        <div className="flex items-center gap-1">
          {toolBtn('arrow', 'Arrow', (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="19" x2="19" y2="5" /><polyline points="9 5 19 5 19 15" />
            </svg>
          ))}
          {toolBtn('circle', 'Circle', (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /></svg>
          ))}
          {toolBtn('pen', 'Pen', (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19l7-7 3 3-7 7-3-3z" /><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" /><path d="M2 2l7.586 7.586" /><circle cx="11" cy="11" r="2" />
            </svg>
          ))}
        </div>

        <div className="flex items-center gap-1.5">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              aria-label={`Color ${c}`}
              className={`w-6 h-6 rounded-full border-2 ${color === c ? 'border-white scale-110' : 'border-white/30'}`}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>

        <div className="flex items-center gap-1">
          <button type="button" onClick={undo} disabled={count === 0} className="text-white/90 px-2.5 py-1.5 rounded text-[11px] font-heading hover:bg-white/10 disabled:opacity-30">Undo</button>
          <button type="button" onClick={save} disabled={!ready} className="bg-brand text-white font-heading font-semibold px-4 py-1.5 rounded text-[11px] disabled:opacity-40">Save</button>
        </div>
      </div>
    </div>
  );
}
