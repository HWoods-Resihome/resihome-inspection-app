/**
 * POST /api/inspections/[id]/create-maintenance-ticket
 *
 * Admin test button: fire the Maintenance AI ticket integration for a COMPLETED
 * Scope Rate Card inspection, so we can validate end-to-end without re-finalizing.
 *
 * Builds the same payload finalize uses — the property's hbmm_property_id as
 * propertyId, the fixed intro + per-vendor scope-document links (from the stored
 * pdf_vendor_urls_json) as the description — and calls the Maintenance AI API.
 *
 * Gated to hwoods@resihome.com ONLY (temporary validation tool).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { fetchInspectionWithPropertyRef } from '@/lib/hubspot';
import { createMaintenanceTicket, buildTicketDescription } from '@/lib/maintenanceAi';
import { buildShortLink } from '@/lib/shortLinks';
import { vendorGetsOwnPdf } from '@/lib/vendors';
import { uploadTicketDocuments, type TicketUploadFile } from '@/lib/ticketUpload';

const ADMIN_EMAIL = 'hwoods@resihome.com';

// Browser automation (PDF upload) can take a while — allow up to 5 min.
export const config = { maxDuration: 300 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if ((session.email || '').toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Admin only.' });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id } = req.query;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Missing inspection id' });
  }

  // Diagnostic mode: POST ...?debug=1 — report (masked) what we'd send, so we
  // can spot a key with stray quotes/whitespace or a wrong base URL, WITHOUT
  // exposing the key or calling the API.
  if (req.query.debug) {
    const raw = process.env.MAINTENANCE_AI_API_KEY ?? '';
    const trimmed = raw.trim();
    const baseUrl = (process.env.MAINTENANCE_AI_BASE_URL || 'https://hbmm-admin-int.resicapdev.com').trim().replace(/\/+$/, '');
    const version = (process.env.MAINTENANCE_AI_API_VERSION || 'v1').trim();
    return res.status(200).json({
      debug: true,
      apiKey: {
        present: raw.length > 0,
        rawLength: raw.length,
        trimmedLength: trimmed.length,
        hadSurroundingWhitespaceOrNewline: raw.length !== trimmed.length,
        startsWithQuote: /^["']/.test(trimmed),
        endsWithQuote: /["']$/.test(trimmed),
        hasInnerSpace: /\s/.test(trimmed),
        first4: trimmed.slice(0, 4),
        last4: trimmed.slice(-4),
      },
      baseUrl,
      version,
      fullUrl: `${baseUrl}/api/external/${version}/ticket`,
    });
  }

  try {
    const data = await fetchInspectionWithPropertyRef(id);
    if (!data) return res.status(404).json({ error: 'Inspection not found' });

    const hbmmId = Number(data.propertyHbmmId || '');
    if (!data.propertyHbmmId || !Number.isFinite(hbmmId)) {
      return res.status(400).json({
        error: 'This property has no hbmm_property_id set in HubSpot — can\'t map it to a Maintenance system property.',
      });
    }

    // Per-vendor scope PDFs from the stored finalize output → clean short links.
    let vendorUrls: Record<string, string> = {};
    if (data.inspection.pdfVendorUrlsJson) {
      try {
        const parsed = JSON.parse(data.inspection.pdfVendorUrlsJson);
        if (parsed && typeof parsed === 'object') vendorUrls = parsed as Record<string, string>;
      } catch { /* malformed — fall through with empty links */ }
    }
    const shareHost = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
    const shareProto = (req.headers['x-forwarded-proto'] as string) || 'https';
    const shareBase = `${shareProto}://${shareHost}`;
    const shareVendorLinks: Record<string, string> = {};
    for (const vendor of Object.keys(vendorUrls)) {
      shareVendorLinks[vendor] = buildShortLink(shareBase, id, 'vendor', vendor);
    }

    const result = await createMaintenanceTicket({
      propertyId: hbmmId,
      description: buildTicketDescription(shareVendorLinks),
    });

    if (!result.configured) {
      return res.status(503).json({
        ok: false,
        error: 'Maintenance AI is not configured. Set MAINTENANCE_AI_API_KEY (and optionally MAINTENANCE_AI_BASE_URL / MAINTENANCE_AI_API_VERSION).',
      });
    }
    if (!result.ok) {
      return res.status(502).json({ ok: false, error: result.error || 'Ticket creation failed.', status: result.status, requestId: result.requestId });
    }
    console.log(`[create-maintenance-ticket] inspection ${id}: created ticket #${result.ticketId} on property ${hbmmId} (req ${result.requestId})`);

    // Phase 3: upload the per-vendor scope PDFs into the ticket via the UI
    // (best-effort; no-ops until HBMM_USERNAME/HBMM_PASSWORD are set). Uses the
    // direct HubSpot file URLs (long) for the actual bytes, excluding eviction.
    let upload: Awaited<ReturnType<typeof uploadTicketDocuments>> | null = null;
    if (result.ticketId) {
      const files: TicketUploadFile[] = Object.entries(vendorUrls)
        .filter(([vendor, url]) => vendorGetsOwnPdf(vendor) && !!url)
        .map(([vendor, url]) => {
          let name = `${vendor} Rate Card.pdf`;
          try { const seg = new URL(url).pathname.split('/').pop(); if (seg) name = decodeURIComponent(seg); } catch { /* keep */ }
          return { name, url };
        });
      if (files.length) {
        upload = await uploadTicketDocuments({ ticketId: result.ticketId, files });
        console.log(`[create-maintenance-ticket] ticket #${result.ticketId} upload: ok=${upload.ok} uploaded=${upload.uploaded} steps=${upload.steps.join(' | ')}${upload.error ? ` error=${upload.error}` : ''}`);
      }
    }

    return res.status(200).json({ ok: true, ticketId: result.ticketId, propertyId: hbmmId, requestId: result.requestId, upload });
  } catch (e: any) {
    console.error(`[create-maintenance-ticket] inspection ${id} failed:`, e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
