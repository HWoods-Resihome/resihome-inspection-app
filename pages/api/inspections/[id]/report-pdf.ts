/**
 * GET /api/inspections/[id]/report-pdf — LIVE report render.
 *
 * Renders the question-driven inspection report (1099 / Vacancy / Community /
 * RRQC) from CURRENT HubSpot data on every request and streams it (no-store),
 * without touching the stored pdf_attachment_url. The in-app "View PDF Report"
 * points here so a report ALWAYS reflects the latest format/data with no manual
 * regeneration — the stored file remains for emailed/shared copies.
 *
 * Shares the exact build path as the admin regenerate tool (buildReportPdfBuffer),
 * so the live view and the stored file can never drift.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { buildReportPdfBuffer } from '@/pages/api/admin/regenerate-inspection-pdfs';
import { reqOriginOf } from '@/lib/appUrl';

export const config = { maxDuration: 60 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Method not allowed' }); }

  const id = String(req.query.id || '');
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Invalid inspection id' });

  try {
    const r = await buildReportPdfBuffer(id, reqOriginOf(req) || undefined);
    if (!r.ok) return res.status(r.error === 'Inspection not found' ? 404 : 400).json({ error: r.error });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="inspection-report.pdf"');
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    return res.status(200).send(r.buf);
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
