/**
 * Completed-inspections table: Inspector / Date / Type / Status + a link to the
 * report when reportUrl is present. Honors the global filters (rows are already
 * filtered by the Dashboard). Header is sticky so it stays put while the body
 * scrolls inside the card. CSV export builds an Excel-openable .csv via a Blob
 * download — no heavy xlsx dependency.
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

export function CompletedTable({ rows }: { rows: InsightsRow[] }) {
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
      className="text-[11px] font-heading font-semibold text-[#f4f4f5] bg-[#232329] border border-white/10 rounded-full px-3 py-1 hover:border-[#ff0060] disabled:opacity-40 disabled:hover:border-white/10"
    >
      Export CSV
    </button>
  );

  return (
    <CardFrame
      title="Completed Inspections" subtitle={`${completed.length} total`} icon={ICON} headerRight={exportBtn}
      bodyClassName="px-0 pb-0 max-h-[420px] overflow-auto"
    >
      {completed.length === 0 ? (
        <CardNote>No completed inspections in the current filter.</CardNote>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left text-[11px] font-heading font-semibold uppercase tracking-wide text-[#a1a1aa] sticky top-0 bg-[#232329]">
              <th className="py-2 pl-4 pr-2">Inspector</th>
              <th className="py-2 px-2">Date</th>
              <th className="py-2 px-2">Type</th>
              <th className="py-2 px-2">Status</th>
              <th className="py-2 pr-4 pl-2 text-right">Report</th>
            </tr>
          </thead>
          <tbody>
            {completed.map((r) => (
              <tr key={r.recordId} className="border-b border-white/5 hover:bg-white/[0.03]">
                <td className="py-1.5 pl-4 pr-2">
                  <div className="text-[#f4f4f5] truncate max-w-[180px]" title={r.propertyAddress}>{r.inspectorLabel}</div>
                </td>
                <td className="py-1.5 px-2 text-[#a1a1aa] whitespace-nowrap">{fmtDate(r.date)}</td>
                <td className="py-1.5 px-2 text-[#a1a1aa] truncate max-w-[150px]" title={templateLabel(r.templateType)}>{templateLabel(r.templateType)}</td>
                <td className="py-1.5 px-2">
                  <span className="inline-block rounded-full bg-[#73E3DF]/15 text-[#73E3DF] font-heading font-semibold text-[11px] px-2 py-0.5 whitespace-nowrap">{r.statusLabel}</span>
                </td>
                <td className="py-1.5 pr-4 pl-2 text-right">
                  {r.reportUrl
                    ? <a href={r.reportUrl} target="_blank" rel="noopener noreferrer" className="text-[#ff0060] font-heading font-semibold hover:underline text-xs">Open</a>
                    : <span className="text-[#71717a] text-xs">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </CardFrame>
  );
}
