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

async function buildFilesForInspection(id: string): Promise<TicketUploadFile[] | null> {
  const data = await fetchInspectionWithPropertyRef(id);
  if (!data) return null;
  // Master first, then each per-vendor PDF (eviction excluded). Direct HubSpot URLs.
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
  return files;
}

const esc = (s: string) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const { id } = req.query;
  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'Missing inspection id' });

  // GET = admin browser test: run the same upload for ?ticketId= and render the
  // step log + screenshot as a page (so selectors can be diagnosed/tuned).
  if (req.method === 'GET') {
    if (!/@resihome\.com$/i.test(session.email)) return res.status(403).send('Admin only.');
    const ticketId = Number(req.query.ticketId || 0);
    if (!ticketId || !Number.isFinite(ticketId)) {
      return res.status(400).send('Add ?ticketId=<HoneyBadger ticket id> (the number in the ticket URL …/EditTicket/<id>).');
    }
    try {
      const files = await buildFilesForInspection(id);
      if (!files) return res.status(404).send('Inspection not found.');
      if (!files.length) return res.status(200).send('No PDFs found on this inspection to upload.');
      const upload = await uploadTicketDocuments({ ticketId, files });
      const shotImg = upload.screenshot ? `<img src="${upload.screenshot}" style="max-width:100%;border:1px solid #ccc"/>` : '<em>no screenshot</em>';
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(
        `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">`
        + `<body style="font:14px system-ui;margin:16px;max-width:900px">`
        + `<h2>Ticket #${ticketId} upload — ${upload.ok ? '✅ success' : '❌ failed'}</h2>`
        + (upload.error ? `<p style="color:#b91c1c"><b>Error:</b> ${esc(upload.error)}</p>` : '')
        + `<p>configured=${upload.configured} · uploaded=${upload.uploaded}</p>`
        + `<h3>Steps</h3><ol>${upload.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`
        + `<h3>Screenshot at finish</h3>${shotImg}</body>`
      );
    } catch (e: any) {
      return res.status(500).send(`Error: ${esc(String(e?.message || e))}`);
    }
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ticketId = Number((req.body && req.body.ticketId) || 0);
  if (!ticketId || !Number.isFinite(ticketId)) {
    return res.status(200).json({ ok: false, skipped: true, reason: 'no ticketId' });
  }

  try {
    const files = await buildFilesForInspection(id);
    if (!files) return res.status(404).json({ error: 'Inspection not found' });
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
