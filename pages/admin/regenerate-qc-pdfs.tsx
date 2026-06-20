/**
 * /admin/regenerate-qc-pdfs  (admin only)
 *
 * Live-progress runner for the Turn Re-Inspect QC PDFs. Same UX as the Scope and
 * Q&A regenerate pages: single-inspection preview, bounded-concurrency run with
 * auto-retry, progress bar + live log, and CSV export.
 */
import { RegenPdfRunner } from '@/components/admin/RegenPdfRunner';

export default function RegenerateQcPdfsPage() {
  return (
    <RegenPdfRunner
      title="Regenerate QC PDFs"
      apiBase="/api/admin/regenerate-qc-pdfs"
      noun="Turn Re-Inspect QC inspections"
      description={
        <>
          Re-renders the Turn Re-Inspect QC report <b>in place</b> from saved answers
          (before/after photos, line pass/fail, header verdict) — to retrofit PDF format
          changes (e.g. capitalized Bed/Bath, region removed). It never changes status or
          sends any email/ticket.
        </>
      }
    />
  );
}
