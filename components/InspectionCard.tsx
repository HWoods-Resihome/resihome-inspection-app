import Link from 'next/link';
import type { InspectionSummary } from '@/lib/types';
import { StatusBadge } from './StatusBadge';

interface Props {
  inspection: InspectionSummary;
}

// Derive the most meaningful date to show on the card.
// Priority: scheduledDate (planned date) > completedAt > createdAt.
//
// HubSpot returns Date fields as Unix epoch milliseconds (as a string), while
// DateTime fields and built-in fields like hs_createdate come back as ISO 8601.
// Handle both formats.
function effectiveDate(i: InspectionSummary): string {
  const raw = i.scheduledDate || i.completedAt || i.createdAt;
  if (!raw) return '';
  // Pure-digit string = epoch milliseconds (HubSpot Date field)
  if (/^\d+$/.test(raw)) {
    const d = new Date(Number(raw));
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  // Otherwise assume ISO 8601 ("2026-03-19T..." -> "2026-03-19")
  return raw.slice(0, 10);
}

// Pretty template type: "pm_scope_inspection" -> "PM Scope"
function prettyTemplate(t: string): string {
  if (!t) return '';
  return t
    .replace(/^pm_/, '')
    .replace(/^qc_/, 'QC ')
    .replace(/_inspection$/, '')
    .replace(/_/g, ' ')
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function InspectionCard({ inspection: i }: Props) {
  const date = effectiveDate(i);
  const tmpl = prettyTemplate(i.templateType);

  // Progress: only show if we have data (Completed inspections always have it;
  // Scheduled inspections don't).
  // total_questions_answered is set at submit, so it's only meaningful for Completed/In Progress.
  const hasProgress = i.totalQuestionsAnswered != null && i.totalQuestionsAnswered > 0;

  return (
    <Link
      href={`/inspection/${i.recordId}`}
      className="block bg-white border border-gray-200 rounded-xl p-4 mb-3 shadow-sm hover:border-brand/40 hover:shadow-md transition active:scale-[0.995]"
    >
      <div className="flex items-start justify-between gap-3 mb-1.5">
        <h3 className="font-heading font-bold text-base text-ink truncate flex-1">
          {i.propertyAddressSnapshot || i.inspectionName}
        </h3>
        <div className="shrink-0">
          <StatusBadge status={i.status} />
        </div>
      </div>
      <div className="flex items-center gap-2 text-xs text-gray-500">
        {date && <span>{date}</span>}
        {date && i.inspectorName && <span>&middot;</span>}
        {i.inspectorName && <span className="truncate">{i.inspectorName}</span>}
        {tmpl && (
          <>
            <span>&middot;</span>
            <span className="truncate">{tmpl}</span>
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
    </Link>
  );
}
