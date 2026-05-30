/**
 * PhotoLightbox — full-screen photo viewer launched from the inspection view.
 *
 * - Swipe (or arrows) to move between photos in the current room.
 * - Room dropdown in the header to jump to another room's photos.
 * - "Mark up" opens the annotator (loads the photo through /api/photo-proxy so
 *   the canvas isn't cross-origin tainted; saving re-uploads + replaces it).
 * - Delete removes the current photo.
 */
import { useEffect, useRef, useState } from 'react';
import { PhotoAnnotator } from '@/components/PhotoAnnotator';
import { displayImageSrc } from '@/lib/photoDisplay';

interface Props {
  rooms: { id: string; name: string }[];
  photosBySection: Record<string, string[]>;
  initialSectionId: string;
  initialIndex: number;
  readOnly?: boolean;
  onClose: () => void;
  onDelete: (sectionId: string, index: number) => void;
  onReplace: (sectionId: string, index: number, file: File) => void;
}

export function PhotoLightbox({
  rooms, photosBySection, initialSectionId, initialIndex, readOnly, onClose, onDelete, onReplace,
}: Props) {
  const [sectionId, setSectionId] = useState(initialSectionId);
  const [index, setIndex] = useState(initialIndex);
  const [annotating, setAnnotating] = useState(false);
  const swipeStartX = useRef<number | null>(null);

  const photos = photosBySection[sectionId] || [];
  const room = rooms.find((r) => r.id === sectionId);

  // Clamp the index if the current room's photo list shrinks (e.g. after a
  // delete) or we switch rooms.
  useEffect(() => {
    if (photos.length === 0) { onClose(); return; }
    if (index > photos.length - 1) setIndex(photos.length - 1);
  }, [photos.length, index, onClose]);

  const prev = () => setIndex((i) => (i > 0 ? i - 1 : i));
  const next = () => setIndex((i) => (i < photos.length - 1 ? i + 1 : i));

  function onPointerDown(e: React.PointerEvent) { swipeStartX.current = e.clientX; }
  function onPointerUp(e: React.PointerEvent) {
    if (swipeStartX.current == null) return;
    const dx = e.clientX - swipeStartX.current;
    swipeStartX.current = null;
    if (dx > 45) prev();
    else if (dx < -45) next();
  }

  const url = photos[index];

  return (
    <div className="fixed inset-0 z-[55] bg-black flex flex-col">
      {/* Header: room dropdown + position + close */}
      <div className="flex items-center justify-between gap-2 px-3 py-3 bg-black">
        <select
          value={sectionId}
          onChange={(e) => { setSectionId(e.target.value); setIndex(0); }}
          className="bg-white/10 text-white text-sm font-heading rounded px-2 py-1.5 max-w-[55%]"
          aria-label="Switch room"
        >
          {rooms.map((r) => {
            const n = (photosBySection[r.id] || []).length;
            return <option key={r.id} value={r.id} className="text-black">{r.name}{n ? ` (${n})` : ''}</option>;
          })}
        </select>
        <span className="text-white/70 text-xs font-heading">{photos.length ? `${index + 1} / ${photos.length}` : ''}</span>
        <button type="button" onClick={onClose} className="text-white text-2xl leading-none px-2" aria-label="Close">×</button>
      </div>

      {/* Image + swipe + arrows */}
      <div
        className="flex-1 min-h-0 relative flex items-center justify-center overflow-hidden select-none"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        style={{ touchAction: 'pan-y' }}
      >
        {url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={displayImageSrc(url)} alt="" className="max-w-full max-h-full object-contain" draggable={false} />
        )}
        {index > 0 && (
          <button type="button" onClick={prev} aria-label="Previous"
            className="absolute left-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/50 text-white text-2xl leading-none flex items-center justify-center">‹</button>
        )}
        {index < photos.length - 1 && (
          <button type="button" onClick={next} aria-label="Next"
            className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/50 text-white text-2xl leading-none flex items-center justify-center">›</button>
        )}
      </div>

      {/* Actions */}
      <div className="bg-black px-4 py-3 flex items-center justify-center gap-3">
        {!readOnly && (
          <>
            <button type="button" onClick={() => setAnnotating(true)}
              className="flex items-center gap-2 bg-white/15 hover:bg-white/25 text-white font-heading text-sm px-4 py-2 rounded-lg">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19l7-7 3 3-7 7-3-3z" /><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" /><path d="M2 2l7.586 7.586" /><circle cx="11" cy="11" r="2" />
              </svg>
              Mark up
            </button>
            <button type="button"
              onClick={() => { onDelete(sectionId, index); }}
              className="flex items-center gap-2 bg-white/10 hover:bg-red-600/70 text-white font-heading text-sm px-4 py-2 rounded-lg">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
              Delete
            </button>
          </>
        )}
      </div>

      {annotating && url && (
        <PhotoAnnotator
          src={`/api/photo-proxy?url=${encodeURIComponent(url)}`}
          onCancel={() => setAnnotating(false)}
          onSave={(file) => { setAnnotating(false); onReplace(sectionId, index, file); }}
        />
      )}
    </div>
  );
}
