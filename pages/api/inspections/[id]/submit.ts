import type { NextApiRequest, NextApiResponse } from 'next';
import { updateInspection, fetchInspectionById, stampFirstCompleted, stampPropertyStatusAtCompletion, stampListingSnapshotAtCompletion, fetchAnswersForInspection, populateBillingFields } from '@/lib/hubspot';
import { extractLeasingAgent1099Fields } from '@/lib/leasingAgent1099';
import { createComplianceTicketsOnSubmit } from '@/lib/complianceTickets';
import { fcSmartHomeStamps, fcPoolStamps, parseFcAnswers } from '@/lib/finalChecklist';
import { getSessionFromRequest } from '@/lib/auth';
import { externalWriteDenial } from '@/lib/inspectionGuard';
import { recordAuditEvent } from '@/lib/auditLog';

/**
 * Finalize an existing inspection. All answers should already be saved via
 * autosave. This endpoint just sets status=Completed, completed_at, and
 * touches up any inspection-level summary fields.
 *
 * The PDF is generated separately via /api/pdf (unchanged from earlier rounds).
 */
// Rate-card submit also pre-generates the review (Master) PDF server-side
// (regenerate), which can take ~15-20s — give it the same ceiling as finalize.
export const config = { maxDuration: 300 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const { id } = req.query;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Missing inspection id' });
  }

  // External (1099) users: only their 1099 inspections, and not once completed.
  const denial = await externalWriteDenial(session.email, id);
  if (denial) return res.status(403).json({ error: denial });

  try {
    const body = req.body || {};
    const totalQuestionsAnswered: number | undefined = body.totalQuestionsAnswered;
    const totalPhotos: number | undefined = body.totalPhotos;
    // Overall Pass/Fail for templates with a Review & Sign-Off verdict (1099 /
    // vacancy). Written to the standardized `inspection_result` enum, the same
    // field QC uses. 'pass' | 'fail' only.
    const rawResult = String(body.inspectionResult || '').toLowerCase();
    const inspectionResult: 'pass' | 'fail' | null =
      rawResult === 'pass' || rawResult === 'fail' ? rawResult : null;

    // Look up the inspection first so we know which template it is. Rate Card
    // inspections go to Pending Approval; everything else goes straight to Completed.
    const existing = await fetchInspectionById(id);
    const isRateCard = (existing?.templateType || '').toLowerCase() === 'pm_scope_rate_card';

    const nowIso = new Date().toISOString();
    const props: Record<string, any> = {
      confirm_reviewed: 'yes',
    };
    if (isRateCard) {
      props.status = 'pending_approval';
      // Don't set completed_at yet — that happens at final approval.
      // PDF generation is deferred to Phase 4 (Pending Approval -> Completed transition).
    } else {
      props.status = 'completed';
      props.completed_at = nowIso;
    }

    if (typeof totalQuestionsAnswered === 'number') {
      props.total_questions_answered = totalQuestionsAnswered;
    }
    if (typeof totalPhotos === 'number') {
      props.total_photos_attached = totalPhotos;
    }

    await updateInspection(id, props);
    // Non-rate-card templates complete here → stamp first completion timestamp
    // AND freeze the property status for the historical record. Rate Card goes
    // to Pending Approval (still dynamic), so its status freezes at finalize.
    if (!isRateCard) {
      await stampFirstCompleted(id, nowIso);
      await stampPropertyStatusAtCompletion(id);
      // Freeze the listing snapshot (status/price/listed/MIR/move-in) too, so the
      // completed report shows the listing as it was at the time of inspection.
      await stampListingSnapshotAtCompletion(id);
      // Re-stamp billing at completion so the vendor cost (vendor_invoice_amount)
      // is guaranteed non-null — $0 (internal) or the agent's value (e.g. $50 for
      // a 1099 leasing agent). Best-effort: never blocks the completion.
      try { await populateBillingFields(id); } catch (e) { console.warn('[submit] billing populate at completion failed (continuing):', e); }
    }

    // 1099 Leasing Agent: freeze the standardized report fields (listing-price
    // response/recommendation/feedback + landscaping response/feedback) from the
    // inspector's answers onto the inspection for downstream reporting.
    // Best-effort — never blocks the completion above; no-op until the fields are
    // provisioned (/admin/setup).
    if ((existing?.templateType || '') === 'leasing_agent_1099_property_inspection') {
      try {
        const answers = await fetchAnswersForInspection(id);
        const fields = extractLeasingAgent1099Fields(answers);
        if (Object.keys(fields).length > 0) await updateInspection(id, fields as Record<string, any>);

        // Compliance Issue tickets: a SEPARATE HubSpot ticket per utility that's
        // OFF (Electric / Water / Gas) or trash bins MISSING, each associated to
        // the inspection's Property. Best-effort — never blocks the submission.
        try {
          const fwdHost = req.headers['x-forwarded-host'] || req.headers.host;
          const fwdProto = (req.headers['x-forwarded-proto'] as string) || 'https';
          const baseUrl = fwdHost ? `${fwdProto}://${fwdHost}` : undefined;
          const summary = await createComplianceTicketsOnSubmit(
            {
              recordId: id,
              propertyAddressSnapshot: existing?.propertyAddressSnapshot || '',
              propertyRecordId: existing?.propertyRecordId || null,
              inspectorName: existing?.inspectorName || '',
            },
            answers,
            { baseUrl },
          );
          if (summary.gated) {
            console.log(`[submit] 1099 compliance tickets for ${id}: gated (already processed) — none created`);
          } else if (summary.created.length || summary.failed.length) {
            console.log(`[submit] 1099 compliance tickets for ${id}: created [${summary.created.join('; ')}]${summary.failed.length ? ` failed [${summary.failed.join(', ')}]` : ''}`);
          }
        } catch (e) {
          console.warn('[submit] compliance ticket creation skipped (continuing):', e);
        }
      } catch (e) {
        console.warn('[submit] 1099 field stamp skipped (provision via /admin/setup):', e);
      }
    }
    // Smart Home Tech (Final Checklist) → Device Installed + Serial Number fields.
    // The checklist renders on the question-form templates that complete here
    // (1099 / Vacancy / Community). Best-effort; no-op until provisioned (/admin/setup).
    const FC_TEMPLATES = new Set(['leasing_agent_1099_property_inspection', 'pm_vacancy_occupancy_check', 'pm_community_inspection']);
    if (!isRateCard && FC_TEMPLATES.has(existing?.templateType || '')) {
      try {
        const answers = await fetchAnswersForInspection(id);
        const fcRec = answers.find((a) => a.questionIdExternal === 'fc__all' || String(a.answerIdExternal || '').startsWith('FINALCHECKLIST-'));
        const fc = parseFcAnswers(fcRec?.note);
        const stamps = fcSmartHomeStamps(fc);
        const pool = fcPoolStamps(fc);
        await updateInspection(id, { device_type: stamps.deviceType, device_installed: stamps.deviceInstalled, serial_number: stamps.serialNumber, pool_condition: pool.poolCondition, pool_feedback: pool.poolFeedback });
      } catch (e) {
        console.warn('[submit] smart-home field stamp skipped (provision via /admin/setup):', e);
      }
    }
    // Persist the overall verdict to the standardized `inspection_result` field
    // (same property QC writes). Separate, best-effort write so a missing
    // property never blocks the status flip above.
    if (inspectionResult) {
      try {
        await updateInspection(id, { inspection_result: inspectionResult });
      } catch (e) {
        console.warn('[submit] could not write inspection_result (run scripts/rate_card_phase5/phase5_step2_add_inspection_result.py to create the property):', e);
      }
    }
    // Record WHO submitted for approval and WHEN — used to lock the submitter out
    // of self-finalizing for a short window (a second reviewer must approve, or
    // they wait it out). Best-effort: if the HubSpot properties don't exist yet,
    // the lockout simply stays inert (fails open). Only meaningful for rate cards.
    if (isRateCard) {
      // Persist the per-line Internal Resolution timing map { externalId: 'now'|'later' }
      // sent by the client. This makes "Complete Later" authoritative for the
      // approver (any device) and for the server-side finalize after-photo gate,
      // instead of living only in the submitter's localStorage.
      const rawTimings = body.resolutionTimings;
      let resolutionTimingJson = '';
      if (rawTimings && typeof rawTimings === 'object') {
        try { resolutionTimingJson = JSON.stringify(rawTimings); } catch { /* ignore */ }
      }
      try {
        await updateInspection(id, {
          submitted_by_email: session.email,
          // submitted_at is a HubSpot datetime → write epoch-ms (ISO shows as
          // "Invalid date").
          submitted_at: new Date(nowIso).getTime(),
          ...(resolutionTimingJson ? { resolution_timing_json: resolutionTimingJson } : {}),
        });
      } catch (e) {
        console.warn('[submit] could not record submitted_by_email/submitted_at/resolution_timing_json (create these HubSpot properties to enable the self-approval lockout + Complete Later):', e);
      }
      // Generate the review (Master) PDF now, SERVER-SIDE and awaited, so the
      // pending-approval scope reliably has pdf_master_url set (the "View PDFs"
      // link) the moment this returns — instead of depending on a client
      // fire-and-forget. Reuses the finalize "regenerate" path: it builds + stores
      // the PDFs but changes NO status and sends NO email/ticket, so it's safe on
      // a pending-approval scope. Best-effort: a failure never blocks the submit
      // (the PDFs can still be regenerated at finalize or via Admin Flows).
      try {
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
        if (host) {
          const r = await fetch(`${proto}://${host}/api/inspections/${id}/finalize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', cookie: req.headers.cookie || '' },
            body: JSON.stringify({ regenerateOnly: true }),
          });
          if (!r.ok) console.warn(`[submit] review PDF pre-generate returned HTTP ${r.status}`);
        }
      } catch (e) {
        console.warn('[submit] review PDF pre-generate failed (continuing):', e);
      }
    }
    const inspection = await fetchInspectionById(id);

    void recordAuditEvent({
      inspectionId: id,
      action: 'submit',
      actorEmail: session.email,
      actorName: session.name,
      detail: isRateCard ? 'Submitted for approval' : 'Submitted (completed)',
    });

    return res.status(200).json({
      success: true,
      inspectionRecordId: id,
      inspection,
      routedToPendingApproval: isRateCard,
      hubspotUrl: `https://app.hubspot.com/contacts/${process.env.HUBSPOT_PORTAL_ID || '51415639'}/record/${process.env.HUBSPOT_INSPECTION_TYPE_ID}/${id}`,
    });
  } catch (e: any) {
    console.error(`POST /api/inspections/${id}/submit failed:`, e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}
