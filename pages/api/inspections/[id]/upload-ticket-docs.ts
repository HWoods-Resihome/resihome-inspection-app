/**
 * POST /api/inspections/[id]/upload-ticket-docs
 *
 * Background step of the live finalize flow: upload the Master + per-vendor scope
 * PDFs into the maintenance ticket that finalize created, by driving the
 * HoneyBadger UI (the External API has no attachment endpoint). Called by the
 * client AFTER finalize returns, so it never blocks the completion screen.
 *
 * Body: { ticketId } — the ticket id finalize created (returned in its response).
 * Returns { ok, ticketId, uploaded } on success, or { skipped:true } when the
 * integration isn't configured / there's nothing to attach (client stays silent).
 *
 * Auth: any signed-in user (this runs for real finalizes done by approvers).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { fetchInspectionWithPropertyRef } from '@/lib/hubspot';
import { uploadTicketDocuments, type TicketUploadFile } from '@/lib/ticketUpload';
import { vendorGetsOwnPdf } from '@/lib/vendors';

// Browser automation can take a while — allow up to 5 minutes.
export const config = { maxDuration: 300 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id } = req.query;
  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'Missing inspection id' });

  const ticketId = Number((req.body && req.body.ticketId) || 0);
  if (!ticketId || !Number.isFinite(ticketId)) {
    return res.status(200).json({ ok: false, skipped: true, reason: 'no ticketId' });
  }

  try {
    const data = await fetchInspectionWithPropertyRef(id);
    if (!data) return res.status(404).json({ error: 'Inspection not found' });

    // Build the file list: Master first, then each per-vendor PDF (eviction
    // excluded). Use the direct HubSpot URLs for the actual bytes.
    const nameFromUrl = (url: string, fallback: string) => {
      try { const seg = new URL(url).pathname.split('/').pop(); if (seg) return decodeURIComponent(seg); } catch { /* keep */ }
      return fallback;
    };
    const files: TicketUploadFile[] = [];
    const masterUrl = data.inspection.pdfMasterUrl || '';
    if (masterUrl) files.push({ name: nameFromUrl(masterUrl, 'Master Rate Card.pdf'), url: masterUrl });
    if (data.inspection.pdfVendorUrlsJson) {
      try {
        const map = JSON.parse(data.inspection.pdfVendorUrlsJson) || {};
        for (const [vendor, url] of Object.entries(map)) {
          if (vendorGetsOwnPdf(vendor) && typeof url === 'string' && url) {
            files.push({ name: nameFromUrl(url, `${vendor} Rate Card.pdf`), url });
          }
        }
      } catch { /* malformed — fall through */ }
    }
    if (!files.length) return res.status(200).json({ ok: false, skipped: true, reason: 'no files' });

    const upload = await uploadTicketDocuments({ ticketId, files });
    if (!upload.configured) {
      return res.status(200).json({ ok: false, skipped: true, reason: 'not configured' });
    }
    console.log(`[upload-ticket-docs] inspection ${id} → ticket #${ticketId}: ok=${upload.ok} uploaded=${upload.uploaded}${upload.error ? ` error=${upload.error}` : ''}\n  steps: ${upload.steps.join('\n         ')}`);
    // Return the step log (and, on failure, the screenshot) so the exact failure
    // point + selectors are visible without digging through server logs.
    return res.status(upload.ok ? 200 : 502).json({
      ok: upload.ok, ticketId, uploaded: upload.uploaded, error: upload.error,
      steps: upload.steps, screenshot: upload.ok ? undefined : upload.screenshot,
    });
  } catch (e: any) {
    console.error(`[upload-ticket-docs] inspection ${id} failed:`, e);
    return res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 300) });
  }
}
