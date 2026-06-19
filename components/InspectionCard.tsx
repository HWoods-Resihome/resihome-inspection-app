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

// Compact "M-DD-YY" date (month not zero-padded, day + year two digits) for the
// card meta row. HubSpot returns Date fields as epoch-ms strings and DateTime /
// built-in fields (hs_createdate) as ISO 8601 — handle both, in UTC so the
// displayed day matches the stored date regardless of viewer timezone.
function fmtShort(raw: string | null): string {
  if (!raw) return '';
  const d = /^\d+$/.test(raw) ? new Date(Number(raw)) : new Date(raw);
  if (isNaN(d.getTime())) return '';
  const m = d.getUTCMonth() + 1;
  const day = String(d.getUTCDate()).padStart(2, '0');
  const yy = String(d.getUTCFullYear()).slice(-2);
  return `${m}-${day}-${yy}`;
}

// Whole-dollar currency for the card's "Client: $x" figure.
function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

// Show the client-billable total on rate-card-style cards: a Scope Rate Card
// once it has lines (In Progress / Pending Approval / Completed), and every
// Turn Re-Inspect QC (whose total is the SOURCE scope's client total, enriched
// server-side). Scheduled scopes have no lines yet, so they're omitted.
function clientTotalToShow(i: InspectionSummary): number | null {
  if (i.totalClientCost == null) return null;
  if (i.templateType === 'pm_turn_reinspect_qc') return i.totalClientCost;
  if (i.templateType === 'pm_scope_rate_card') {
    const s = (i.status || '').trim().toLowerCase();
    const scheduled = s === 'scheduled';
    return scheduled ? null : i.totalClientCost;
  }
  return null;
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
  const clientTotal = clientTotalToShow(i);
  const tmpl = templateLabel(i.templateType);

  const { street, locality } = splitAddress(i.propertyAddressSnapshot || i.inspectionName);
  const isReinspect = i.templateType === 'pm_turn_reinspect_qc';
  // Date on the left: the scheduled date ONLY while the inspection is still
  // Scheduled (the planned visit is the meaningful date then); once work starts
  // it switches to the last-updated date.
  const isScheduled = (i.status || '').trim().toLowerCase() === 'scheduled';
  const dateLabel = isScheduled ? 'Scheduled' : 'Updated';
  const dateValue = fmtShort(isScheduled ? (i.scheduledDate || i.updatedAt) : i.updatedAt);

  const inner = (
    <>
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex-1 min-w-0">
          {tmpl && (
            <p className="text-[13px] font-heading font-bold uppercase tracking-wide text-brand mb-1 truncate">
              {tmpl}
              {/* Client-billable total alongside the template, kept in brand pink
                  but smaller/lighter so the template name stays the standout. */}
              {clientTotal != null && (
                <span className="text-[11px] font-semibold"> ({fmtMoney(clientTotal)})</span>
              )}
            </p>
          )}
          <h3 className="font-bold text-[15px] text-ink break-words leading-snug">
            {street}
          </h3>
          {locality && (
            <p className="text-[13px] text-gray-500 break-words leading-snug mt-0.5">
              {locality}
            </p>
          )}
        </div>
        <div className="shrink-0 flex flex-col items-end gap-1.5">
          <StatusBadge status={i.status} />
          {/* Overall QC outcome for a Turn Re-Inspect — plain colored text with a
              glyph (not a filled pill) so a Pass doesn't read as green-on-green
              next to the green Completed badge. */}
          {isReinspect && i.qcVerdict && (
            <span className={`inline-flex items-center gap-0.5 text-[11px] font-heading font-bold ${
              i.qcVerdict === 'pass' ? 'text-emerald-600' : 'text-red-600'
            }`}>
              {i.qcVerdict === 'pass' ? '✓ Pass' : '✕ Fail'}
            </span>
          )}
        </div>
      </div>
      {/* Meta row: date (left) · property status (center, muted, truncates) ·
          inspector (right). Keeping the status here — not on the address line —
          stops it muddying the address and never adds a second line. */}
      <div className="flex items-center justify-between gap-2 text-xs text-gray-500">
        {dateValue
          ? <span className="shrink-0 whitespace-nowrap">{dateLabel} {dateValue}</span>
          : <span />}
        {i.propertyStatus && (
          <span className="min-w-0 flex-1 truncate text-center text-gray-400" title={i.propertyStatus}>
            {i.propertyStatus}
          </span>
        )}
        {i.inspectorName && <span className="shrink-0 truncate text-right max-w-[42%]">{i.inspectorName}</span>}
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
