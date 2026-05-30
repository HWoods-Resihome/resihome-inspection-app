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
  const pointerIdRef = useRef<number | null>(null);

  const [tool, setTool] = useState<Tool>('arrow');
  const [color, setColor] = useState<string>('#ef4444');
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [count, setCount] = useState(0); // strokes count → re-render for undo state
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
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const head = s.width * 4.5;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - head * Math.cos(ang - Math.PI / 6), b.y - head * Math.sin(ang - Math.PI / 6));
      ctx.lineTo(b.x - head * Math.cos(ang + Math.PI / 6), b.y - head * Math.sin(ang + Math.PI / 6));
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
    if (!ready) return;
    e.preventDefault();
    const p = toImg(e);
    const t = toolRef.current; const col = colorRef.current;
    const w = strokeWidthFor(t);
    drawingRef.current = t === 'pen'
      ? { tool: 'pen', color: col, width: w, points: [p] }
      : { tool: t, color: col, width: w, a: p, b: p };
    pointerIdRef.current = e.pointerId;
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* noop */ }
    redraw();
  }
  function onMove(e: React.PointerEvent) {
    if (!drawingRef.current) return;
    e.preventDefault();
    const p = toImg(e);
    const d = drawingRef.current;
    if (d.tool === 'pen') d.points.push(p); else d.b = p;
    redraw();
  }
  function onUp(e: React.PointerEvent) {
    const d = drawingRef.current;
    if (!d) return;
    e.preventDefault();
    const keep = d.tool === 'pen'
      ? d.points.length > 1
      : Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y) > 4;
    if (keep) strokesRef.current.push(d);
    drawingRef.current = null;
    try { if (pointerIdRef.current != null) (e.currentTarget as Element).releasePointerCapture(pointerIdRef.current); } catch { /* noop */ }
    pointerIdRef.current = null;
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
    <div className="fixed inset-0 z-[60] bg-black flex flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3 bg-black">
        <button type="button" onClick={onCancel} className="text-white/90 font-heading text-sm px-3 py-1.5 rounded hover:bg-white/10">
          Cancel
        </button>
        <span className="text-white/70 text-xs font-heading">Mark up the photo</span>
        <button type="button" onClick={save} disabled={!ready} className="bg-brand text-white font-heading font-semibold text-sm px-4 py-1.5 rounded disabled:opacity-40">
          Save
        </button>
      </div>

      {/* Canvas */}
      <div className="flex-1 min-h-0 flex items-center justify-center p-2 overflow-hidden">
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
      </div>

      {/* Toolbar */}
      <div className="bg-black px-3 py-3 flex items-center justify-between gap-2">
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
              className={`w-7 h-7 rounded-full border-2 ${color === c ? 'border-white scale-110' : 'border-white/30'}`}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>

        <div className="flex items-center gap-1">
          <button type="button" onClick={undo} disabled={count === 0} className="text-white/90 px-2.5 py-1.5 rounded text-[11px] font-heading hover:bg-white/10 disabled:opacity-30">Undo</button>
          <button type="button" onClick={clearAll} disabled={count === 0} className="text-white/90 px-2.5 py-1.5 rounded text-[11px] font-heading hover:bg-white/10 disabled:opacity-30">Clear</button>
        </div>
      </div>
    </div>
  );
}
