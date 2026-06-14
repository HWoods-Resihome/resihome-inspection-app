import Link from 'next/link';
import { useRef } from 'react';
import type { InspectionSummary } from '@/lib/types';
import { StatusBadge } from './StatusBadge';
import { templateLabel } from '@/lib/templateLabels';

interface Props {
  inspection: InspectionSummary;
  // Bulk-select mode (home page). When selectMode is true the card shows a
  // checkbox and tapping toggles selection instead of navigating.
  selectMode?: boolean;
  selected?: boolean;
  selectable?: boolean;   // false for completed inspections (can't be cancelled)
  onToggleSelect?: (recordId: string) => void;
  // Press-and-hold (outside select mode) to enter bulk-select with this card
  // pre-selected.
  onLongPress?: (recordId: string) => void;
}

// Derive the most meaningful date to show on the card.
// Priority: scheduledDate (planned date) > completedAt > createdAt.
//
// HubSpot returns Date fields as Unix epoch milliseconds (as a string), while
// DateTime fields and built-in fields like hs_createdate come back as ISO 8601.
// Handle both formats.
function fmtDate(raw: string | null): string {
  if (!raw) return '';
  // Pure-digit string = epoch milliseconds (HubSpot Date field)
  if (/^\d+$/.test(raw)) {
    const d = new Date(Number(raw));
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  // Otherwise assume ISO 8601 ("2026-03-19T..." -> "2026-03-19")
  return raw.slice(0, 10);
}

function effectiveDate(i: InspectionSummary): string {
  return fmtDate(i.scheduledDate || i.completedAt || i.createdAt);
}

// Split the stored address snapshot into two display lines:
//   line 1: street address (everything before the first comma)
//   line 2: "City, State, Zip" (everything after the first comma)
// The snapshot is composed as "Street, City, State, Zip". If there's no comma
// (e.g. a bare name fallback), the whole thing goes on line 1 and line 2 is empty.
function splitAddress(snapshot: string): { street: string; locality: string } {
  const s = (snapshot || '').trim();
  const comma = s.indexOf(',');
  if (comma < 0) return { street: s, locality: '' };
  return {
    street: s.slice(0, comma).trim(),
    locality: s.slice(comma + 1).trim(),
  };
}

export function InspectionCard({ inspection: i, selectMode, selected, selectable, onToggleSelect, onLongPress }: Props) {
  const date = effectiveDate(i);
  const updated = fmtDate(i.updatedAt);
  const tmpl = templateLabel(i.templateType);

  const { street, locality } = splitAddress(i.propertyAddressSnapshot || i.inspectionName);

  const inner = (
    <>
      <div className="flex items-start justify-between gap-3 mb-1.5">
        <div className="flex-1 min-w-0">
          {tmpl && (
            <p className="text-[11px] font-heading font-semibold uppercase tracking-wide text-brand mb-0.5 truncate">
              {tmpl}
            </p>
          )}
          <h3 className="font-heading font-bold text-base text-ink break-words leading-snug">
            {street}
          </h3>
          {locality && (
            <p className="font-heading text-sm text-gray-600 break-words leading-snug mt-0.5">
              {locality}
            </p>
          )}
        </div>
        <div className="shrink-0">
          <StatusBadge status={i.status} />
        </div>
      </div>
      {/* One meta row: date · inspector on the left, Updated pushed to the right. */}
      <div className="flex items-center gap-x-2 text-xs text-gray-500 mt-0.5">
        {date && <span className="shrink-0">{date}</span>}
        {date && i.inspectorName && <span className="shrink-0">&middot;</span>}
        {i.inspectorName && <span className="truncate">{i.inspectorName}</span>}
        {updated && <span className="text-gray-400 ml-auto shrink-0 whitespace-nowrap">Updated {updated}</span>}
      </div>
    </>
  );

  // ---- Select mode: render as a togglable row (not a link) ----
  if (selectMode) {
    const canSelect = selectable !== false;
    return (
      <div
        onClick={() => canSelect && onToggleSelect?.(i.recordId)}
        className={
          'flex items-start gap-3 bg-white border rounded-xl p-4 mb-3 shadow-sm transition ' +
          (canSelect ? 'cursor-pointer ' : 'opacity-60 cursor-not-allowed ') +
          (selected ? 'border-brand ring-1 ring-brand/40' : 'border-gray-200')
        }
        title={canSelect ? undefined : 'Completed inspections cannot be cancelled'}
      >
        <div className="pt-0.5 shrink-0">
          <input
            type="checkbox"
            checked={!!selected}
            disabled={!canSelect}
            onChange={() => canSelect && onToggleSelect?.(i.recordId)}
            onClick={(e) => e.stopPropagation()}
            className="w-5 h-5 accent-brand cursor-pointer disabled:cursor-not-allowed"
          />
        </div>
        <div className="min-w-0 flex-1">{inner}</div>
      </div>
    );
  }

  // ---- Normal mode: navigate to the inspection (with press-and-hold to
  // enter bulk-select). A ~500ms hold fires onLongPress; a normal tap (which
  // releases sooner) navigates as usual. We swallow the click that follows a
  // long press so the hold doesn't also open the inspection.
  const lpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lpFired = useRef(false);
  const lpStart = useRef<{ x: number; y: number } | null>(null);

  const clearLp = () => { if (lpTimer.current) { clearTimeout(lpTimer.current); lpTimer.current = null; } };
  const onPointerDown = (e: React.PointerEvent) => {
    if (!onLongPress) return;
    lpFired.current = false;
    lpStart.current = { x: e.clientX, y: e.clientY };
    clearLp();
    lpTimer.current = setTimeout(() => {
      lpFired.current = true;
      try { navigator.vibrate?.(15); } catch { /* not supported */ }
      onLongPress(i.recordId);
    }, 500);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!lpTimer.current || !lpStart.current) return;
    // A scroll/drag cancels the hold.
    if (Math.abs(e.clientX - lpStart.current.x) > 10 || Math.abs(e.clientY - lpStart.current.y) > 10) clearLp();
  };

  return (
    <Link
      href={`/inspection/${i.recordId}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={clearLp}
      onPointerCancel={clearLp}
      onClick={(e) => { if (lpFired.current) { e.preventDefault(); e.stopPropagation(); lpFired.current = false; } }}
      onContextMenu={(e) => { if (onLongPress) e.preventDefault(); }}
      className="block select-none bg-white border border-gray-200 rounded-xl p-4 mb-3 shadow-sm hover:border-brand/40 hover:shadow-md transition active:scale-[0.995]"
      style={{ WebkitTouchCallout: 'none' }}
    >
      {inner}
    </Link>
  );
}
