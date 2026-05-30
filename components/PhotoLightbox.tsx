/**
 * PhotoLightbox — full-screen photo viewer launched from the inspection view.
 *
 * Works over photo "groups" (a room's section photos, or a single line item's
 * photos):
 *  - Drag/swipe the photo (finger-following carousel that snaps) or use arrows.
 *  - Group dropdown in the header to jump to another group (e.g. another room).
 *  - "Mark up" opens the annotator (loads via /api/photo-proxy so the canvas
 *    isn't cross-origin tainted; saving re-uploads + replaces it).
 *  - "Tag to line" (when tagLinesByGroup is provided) links the photo to a line
 *    item without removing it from the room.
 *  - Delete removes the current photo (with a brief "Photo deleted" toast).
 */
import { useEffect, useRef, useState } from 'react';
import { PhotoAnnotator } from '@/components/PhotoAnnotator';
import { displayImageSrc } from '@/lib/photoDisplay';

interface Props {
  groups: { id: string; name: string }[];
  photosByGroup: Record<string, string[]>;
  initialGroupId: string;
  initialIndex: number;
  readOnly?: boolean;
  onClose: () => void;
  onDelete: (groupId: string, index: number) => void;
  onReplace: (groupId: string, index: number, file: File) => void;
  // Optional tag-to-line (only meaningful for room/section groups).
  tagLinesByGroup?: Record<string, { externalId: string; label: string }[]>;
  onTagToLine?: (groupId: string, index: number, lineExternalId: string) => void;
}

export function PhotoLightbox({
  groups, photosByGroup, initialGroupId, initialIndex, readOnly,
  onClose, onDelete, onReplace, tagLinesByGroup, onTagToLine,
}: Props) {
  const [groupId, setGroupId] = useState(initialGroupId);
  const [index, setIndex] = useState(initialIndex);
  const [annotating, setAnnotating] = useState(false);
  const [tagged, setTagged] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Carousel drag state.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [cw, setCw] = useState(0);
  const [dragPx, setDragPx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragStartX = useRef<number | null>(null);
  const pointerIdRef = useRef<number | null>(null);

  const photos = photosByGroup[groupId] || [];
  const tagLines = tagLinesByGroup?.[groupId] || [];

  // Track container width so we can translate the carousel in pixels.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') { if (el) setCw(el.clientWidth); return; }
    const update = () => setCw(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Clamp / close if the current group's photo list shrinks (e.g. after delete).
  useEffect(() => {
    if (photos.length === 0) { onClose(); return; }
    if (index > photos.length - 1) setIndex(photos.length - 1);
  }, [photos.length, index, onClose]);

  useEffect(() => { setTagged(null); }, [groupId, index]);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const prev = () => setIndex((i) => (i > 0 ? i - 1 : i));
  const next = () => setIndex((i) => (i < photos.length - 1 ? i + 1 : i));

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 1300);
  }

  function onPointerDown(e: React.PointerEvent) {
    dragStartX.current = e.clientX;
    pointerIdRef.current = e.pointerId;
    setDragging(true);
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* noop */ }
  }
  function onPointerMove(e: React.PointerEvent) {
    if (dragStartX.current == null) return;
    setDragPx(e.clientX - dragStartX.current);
  }
  function onPointerUp() {
    if (dragStartX.current == null) { setDragging(false); return; }
    const threshold = Math.min(80, (cw || 300) * 0.18);
    if (dragPx < -threshold && index < photos.length - 1) setIndex((i) => i + 1);
    else if (dragPx > threshold && index > 0) setIndex((i) => i - 1);
    dragStartX.current = null;
    pointerIdRef.current = null;
    setDragPx(0);
    setDragging(false);
  }

  function handleDelete(e: React.MouseEvent) {
    onDelete(groupId, index);
    showToast('Photo deleted');
    (e.currentTarget as HTMLElement).blur(); // clear the sticky touch highlight
  }

  const url = photos[index];

  return (
    <div className="fixed inset-0 z-[55] bg-black flex flex-col">
      {/* Header: group dropdown + position + close */}
      <div className="flex items-center justify-between gap-2 px-3 py-3 bg-black">
        <select
          value={groupId}
          onChange={(e) => { setGroupId(e.target.value); setIndex(0); setDragPx(0); }}
          className="bg-white/10 text-white text-sm font-heading rounded px-2 py-1.5 max-w-[55%]"
          aria-label="Switch group"
        >
          {groups.map((g) => {
            const n = (photosByGroup[g.id] || []).length;
            return <option key={g.id} value={g.id} className="text-black">{g.name}{n ? ` (${n})` : ''}</option>;
          })}
        </select>
        <span className="text-white/70 text-xs font-heading">{photos.length ? `${index + 1} / ${photos.length}` : ''}</span>
        <button type="button" onClick={onClose} className="text-white text-2xl leading-none px-2" aria-label="Close">×</button>
      </div>

      {/* Carousel: finger-following track that snaps */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 relative overflow-hidden select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{ touchAction: 'pan-y' }}
      >
        <div
          className="flex h-full"
          style={{
            transform: `translateX(${-index * cw + dragPx}px)`,
            transition: dragging ? 'none' : 'transform 220ms ease-out',
          }}
        >
          {photos.map((p, i) => (
            <div key={`${p}-${i}`} className="h-full shrink-0 flex items-center justify-center" style={{ width: cw || '100%' }}>
              {/* Only render images near the current index to keep it light. */}
              {Math.abs(i - index) <= 1 ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={displayImageSrc(p)} alt="" className="max-w-full max-h-full object-contain" draggable={false} />
              ) : null}
            </div>
          ))}
        </div>

        {index > 0 && (
          <button type="button" onClick={prev} aria-label="Previous"
            className="absolute left-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/40 text-white text-2xl leading-none flex items-center justify-center">‹</button>
        )}
        {index < photos.length - 1 && (
          <button type="button" onClick={next} aria-label="Next"
            className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/40 text-white text-2xl leading-none flex items-center justify-center">›</button>
        )}

        {/* Transient toast */}
        {toast && (
          <div className="absolute left-1/2 bottom-6 -translate-x-1/2 bg-black/70 text-white text-sm font-heading px-4 py-2 rounded-full pointer-events-none">
            {toast}
          </div>
        )}
      </div>

      {/* Actions — all on one line, with Return at the far right */}
      <div className="bg-black px-2 py-3 flex items-center gap-2">
        {!readOnly && (
          <>
            <button type="button" onClick={() => setAnnotating(true)} title="Mark up"
              className="shrink-0 flex items-center gap-2 h-11 px-3 bg-white/15 active:bg-white/30 text-white font-heading text-sm rounded-lg">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19l7-7 3 3-7 7-3-3z" /><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" /><path d="M2 2l7.586 7.586" /><circle cx="11" cy="11" r="2" />
              </svg>
              <span className="hidden sm:inline">Mark up</span>
            </button>
            <button type="button" onClick={handleDelete} title="Delete"
              className="shrink-0 flex items-center gap-2 h-11 px-3 bg-white/10 active:bg-red-600/80 text-white font-heading text-sm rounded-lg">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
              <span className="hidden sm:inline">Delete</span>
            </button>
          </>
        )}

        {/* Tag to line (rooms only) — fills the middle */}
        {!readOnly && onTagToLine && tagLines.length > 0 ? (
          <select
            value=""
            onChange={(e) => {
              const id = e.target.value;
              if (!id) return;
              onTagToLine(groupId, index, id);
              const lbl = tagLines.find((l) => l.externalId === id)?.label || 'line';
              setTagged(lbl);
              showToast(`Tagged to ${lbl}`);
              e.currentTarget.value = '';
            }}
            className="flex-1 min-w-0 h-11 bg-white/10 text-white text-sm font-heading rounded-lg px-3"
            aria-label="Tag this photo to a line item"
          >
            <option value="" className="text-black">{tagged ? `Tagged → ${tagged}` : 'Tag to a line item…'}</option>
            {tagLines.map((l) => (
              <option key={l.externalId} value={l.externalId} className="text-black">{l.label}</option>
            ))}
          </select>
        ) : (
          <div className="flex-1" />
        )}

        <button type="button" onClick={onClose} title="Return" aria-label="Return"
          className="shrink-0 flex items-center gap-2 h-11 px-3 bg-white/15 active:bg-white/30 text-white font-heading text-sm rounded-lg">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 14 4 9 9 4" /><path d="M20 20v-7a4 4 0 0 0-4-4H4" />
          </svg>
          <span className="hidden sm:inline">Return</span>
        </button>
      </div>

      {annotating && url && (
        <PhotoAnnotator
          src={`/api/photo-proxy?url=${encodeURIComponent(url)}`}
          onCancel={() => setAnnotating(false)}
          onSave={(file) => { setAnnotating(false); onReplace(groupId, index, file); }}
        />
      )}
    </div>
  );
}
