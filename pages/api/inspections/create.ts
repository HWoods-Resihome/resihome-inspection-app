import type { NextApiRequest, NextApiResponse } from 'next';
import { createScheduledInspection, fetchPropertyRegion, copyRateCardLinesToQc, fetchInspectionById, populateBillingFields, updateInspection, recomputeInspectionTotals } from '@/lib/hubspot';
import { getSessionFromRequest } from '@/lib/auth';
import { bustInspectionsCache } from '@/pages/api/inspections';
import { inspectionUrl, reqOriginOf } from '@/lib/appUrl';
import { externalAccessDenial, isExternalEmail } from '@/lib/userAccess';
import { getCachedCatalog } from '@/pages/api/rate-card/catalog';
import { getCachedRegions } from '@/pages/api/rate-card/regions';

function nowIso(): string {
  return new Date().toISOString();
}

/** Fallback title-case for any template type not in the explicit prefix map:
 *  "some_new_template" -> "Some New Template". */
function properCase(templateType: string): string {
  return templateType
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function shortId(): string {
  // crypto.randomUUID (Node 18+) for collision-proof ids; strip dashes.
  if (typeof crypto !== 'undefined' && (crypto as any).randomUUID) {
    return (crypto as any).randomUUID().replace(/-/g, '');
  }
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
  // QC Turn Re-Inspect: the source Scope Rate Card inspection to validate.
  sourceRateCardId?: string;
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

    // External (1099) users may only create the 1099 template.
    const denial = externalAccessDenial(session.email, body.templateType, { write: true });
    if (denial) return res.status(403).json({ error: denial });

    const externalId = `INSP-${nowIso().slice(0, 10)}-${shortId().slice(0, 8)}`;

    // Inspection name format: Rate Card inspections use "Rate Card – <address> – <date>"
    // per the Phase 1 Q-M decision; others use a proper-cased template label
    // prefix (matching the labels shown in the UI) so names read cleanly on the
    // HubSpot record instead of "leasing agent 1099 property inspection".
    const isRateCard = body.templateType === 'pm_scope_rate_card';
    const isQc = body.templateType === 'pm_turn_reinspect_qc';
    const TEMPLATE_NAME_PREFIX: Record<string, string> = {
      pm_community_inspection: 'Community / Visit Inspection',
      pm_vacancy_occupancy_check: 'Vacancy / Occupancy Check',
      qc_new_construction_rrqc: 'New Construction RRQC',
      leasing_agent_1099_property_inspection: '1099 Leasing Agent Inspection',
    };
    const today = nowIso().slice(0, 10);
    // Resolve a clean label for an admin-created custom template (id like
    // custom_x_ab12) so the inspection name reads nicely.
    let customLabel = '';
    if (!isRateCard && !isQc && !TEMPLATE_NAME_PREFIX[body.templateType]) {
      try {
        const { getCustomTemplates } = await import('@/lib/formTemplates');
        customLabel = (await getCustomTemplates()).find((t) => t.id === body.templateType)?.label || '';
      } catch { /* fall back to prettified id */ }
    }
    const inspectionName = isRateCard
      ? `Rate Card – ${body.propertyAddressSnapshot} – ${today}`
      : isQc
        ? `Turn Re-Inspect QC – ${body.propertyAddressSnapshot} – ${today}`
        : `${TEMPLATE_NAME_PREFIX[body.templateType] || customLabel || properCase(body.templateType)} – ${body.propertyAddressSnapshot} – ${today}`;

    // HubSpot's scheduled_date is a Date field (not DateTime), so the value MUST be
    // exactly midnight UTC. We send the YYYY-MM-DD string form, which HubSpot interprets
    // as midnight UTC of that calendar day.
    //
    // - If body.scheduledDate is YYYY-MM-DD (from <input type="date">), use it directly.
    // - If it's a full ISO string, extract the YYYY-MM-DD portion (the user's local date).
    // - If absent, use today's date in UTC.
    let scheduledDateValue: string;
    if (body.scheduledDate) {
      // Scheduled is a plain calendar date. Take the leading YYYY-MM-DD exactly
      // as written — do NOT reparse a full ISO string through Date(), which
      // converts to UTC and rolls the day forward for users in negative-offset
      // timezones (e.g. an 8pm ET pick would become the next day).
      const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(body.scheduledDate));
      scheduledDateValue = m ? m[1] : nowIso().slice(0, 10);
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
      // Stamp external (1099) creators as the owner so the ownership guard can
      // reliably restrict edit/cancel to their own inspections. Internal users
      // keep the client-provided value (they may create on behalf of others).
      inspector_email: isExternalEmail(session.email) ? session.email : (body.inspectorEmail || ''),
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

    // QC Turn Re-Inspect: stamp the source inspection ref + carry its region
    // snapshot so the copied lines price/display consistently.
    if (isQc) {
      if (!body.sourceRateCardId) {
        return res.status(400).json({ error: 'QC inspection requires a source Rate Card inspection.' });
      }
      inspectionProps.source_rate_card_id = body.sourceRateCardId;
      try {
        const src = await fetchInspectionById(body.sourceRateCardId);
        if (src) {
          inspectionProps.source_rate_card_name = src.inspectionName || '';
          if (src.regionSnapshot) inspectionProps.region_snapshot = src.regionSnapshot;
        }
      } catch (e) {
        console.warn(`Could not load source inspection ${body.sourceRateCardId}:`, e);
      }
    }

    const { inspectionId } = await createScheduledInspection({
      inspectionProps,
      propertyRecordId: body.propertyRecordId,
    });

    // QC: copy the source Rate Card's line items onto the new QC inspection so
    // it's a self-contained snapshot. Done after creation so we have the new id.
    let copiedLines = 0;
    if (isQc && body.sourceRateCardId) {
      try {
        copiedLines = await copyRateCardLinesToQc({
          sourceInspectionId: body.sourceRateCardId,
          qcInspectionId: inspectionId,
        });
      } catch (e) {
        console.error(`QC line copy failed for inspection ${inspectionId}:`, e);
        // Don't fail the create — the QC exists; the form will just show no
        // lines and the user can retry/reopen. Surface a soft warning.
      }
      // Stamp the QC's own cost rollups from the copied lines so its
      // `total_client_cost` reflects the source scope's value. This is what the
      // home list shows as "Client: $x" AND what the price sort orders on, so a
      // re-inspect now sorts by the scope it re-inspects instead of $0.
      // Best-effort — never blocks creation.
      if (copiedLines > 0) {
        try {
          const [catalog, regions] = await Promise.all([getCachedCatalog(), getCachedRegions()]);
          await recomputeInspectionTotals(inspectionId, { catalog, regions });
        } catch (e) {
          console.warn(`[create] QC totals recompute failed for ${inspectionId}:`, e);
        }
      }
    }

    // Stamp the live deep link onto the inspection so HubSpot has a one-tap URL
    // to open it. Needs the new record id, so it's a post-create update.
    // Best-effort: never block creation if the property is missing.
    try {
      await updateInspection(inspectionId, { resiwalk_inspection_url: inspectionUrl(inspectionId, reqOriginOf(req)) });
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (!(msg.includes('PROPERTY_DOESNT_EXIST') || (msg.includes('Property') && msg.includes('does not exist')))) {
        console.warn(`[create] resiwalk_inspection_url write failed for ${inspectionId}:`, msg);
      }
    }

    bustInspectionsCache(); // show the new inspection in the list immediately

    // Billing sync: copy entity_id/full_address (property) + broker_code +
    // vendor/client invoice (agent owned by the inspector's owner) onto the new
    // inspection so billing reports are clean from the start. Best-effort —
    // never blocks creation. No-op if the billing properties don't exist yet.
    try {
      const billing = await populateBillingFields(inspectionId);
      if (!billing.ok) console.warn(`[create] billing populate note for ${inspectionId}: ${billing.note}`);
    } catch (e) {
      console.warn(`[create] billing populate failed for ${inspectionId} (continuing):`, e);
    }

    return res.status(200).json({ success: true, inspectionId, externalId, inspectionName, copiedLines });
  } catch (e: any) {
    console.error('POST /api/inspections/create failed:', e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}
