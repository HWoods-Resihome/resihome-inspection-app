import type { NextApiRequest, NextApiResponse } from 'next';
import { createScheduledInspection, fetchPropertyRegion } from '@/lib/hubspot';
import { getSessionFromRequest } from '@/lib/auth';

function nowIso(): string {
  return new Date().toISOString();
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

interface CreateBody {
  templateType: string;
  propertyRecordId: string;
  propertyAddressSnapshot: string;
  inspectorName: string;
  inspectorEmail?: string;
  bedrooms: number;
  bathrooms: number;
  // Optional: when the user uses "Schedule Inspection", they pick a specific date.
  // ISO date string (YYYY-MM-DD) or full ISO datetime. If absent, defaults to now.
  scheduledDate?: string;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const body = req.body as CreateBody;
    if (!body || !body.templateType || !body.propertyRecordId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const externalId = `INSP-${nowIso().slice(0, 10)}-${shortId().slice(0, 8)}`;

    // Inspection name format: Rate Card inspections use "Rate Card – <address> – <date>"
    // per the Phase 1 Q-M decision; others use the existing pattern.
    const isRateCard = body.templateType === 'pm_scope_rate_card';
    const inspectionName = isRateCard
      ? `Rate Card – ${body.propertyAddressSnapshot} – ${nowIso().slice(0, 10)}`
      : `${body.templateType.replace(/_/g, ' ')} -- ${body.propertyAddressSnapshot} -- ${nowIso().slice(0, 10)}`;

    // HubSpot's scheduled_date is a Date field (not DateTime), so the value MUST be
    // exactly midnight UTC. We send the YYYY-MM-DD string form, which HubSpot interprets
    // as midnight UTC of that calendar day.
    //
    // - If body.scheduledDate is YYYY-MM-DD (from <input type="date">), use it directly.
    // - If it's a full ISO string, extract the YYYY-MM-DD portion (the user's local date).
    // - If absent, use today's date in UTC.
    let scheduledDateValue: string;
    if (body.scheduledDate) {
      const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(body.scheduledDate);
      scheduledDateValue = isDateOnly
        ? body.scheduledDate
        : new Date(body.scheduledDate).toISOString().slice(0, 10);
    } else {
      scheduledDateValue = nowIso().slice(0, 10);
    }

    const inspectionProps: Record<string, any> = {
      inspection_id_external: externalId,
      inspection_name: inspectionName,
      template_type: body.templateType,
      status: 'scheduled',
      property_address_snapshot: body.propertyAddressSnapshot,
      bedrooms_at_inspection: body.bedrooms,
      bathrooms_at_inspection: body.bathrooms,
      inspector_name: body.inspectorName,
      inspector_email: body.inspectorEmail || '',
      property_id_ref: body.propertyRecordId,
      scheduled_date: scheduledDateValue,
    };

    // For Rate Card inspections, snapshot the property's `region` field onto the
    // new inspection's `region_snapshot`. The math layer falls back to GA:Atlanta
    // automatically if region is missing or doesn't match the matrix, so we just
    // pass through whatever the property has (including empty string).
    if (isRateCard) {
      try {
        const region = await fetchPropertyRegion(body.propertyRecordId);
        if (region) {
          inspectionProps.region_snapshot = region;
        }
      } catch (e) {
        // Don't block inspection creation if region lookup fails; log and continue.
        // Math will fall back to GA:Atlanta.
        console.warn(`Region lookup failed for property ${body.propertyRecordId}; using fallback.`, e);
      }
    }

    const { inspectionId } = await createScheduledInspection({
      inspectionProps,
      propertyRecordId: body.propertyRecordId,
    });

    return res.status(200).json({ success: true, inspectionId, externalId, inspectionName });
  } catch (e: any) {
    console.error('POST /api/inspections/create failed:', e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}
