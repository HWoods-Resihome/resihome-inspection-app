/**
 * PhotoLightbox — full-screen photo viewer launched from the inspection view.
 *
 * Works over photo "groups" (a room's section photos, or a single line item's
 * photos):
 *  - Swipe (or arrows) to move between photos in the current group.
 *  - Group dropdown in the header to jump to another group (e.g. another room).
 *  - "Mark up" opens the annotator (loads via /api/photo-proxy so the canvas
 *    isn't cross-origin tainted; saving re-uploads + replaces it).
 *  - "Tag to line" (when tagLinesByGroup is provided) links the photo to a line
 *    item without removing it from the room.
 *  - Delete removes the current photo from the group.
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
  const swipeStartX = useRef<number | null>(null);

  const photos = photosByGroup[groupId] || [];
  const tagLines = tagLinesByGroup?.[groupId] || [];

  // Clamp / close if the current group's photo list shrinks (e.g. after delete).
  useEffect(() => {
    if (photos.length === 0) { onClose(); return; }
    if (index > photos.length - 1) setIndex(photos.length - 1);
  }, [photos.length, index, onClose]);

  // Reset the transient "Tagged ✓" note when the photo changes.
  useEffect(() => { setTagged(null); }, [groupId, index]);

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
      {/* Header: group dropdown + position + close */}
      <div className="flex items-center justify-between gap-2 px-3 py-3 bg-black">
        <select
          value={groupId}
          onChange={(e) => { setGroupId(e.target.value); setIndex(0); }}
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
      {!readOnly && (
        <div className="bg-black px-4 py-3 flex flex-col items-center gap-2">
          <div className="flex items-center justify-center gap-3">
            <button type="button" onClick={() => setAnnotating(true)}
              className="flex items-center gap-2 bg-white/15 hover:bg-white/25 text-white font-heading text-sm px-4 py-2 rounded-lg">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19l7-7 3 3-7 7-3-3z" /><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" /><path d="M2 2l7.586 7.586" /><circle cx="11" cy="11" r="2" />
              </svg>
              Mark up
            </button>
            <button type="button"
              onClick={() => onDelete(groupId, index)}
              className="flex items-center gap-2 bg-white/10 hover:bg-red-600/70 text-white font-heading text-sm px-4 py-2 rounded-lg">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
              Delete
            </button>
          </div>

          {/* Tag to line (rooms only) */}
          {onTagToLine && tagLines.length > 0 && (
            <div className="flex items-center gap-2">
              <select
                value=""
                onChange={(e) => {
                  const id = e.target.value;
                  if (!id) return;
                  onTagToLine(groupId, index, id);
                  const lbl = tagLines.find((l) => l.externalId === id)?.label || 'line';
                  setTagged(lbl);
                  e.currentTarget.value = '';
                }}
                className="bg-white/10 text-white text-sm font-heading rounded px-2 py-1.5 max-w-[70vw]"
                aria-label="Tag this photo to a line item"
              >
                <option value="" className="text-black">Tag to a line item…</option>
                {tagLines.map((l) => (
                  <option key={l.externalId} value={l.externalId} className="text-black">{l.label}</option>
                ))}
              </select>
              {tagged && <span className="text-emerald-400 text-xs font-heading whitespace-nowrap">Tagged ✓</span>}
            </div>
          )}
        </div>
      )}

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
