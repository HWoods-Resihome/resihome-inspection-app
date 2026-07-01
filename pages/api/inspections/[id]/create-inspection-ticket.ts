/**
 * POST /api/inspections/[id]/create-inspection-ticket
 *
 * Raise a maintenance ticket from a FAILED 1099 (leasing-agent) or vacancy /
 * occupancy inspection where the inspector chose "submit a maintenance ticket"
 * and entered a description.
 *
 * Mirrors the Scope finalize ticket flow, with these differences:
 *   - work-order category = 19 (vs 23 for Scope)
 *   - ticket TYPE is set to the configured inspection type (1826), applied via
 *     the post-create updateTicketType PUT so it actually sticks
 *   - description = the inspector's text + a provenance line
 *   - the attached document is the single completed inspection PDF
 *
 * Best-effort: returns { ok:false, ... } (HTTP 200) when the property has no
 * hbmm_property_id or the API/upload fails, so the client can surface it without
 * blocking the already-completed inspection.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { fetchInspectionWithPropertyRef } from '@/lib/hubspot';
import { isExternalEmail } from '@/lib/userAccess';
import { createMaintenanceTicket, buildInspectionTicketDescription, buildTicketUrl } from '@/lib/maintenanceAi';
import { templateLabel as templateLabelFor } from '@/lib/templateLabels';

// Work-order category for 1099 / vacancy maintenance tickets (Scope uses 23).
const TICKET_CATEGORY_INSPECTION = Number(process.env.MAINTENANCE_AI_INSPECTION_CATEGORY_ID) || 19;
// Ticket type for these tickets. Sent on create AND confirmed via the
// post-create updateTicketType PUT (see the createMaintenanceTicket call below)
// so it reliably sticks instead of reverting to the Maintenance default.
// Overridable via env.
const TICKET_TYPE_INSPECTION = Number(process.env.MAINTENANCE_AI_INSPECTION_TICKET_TYPE_ID) || 1826;

// Creating the ticket is a single fast API call (the slow PDF upload runs
// separately in the background), so the default function timeout is plenty.
export const config = { maxDuration: 30 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id } = req.query;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Missing inspection id' });
  }

  const description = String(req.body?.description || '').trim();
  if (!description) {
    return res.status(400).json({ error: 'A ticket description is required.' });
  }

  try {
    const data = await fetchInspectionWithPropertyRef(id);
    if (!data) return res.status(404).json({ error: 'Inspection not found' });

    // Ownership: external (1099) users may only raise tickets for their own
    // inspections. We do NOT use the write guard here — the inspection is already
    // Completed at this point (raising a ticket isn't editing it), and that guard
    // blocks writes to completed records. Internal users are unrestricted.
    if (isExternalEmail(session.email)) {
      const owner = (data.inspection.inspectorEmail || '').trim().toLowerCase();
      const me = (session.email || '').trim().toLowerCase();
      if (owner && owner !== me) {
        return res.status(403).json({ error: 'You can only raise tickets for your own inspections.' });
      }
    }

    const hbmmId = Number(data.propertyHbmmId || '');
    if (!data.propertyHbmmId || !Number.isFinite(hbmmId)) {
      // Best-effort: inspection is already complete; just report the gap.
      return res.status(200).json({
        ok: false,
        configured: true,
        error: 'This property has no hbmm_property_id set in HubSpot, so it can\'t be mapped to a Maintenance system property.',
      });
    }

    const templateLabel = templateLabelFor(data.inspection.templateType) || data.inspection.templateType;
    const fullDescription = buildInspectionTicketDescription({
      inspectorDescription: description,
      inspectorName: data.inspection.inspectorName,
      templateLabel,
    });

    const result = await createMaintenanceTicket({
      propertyId: hbmmId,
      description: fullDescription,
      categoryIds: [TICKET_CATEGORY_INSPECTION],
      // Set the type on create AND run the authoritative post-create
      // updateTicketType PUT: sending ticketTypeId on the create body alone does
      // NOT reliably stick (the API assigns its default), so without the PUT the
      // ticket reverts to Maintenance. Letting updateTicketType run makes the
      // configured type (1826) actually apply.
      ticketTypeId: TICKET_TYPE_INSPECTION,
    });
    if (!result.configured) {
      return res.status(200).json({ ok: false, configured: false, error: 'Maintenance AI is not configured (MAINTENANCE_AI_API_KEY).' });
    }
    if (!result.ok || !result.ticketId) {
      return res.status(200).json({ ok: false, configured: true, error: result.error || 'Ticket creation failed.', status: result.status });
    }
    const ticketId = result.ticketId;
    const url = buildTicketUrl(ticketId);
    console.log(`[create-inspection-ticket] inspection ${id}: created ticket #${ticketId} (category ${TICKET_CATEGORY_INSPECTION}) on property ${hbmmId} (req ${result.requestId})`);

    // NOTE: the completed PDF is attached SEPARATELY (and in the BACKGROUND) by
    // /api/inspections/[id]/upload-ticket-docs, fired by the client after this
    // returns — so the slow HoneyBadger browser automation never blocks the
    // completion screen. This endpoint only creates the ticket and returns its
    // link fast.
    return res.status(200).json({ ok: true, ticketId, url, propertyId: hbmmId, requestId: result.requestId });
  } catch (e: any) {
    console.error(`[create-inspection-ticket] inspection ${id} failed:`, e);
    return res.status(200).json({ ok: false, error: String(e?.message || e).slice(0, 300) });
  }
}
