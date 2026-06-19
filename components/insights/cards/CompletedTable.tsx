/**
 * Completed-inspections table: Inspector / Date / Type / Status + a link to the
 * report when reportUrl is present. Honors the global filters (rows are already
 * filtered by the Dashboard). CSV export builds an Excel-openable .csv via a
 * Blob download — no heavy xlsx dependency.
 */
import { templateLabel } from '@/lib/templateLabels';
import { CardFrame, CardNote } from '../cardChrome';
import { completedRows, fmtDate } from '@/lib/insightsMetrics';
import type { InsightsRow } from '@/lib/insightsSnapshot';

const ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>
);

/** RFC-4180-ish CSV cell: quote and escape embedded quotes. */
function csvCell(v: string): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function CompletedTable({ rows, onRemove }: { rows: InsightsRow[]; onRemove?: () => void }) {
  const completed = completedRows(rows);

  function exportCsv() {
    const header = ['Inspector', 'Email', 'Date', 'Type', 'Status', 'Property', 'Report URL'];
    const lines = [header.map(csvCell).join(',')];
    for (const r of completed) {
      lines.push([
        r.inspectorLabel, r.inspectorEmail, fmtDate(r.date),
        templateLabel(r.templateType), r.statusLabel, r.propertyAddress, r.reportUrl || '',
      ].map(csvCell).join(','));
    }
    // BOM so Excel detects UTF-8.
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `completed-inspections-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const exportBtn = (
    <button
      type="button" onClick={exportCsv} disabled={completed.length === 0}
      className="text-[11px] font-heading font-semibold text-brand hover:underline disabled:text-gray-300"
    >
      Export CSV
    </button>
  );

  return (
    <CardFrame title="Completed inspections" icon={ICON} onRemove={onRemove} headerRight={exportBtn}>
      {completed.length === 0 ? (
        <CardNote>No completed inspections in the current filter.</CardNote>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left text-[11px] font-heading font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200 sticky top-0 bg-white">
              <th className="py-1.5 pr-2">Inspector</th>
              <th className="py-1.5 px-2">Date</th>
              <th className="py-1.5 px-2">Type</th>
              <th className="py-1.5 px-2">Status</th>
              <th className="py-1.5 pl-2 text-right">Report</th>
            </tr>
          </thead>
          <tbody>
            {completed.map((r) => (
              <tr key={r.recordId} className="border-b border-gray-50 hover:bg-gray-50/60">
                <td className="py-1.5 pr-2">
                  <div className="text-gray-800 truncate max-w-[150px]" title={r.propertyAddress}>{r.inspectorLabel}</div>
                </td>
                <td className="py-1.5 px-2 text-gray-600 whitespace-nowrap">{fmtDate(r.date)}</td>
                <td className="py-1.5 px-2 text-gray-600 truncate max-w-[140px]" title={templateLabel(r.templateType)}>{templateLabel(r.templateType)}</td>
                <td className="py-1.5 px-2">
                  <span className="inline-block rounded-full bg-accent/20 text-gray-700 font-heading font-semibold text-[11px] px-2 py-0.5 whitespace-nowrap">{r.statusLabel}</span>
                </td>
                <td className="py-1.5 pl-2 text-right">
                  {r.reportUrl
                    ? <a href={r.reportUrl} target="_blank" rel="noopener noreferrer" className="text-brand font-heading font-semibold hover:underline text-xs">Open</a>
                    : <span className="text-gray-300 text-xs">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </CardFrame>
  );
}
