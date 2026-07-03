import { useState } from 'react';
import { PhotoThumb } from '@/components/PhotoThumb';
import { isVideoEntry, playableVideoSrc } from '@/lib/media';
import { SyncingBadge } from '@/components/SyncingBadge';

interface PhotoStripProps {
  /** Section/group title shown on the collapsible header (e.g. "Before"). */
  label: React.ReactNode;
  photoUrls: string[];
  /** Thumbnail size in px. QC (side-by-side, narrow) uses a smaller size. */
  size?: number;
  /** Optional remove handler — when provided, each thumb gets an × button. */
  onRemove?: (url: string) => void;
  /** Optional click handler — when provided, tapping a thumb calls this (with
   *  its index) instead of opening the file in a new tab (used to open a
   *  lightbox with swipe/markup/delete/tag). */
  onPhotoClick?: (index: number) => void;
  /** Optional tint for the label/border (e.g. teal for After). */
  accent?: 'gray' | 'teal' | 'brand';
  /** Optional extra controls rendered under the strip (e.g. Take/Upload). */
  children?: React.ReactNode;
  /** Message when there are no photos. */
  emptyLabel?: string;
  /** Start collapsed? Defaults to expanded. (uncontrolled mode) */
  defaultCollapsed?: boolean;
  /** Controlled collapse: when provided, the parent owns the state (used to
   *  link Before/After so they collapse together). */
  collapsed?: boolean;
  onToggle?: () => void;
}

const ACCENTS = {
  gray: { text: 'text-gray-500', border: 'border-gray-200', thumb: 'border-gray-200' },
  teal: { text: 'text-teal-700', border: 'border-teal-200', thumb: 'border-teal-200' },
  brand: { text: 'text-brand', border: 'border-brand/30', thumb: 'border-brand/30' },
} as const;

/**
 * A single-line, horizontally-scrolling photo strip with a collapsible header.
 * Shared across all inspection types so photos take up one row (extra photos
 * are reachable by horizontal scroll + tap to open full size) on both mobile
 * and desktop.
 */
export function PhotoStrip({
  label, photoUrls, size = 80, onRemove, onPhotoClick, accent = 'gray', children, emptyLabel,
  defaultCollapsed, collapsed: collapsedProp, onToggle,
}: PhotoStripProps) {
  const [collapsedState, setCollapsedState] = useState(!!defaultCollapsed);
  const isControlled = collapsedProp !== undefined;
  const collapsed = isControlled ? collapsedProp : collapsedState;
  const toggle = () => { if (isControlled) { onToggle?.(); } else { setCollapsedState((c) => !c); } };
  const a = ACCENTS[accent];
  const count = photoUrls.length;

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        className="w-full flex items-center justify-between mb-1.5 text-left"
      >
        <span className={`text-xs font-semibold uppercase tracking-wider ${a.text}`}>
          {label}
          {count > 0 && <span className="text-gray-400 normal-case font-normal"> ({count})</span>}
        </span>
        <span className={`text-gray-400 text-xs transition-transform ${collapsed ? '' : 'rotate-90'}`}>&#9654;</span>
      </button>

      {!collapsed && (
        <>
          {count === 0 ? (
            emptyLabel ? <div className="text-xs text-gray-400 mb-1">{emptyLabel}</div> : null
          ) : (
            <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-0.5 px-0.5">
              {photoUrls.map((u, i) => {
                const inner = (
                  <>
                    <PhotoThumb
                      url={u}
                      alt=""
                      style={{ width: size, height: size }}
                      className={`object-cover rounded border ${a.thumb}`}
                    />
                    {isVideoEntry(u) && (
                      <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                        <span className="w-7 h-7 rounded-full bg-black/55 flex items-center justify-center">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z" /></svg>
                        </span>
                      </span>
                    )}
                    {u.startsWith('blob:') && (
                      <SyncingBadge />
                    )}
                  </>
                );
                return (
                <div key={`${u}-${i}`} className="relative shrink-0">
                  {onPhotoClick ? (
                    <button type="button" onClick={() => onPhotoClick(i)} className="block cursor-pointer">{inner}</button>
                  ) : (
                    <a href={isVideoEntry(u) ? playableVideoSrc(u) : u} target="_blank" rel="noopener noreferrer" className="block">{inner}</a>
                  )}
                  {onRemove && (
                    <button
                      type="button"
                      onClick={() => onRemove(u)}
                      className="absolute top-0 right-0 z-10 w-6 h-6 bg-white border border-gray-300 rounded-full text-gray-600 text-sm leading-none flex items-center justify-center shadow"
                      title="Remove photo"
                    >&times;</button>
                  )}
                </div>
                );
              })}
            </div>
          )}
          {children && <div className="mt-2">{children}</div>}
        </>
      )}
    </div>
  );
}
