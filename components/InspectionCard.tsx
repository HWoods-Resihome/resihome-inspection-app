import Link from 'next/link';
import type { InspectionSummary } from '@/lib/types';
import { StatusBadge } from './StatusBadge';

interface Props {
  inspection: InspectionSummary;
  // Bulk-select mode (home page). When selectMode is true the card shows a
  // checkbox and tapping toggles selection instead of navigating.
  selectMode?: boolean;
  selected?: boolean;
  selectable?: boolean;   // false for completed inspections (can't be cancelled)
  onToggleSelect?: (recordId: string) => void;
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

// Pretty template type: "pm_scope_inspection" -> "PM Scope"
// Known templates use a canonical short label; unknown ones fall back to the
// generated form. Keeps acronyms (QC) and hyphenation (Re-Inspect) correct.
const SHORT_LABELS: Record<string, string> = {
  pm_scope_rate_card: 'Scope Rate Card',
  pm_turn_reinspect_qc: 'Turn Re-Inspect QC',
  pm_community_inspection: 'Community',
  pm_vacancy_occupancy_check: 'Vacancy / Occupancy Check',
  qc_new_construction_rrqc: 'QC New Construction',
  leasing_agent_1099_property_inspection: 'Leasing Agent 1099 Property',
  // Legacy template types — retired from the app but kept here so historical
  // records created under them still show a clean label (not auto-generated).
  pm_scope_inspection: 'Scope',
  pm_turn_inspection: 'Turn',
};
const ACRONYMS = new Set(['QC', 'PM', 'RRQC', '1099']);
function prettyTemplate(t: string): string {
  if (!t) return '';
  if (SHORT_LABELS[t]) return SHORT_LABELS[t];
  return t
    .replace(/^pm_/, '')
    .replace(/^qc_/, 'QC ')
    .replace(/_inspection$/, '')
    .replace(/_/g, ' ')
    .split(' ')
    .map((w) => {
      const up = w.toUpperCase();
      if (ACRONYMS.has(up)) return up;
      return w.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('-');
    })
    .join(' ');
}

export function InspectionCard({ inspection: i, selectMode, selected, selectable, onToggleSelect }: Props) {
  const date = effectiveDate(i);
  const updated = fmtDate(i.updatedAt);
  const tmpl = prettyTemplate(i.templateType);

  // Progress: only show if we have data (Completed inspections always have it;
  // Scheduled inspections don't).
  // total_questions_answered is set at submit, so it's only meaningful for Completed/In Progress.
  const hasProgress = i.totalQuestionsAnswered != null && i.totalQuestionsAnswered > 0;

  const { street, locality } = splitAddress(i.propertyAddressSnapshot || i.inspectionName);

  const inner = (
    <>
      <div className="flex items-start justify-between gap-3 mb-1.5">
        <div className="flex-1 min-w-0">
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
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-gray-500">
        {date && <span>{date}</span>}
        {updated && (
          <>
            {date && <span>&middot;</span>}
            <span className="text-gray-400">Updated {updated}</span>
          </>
        )}
        {(date || updated) && i.inspectorName && <span>&middot;</span>}
        {i.inspectorName && <span>{i.inspectorName}</span>}
        {tmpl && (
          <>
            <span>&middot;</span>
            <span>{tmpl}</span>
          </>
        )}
      </div>
      {hasProgress && (
        <div className="mt-2">
          <div className="text-xs text-gray-500 font-heading">
            {i.totalQuestionsAnswered} answers
          </div>
        </div>
      )}
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

  // ---- Normal mode: navigate to the inspection ----
  return (
    <Link
      href={`/inspection/${i.recordId}`}
      className="block bg-white border border-gray-200 rounded-xl p-4 mb-3 shadow-sm hover:border-brand/40 hover:shadow-md transition active:scale-[0.995]"
    >
      {inner}
    </Link>
  );
}
