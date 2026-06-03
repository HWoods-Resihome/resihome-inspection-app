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

const ADMIN_EMAIL = 'hwoods@resihome.com';

export const config = { maxDuration: 60 };

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

  try {
    const data = await fetchInspectionWithPropertyRef(id);
    if (!data) return res.status(404).json({ error: 'Inspection not found' });

    const hbmmId = Number(data.propertyHbmmId || '');
    if (!data.propertyHbmmId || !Number.isFinite(hbmmId)) {
      return res.status(400).json({
        error: 'This property has no hbmm_property_id set in HubSpot — can\'t map it to a Maintenance system property.',
      });
    }

    // Per-vendor scope PDF links from the stored finalize output.
    let vendorUrls: Record<string, string> = {};
    if (data.inspection.pdfVendorUrlsJson) {
      try {
        const parsed = JSON.parse(data.inspection.pdfVendorUrlsJson);
        if (parsed && typeof parsed === 'object') vendorUrls = parsed as Record<string, string>;
      } catch { /* malformed — fall through with empty links */ }
    }

    const result = await createMaintenanceTicket({
      propertyId: hbmmId,
      description: buildTicketDescription(vendorUrls),
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
    return res.status(200).json({ ok: true, ticketId: result.ticketId, propertyId: hbmmId, requestId: result.requestId });
  } catch (e: any) {
    console.error(`[create-maintenance-ticket] inspection ${id} failed:`, e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
