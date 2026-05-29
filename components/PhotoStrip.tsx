import { useState } from 'react';

interface PhotoStripProps {
  /** Section/group title shown on the collapsible header (e.g. "Before"). */
  label: string;
  photoUrls: string[];
  /** Thumbnail size in px. QC (side-by-side, narrow) uses a smaller size. */
  size?: number;
  /** Optional remove handler — when provided, each thumb gets an × button. */
  onRemove?: (url: string) => void;
  /** Optional tint for the label/border (e.g. teal for After). */
  accent?: 'gray' | 'teal' | 'brand';
  /** Optional extra controls rendered under the strip (e.g. Take/Upload). */
  children?: React.ReactNode;
  /** Message when there are no photos. */
  emptyLabel?: string;
  /** Start collapsed? Defaults to expanded. */
  defaultCollapsed?: boolean;
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
  label, photoUrls, size = 80, onRemove, accent = 'gray', children, emptyLabel, defaultCollapsed,
}: PhotoStripProps) {
  const [collapsed, setCollapsed] = useState(!!defaultCollapsed);
  const a = ACCENTS[accent];
  const count = photoUrls.length;

  return (
    <div>
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
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
              {photoUrls.map((u, i) => (
                <div key={`${u}-${i}`} className="relative shrink-0">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <a href={u} target="_blank" rel="noopener noreferrer">
                    <img
                      src={u}
                      alt={label}
                      style={{ width: size, height: size }}
                      className={`object-cover rounded border ${a.thumb}`}
                    />
                  </a>
                  {onRemove && (
                    <button
                      type="button"
                      onClick={() => onRemove(u)}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-white border border-gray-300 rounded-full text-gray-600 text-xs leading-none shadow"
                      title="Remove photo"
                    >&times;</button>
                  )}
                </div>
              ))}
            </div>
          )}
          {children && <div className="mt-2">{children}</div>}
        </>
      )}
    </div>
  );
}
