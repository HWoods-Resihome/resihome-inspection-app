/**
 * /admin/regenerate-pdfs  (admin only)
 *
 * One combined PDF-regeneration tool: pick which inspection TYPES to regenerate
 * (Scope, 1099, Vacancy/Occupancy, Community/Visit, Turn Re-Inspect QC) and run
 * with live progress. Each id is dispatched to its own regenerate endpoint. PDFs
 * are rebuilt in place — no status change, no email/ticket.
 */
import { RegenPdfPicker } from '@/components/admin/RegenPdfPicker';

export default function RegeneratePdfsPage() {
  return <RegenPdfPicker />;
}
