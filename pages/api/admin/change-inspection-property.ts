/**
 * POST /api/admin/change-inspection-property   { id, propertyRecordId }
 *
 * Admin action (from the inspection record's gear menu): reassign an inspection
 * to a DIFFERENT property — e.g. it was created against the wrong address. It:
 *   1. Re-points property_id_ref + the HubSpot object association to the new
 *      property, and refreshes every snapshot the inspection copied from its
 *      property (address, region, portfolio, locality, status, bed/bath) so the
 *      record fully reflects the new address immediately.
 *   2. Rewrites the inspection name's address segment.
 *   3. If the inspection is already COMPLETED: regenerates the PDF (new address)
 *      and re-sends the completion email (force — deliberate admin action).
 *
 * Property-backed templates only — Community/Visit inspections reference a
 * community, not a property, and are rejected. Admin-gated (@resihome.com).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import {
  fetchInspectionById, fetchPropertyReassignSnapshot, repointInspectionProperty,
  fetchPropertyCommunityName, fetchPropertyCommunityRrqcWalkEmail, updateInspection,
  updateInspectionResilient,
} from '@/lib/hubspot';
import { regenerateOne } from '@/pages/api/admin/regenerate-inspection-pdfs';
import { notifyInspectionCompleted } from '@/lib/notifications/triggers';
import { appBaseUrl } from '@/lib/notifications/send';
import { reqOriginOf } from '@/lib/appUrl';
import { templateLabel } from '@/lib/templateLabels';
import { isCompletedStatus } from '@/lib/userAccess';

export const config = { maxDuration: 300 };

// Community/Visit inspections carry a community record in property_id_ref, not a
// property — reassigning them to a property would corrupt the linkage.
const COMMUNITY_TEMPLATE = 'pm_community_inspection';

// Swap the address segment of an inspection name formatted "<Prefix> – <Address>
// – <Date>" (en-dash separators from the create flow). Falls back to leaving the
// name unchanged when it doesn't match that 3-part shape.
function rewriteInspectionName(name: string, newAddress: string): string {
  const parts = (name || '').split(' – ');
  if (parts.length >= 3 && newAddress) {
    parts[1] = newAddress;
    return parts.join(' – ');
  }
  return name;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.email))) return res.status(403).json({ error: 'Admin only.' });

  const id = typeof req.body?.id === 'string' ? req.body.id.trim() : '';
  const propertyRecordId = typeof req.body?.propertyRecordId === 'string' ? req.body.propertyRecordId.trim() : '';
  if (!id || !propertyRecordId) return res.status(400).json({ error: 'id and propertyRecordId are required.' });

  try {
    const insp = await fetchInspectionById(id);
    if (!insp) return res.status(404).json({ error: 'Inspection not found' });
    if ((insp.templateType || '') === COMMUNITY_TEMPLATE) {
      return res.status(400).json({ error: 'Community / Visit inspections are tied to a community, not a property, and can’t be reassigned here.' });
    }
    if ((insp.propertyRecordId || '') === propertyRecordId) {
      return res.status(400).json({ error: 'That is already this inspection’s property.' });
    }

    const snap = await fetchPropertyReassignSnapshot(propertyRecordId);
    if (!snap || !snap.addressSnapshot) return res.status(404).json({ error: 'New property not found (or has no address).' });

    // Best-effort community name for the new property (matches the create sync).
    const communityName = await fetchPropertyCommunityName(propertyRecordId).catch(() => null);

    // 1) Refresh every property-derived field onto the inspection.
    const props: Record<string, any> = {
      property_id_ref: propertyRecordId,
      property_address_snapshot: snap.addressSnapshot,
      inspection_name: rewriteInspectionName(insp.inspectionName, snap.addressSnapshot),
      full_address: snap.addressSnapshot,
      region_snapshot: snap.region,
      portfolio_snapshot: snap.portfolio,
      locality_snapshot: snap.locality,
      property_status_snapshot: snap.status,
      ...(communityName ? { community_name: communityName } : {}),
      ...(snap.bedrooms != null ? { bedrooms_at_inspection: snap.bedrooms } : {}),
      ...(snap.bathrooms != null ? { bathrooms_at_inspection: snap.bathrooms } : {}),
    };
    // Resilient patch: portfolio_snapshot / locality_snapshot / community_name /
    // full_address may not be provisioned on the inspection object in every
    // environment — writeObjectResilient strips any rejected field and retries so
    // a missing optional snapshot can't fail the core reassign.
    await updateInspectionResilient(id, props);

    // 2) Re-point the HubSpot object association (archive old, add new).
    const assocOk = await repointInspectionProperty(id, propertyRecordId);
    if (!assocOk) console.warn(`[change-property] ${id}: association repoint returned false (property_id_ref still updated).`);

    // 3) Completed → regenerate the PDF (new address) + resend the completion email.
    const origin = reqOriginOf(req) || undefined;
    const wasCompleted = isCompletedStatus(insp.status);
    let pdf: { ok: boolean; pdfUrl?: string; error?: string } | null = null;
    let emailedTo: string | null = null;
    if (wasCompleted) {
      pdf = await regenerateOne(id, origin).catch((e) => ({ id, ok: false, error: String(e?.message || e) }));
      // RRQC completions also copy the community's walk distribution address.
      let extraTo: string[] = [];
      if ((insp.templateType || '') === 'qc_new_construction_rrqc') {
        const walk = await fetchPropertyCommunityRrqcWalkEmail(propertyRecordId).catch(() => null);
        if (walk) extraTo = [walk];
      }
      try {
        await notifyInspectionCompleted({
          inspectionId: id,
          inspectorEmail: insp.inspectorEmail,
          templateLabel: templateLabel(insp.templateType),
          address: snap.addressSnapshot,
          pdfUrl: (pdf?.ok && pdf.pdfUrl) ? pdf.pdfUrl : (insp.pdfUrl || undefined),
          baseUrl: appBaseUrl(req),
          extraTo,
          force: true,
        });
        await updateInspection(id, { completion_emailed_at: new Date().toISOString() }).catch(() => {});
        emailedTo = insp.inspectorEmail || null;
      } catch (e) {
        console.warn(`[change-property] ${id}: completion email resend failed:`, e);
      }
    }

    return res.status(200).json({
      ok: true, id,
      from: { propertyRecordId: insp.propertyRecordId, address: insp.propertyAddressSnapshot },
      to: { propertyRecordId, address: snap.addressSnapshot },
      associationRepointed: assocOk,
      wasCompleted,
      pdfRegenerated: wasCompleted ? !!pdf?.ok : null,
      emailedTo: wasCompleted ? emailedTo : null,
    });
  } catch (e: any) {
    console.error('[change-property] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
