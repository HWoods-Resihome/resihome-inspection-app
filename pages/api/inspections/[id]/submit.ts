import type { NextApiRequest, NextApiResponse } from 'next';
import { updateInspection, fetchInspectionById, stampFirstCompleted, stampPropertyStatusAtCompletion, stampListingSnapshotAtCompletion, fetchAnswersForInspection, populateBillingFields, readInspectionProps, stampRrqcResultOnProperty, fetchPropertyCommunityRrqcWalkEmail } from '@/lib/hubspot';
import { extractLeasingAgent1099Fields } from '@/lib/leasingAgent1099';
import { createComplianceTicketsOnSubmit } from '@/lib/complianceTickets';
import { postListingPriceAlertOnSubmit } from '@/lib/listingPriceAlert';
import { postGrassFailAlertOnSubmit } from '@/lib/grassFailAlert';
import { postScopePendingApproval } from '@/lib/scopeApprovalSlack';
import { fcSmartHomeStamps, fcPoolStamps, parseFcAnswers } from '@/lib/finalChecklist';
import { getSessionFromRequest } from '@/lib/auth';
import { externalWriteDenial } from '@/lib/inspectionGuard';
import { isCompletedStatus } from '@/lib/userAccess';
import { recordAuditEvent } from '@/lib/auditLog';
import { templateLabel } from '@/lib/templateLabels';
import { notifyInspectionCompleted } from '@/lib/notifications/triggers';
import { appBaseUrl } from '@/lib/notifications/send';

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

// In-flight guard (mirrors finalize's inFlightFinalize): a double-tap or a
// slow-network retry fires two concurrent submits that BOTH read status
// in_progress + empty dedupe stamps before either writes, producing duplicate
// compliance tickets / listing-price alerts / pending-approval Slack cards
// (every downstream dedupe is a non-atomic read-then-write). Per-instance, so it
// catches the common same-device retry; the terminal-state guard below handles
// the sequential case.
const inFlightSubmit = new Map<string, number>();
const SUBMIT_LOCK_MS = 120_000;
// Durable cross-instance lock (mirrors finalize's): serverless instances don't
// share the Map above, so two concurrent submits on DIFFERENT instances both
// pass the per-instance + terminal guards and duplicate the one-shot side-effects.
// We stamp a HubSpot property while submit runs. Fail-safe: if the property is
// missing the durable check is skipped (per-instance guard still applies).
// Override the name via SUBMIT_LOCK_PROPERTY; defaults to submit_in_progress.
const SUBMIT_LOCK_PROP = process.env.SUBMIT_LOCK_PROPERTY || 'submit_in_progress';

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

  // Reject a concurrent submit of the same inspection (double-tap / retry) so its
  // one-shot side-effects (tickets, alerts, Slack card) can't fire twice.
  const lockNow = Date.now();
  const prevLock = inFlightSubmit.get(id);
  if (prevLock && lockNow - prevLock < SUBMIT_LOCK_MS) {
    return res.status(409).json({ error: 'This inspection is already being submitted. Please wait.' });
  }
  inFlightSubmit.set(id, lockNow);

  // Durable cross-instance lock: reject a concurrent submit landing on another
  // serverless instance. Best-effort (HubSpot has no conditional write) but it
  // closes the common double-fire window the per-instance Map can't see.
  let submitDurableLockHeld = false;
  if (SUBMIT_LOCK_PROP) {
    try {
      const lockProps = await readInspectionProps(id, [SUBMIT_LOCK_PROP]).catch(() => null);
      const prev = lockProps?.[SUBMIT_LOCK_PROP];
      const prevMs = prev ? (Date.parse(String(prev)) || Number(prev) || 0) : 0;
      if (prevMs && lockNow - prevMs < SUBMIT_LOCK_MS) {
        inFlightSubmit.delete(id);
        return res.status(409).json({ error: 'This inspection is already being submitted on another device. Please wait.' });
      }
      await updateInspection(id, { [SUBMIT_LOCK_PROP]: String(lockNow) });
      submitDurableLockHeld = true;
    } catch (e) {
      console.warn('[submit] durable lock unavailable (continuing without it):', e);
    }
  }

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

    // Terminal-state guard: a COMPLETED inspection must not be re-submitted. A
    // stale tab or a retried/duplicate POST would otherwise regress an approved
    // Rate Card back to pending_approval (re-stamping submitted_by/at, resetting
    // confirm_reviewed, re-posting the Slack card) or drift a non-rate-card's
    // completed_at to a later time. Reopen (→ in_progress) is the supported path
    // to edit + resubmit; until then, reject.
    const currentStatus = (existing?.status || '').trim().toLowerCase();
    // Use the shared isCompletedStatus (covers 'submitted' too) so submit is in
    // lockstep with cancel/reopen/bulk-cancel/finalize. Re-submitting a
    // completed-equivalent otherwise re-stamps the as-of-inspection property/
    // listing snapshots (which overwrite unconditionally) to TODAY's values and
    // drifts completed_at.
    if (isCompletedStatus(currentStatus)) {
      return res.status(409).json({
        error: 'This inspection is already completed. Reopen it before submitting again.',
        alreadyCompleted: true,
      });
    }
    // A Rate Card already in pending_approval must not be re-submitted either — a
    // second submit re-stamps submitted_by_email/submitted_at (re-arming the
    // self-approval lockout against whoever pressed it, and re-attributing the
    // "submitter"). Reopen (→ in_progress) is the path to legitimately resubmit.
    if (isRateCard && currentStatus === 'pending_approval') {
      return res.status(409).json({
        error: 'This inspection is already submitted for approval. Reopen it before submitting again.',
        alreadyCompleted: true,
      });
    }

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
    // First → last photo capture window (epoch ms), for the "completion time =
    // first photo to last photo" metric. Best-effort: only stamped when the client
    // sends a valid window; unknown props are stripped by hubspotFetch if the
    // schema fields don't exist yet, so this never blocks the submit.
    const firstPhotoAt = Number(body.firstPhotoAt);
    const lastPhotoAt = Number(body.lastPhotoAt);
    if (Number.isFinite(firstPhotoAt) && Number.isFinite(lastPhotoAt) && lastPhotoAt >= firstPhotoAt) {
      props.first_photo_at = firstPhotoAt;
      props.last_photo_at = lastPhotoAt;
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
      // Load answers once. If this fails the alerts below simply find no answer
      // and skip — but a field-stamp failure must NOT skip them (see below).
      let answers: Awaited<ReturnType<typeof fetchAnswersForInspection>> = [];
      try { answers = await fetchAnswersForInspection(id); }
      catch (e) { console.warn('[submit] 1099 answers read failed (alerts may skip):', e); }

      // Stamp the standardized 1099 report fields in its OWN try — a HubSpot
      // hiccup or an unprovisioned property here previously fell through to the
      // outer catch and SKIPPED both Slack alerts. Isolated so the alerts always
      // get their chance to fire.
      try {
        const fields = extractLeasingAgent1099Fields(answers);
        if (Object.keys(fields).length > 0) await updateInspection(id, fields as Record<string, any>);
      } catch (e) {
        console.warn('[submit] 1099 field stamp skipped (provision via /admin/setup):', e);
      }

      {
        // Listing-price Slack alert: when the agent recommends Reduce/Increase on
        // "Evaluate Listing Price", post the property + active-listing price +
        // RentCast comps to Slack. Best-effort; gated per inspection.
        try {
          const fwdHost = req.headers['x-forwarded-host'] || req.headers.host;
          const fwdProto = (req.headers['x-forwarded-proto'] as string) || 'https';
          const baseUrl = fwdHost ? `${fwdProto}://${fwdHost}` : undefined;
          const alert = await postListingPriceAlertOnSubmit(
            {
              recordId: id,
              propertyAddressSnapshot: existing?.propertyAddressSnapshot || '',
              propertyRecordId: existing?.propertyRecordId || null,
              inspectorName: existing?.inspectorName || '',
              bedrooms: existing?.bedroomsAtInspection ?? null,
              bathrooms: existing?.bathroomsAtInspection ?? null,
            },
            answers,
            { baseUrl },
          );
          console.log(`[submit] 1099 listing-price alert for ${id}: ${alert.posted ? `posted to ${alert.channel}` : `skipped (${alert.reason || alert.error})`}`);
        } catch (e) {
          console.warn('[submit] listing-price alert skipped (continuing):', e);
        }

        // Grass-fail → PPW dispatch Slack alert: when the grass/landscaping
        // question is marked Fail, post the property + note + photos to the
        // PPW-dispatch channel so a cut can be scheduled. Best-effort; gated per
        // inspection (admin table key 'ppw_grass_fail').
        try {
          const fwdHost = req.headers['x-forwarded-host'] || req.headers.host;
          const fwdProto = (req.headers['x-forwarded-proto'] as string) || 'https';
          const baseUrl = fwdHost ? `${fwdProto}://${fwdHost}` : undefined;
          const grass = await postGrassFailAlertOnSubmit(
            {
              recordId: id,
              propertyAddressSnapshot: existing?.propertyAddressSnapshot || '',
              inspectorName: existing?.inspectorName || '',
            },
            answers,
            { baseUrl },
          );
          console.log(`[submit] 1099 grass-fail alert for ${id}: ${grass.posted ? `posted to ${grass.channel}` : `skipped (${grass.reason || grass.error})`}`);
        } catch (e) {
          console.warn('[submit] grass-fail alert skipped (continuing):', e);
        }
      }
    }

    // Compliance Issue tickets (utility OFF / trash bins MISSING) — ALL TEMPLATE
    // TYPES, not just 1099. The Final Checklist Utilities section (Electric /
    // Water / Gas / Trash Bins) renders on Scope / 1099 / Vacancy / Community, so
    // any of them can report an off utility or missing bins. createComplianceTicketsOnSubmit
    // self-gates: it reads the FC blob and creates a ticket ONLY for an actual
    // issue (none → no-op), and is idempotent per inspection (won't re-create on
    // re-submit). Best-effort — never blocks submission.
    try {
      const cAnswers = await fetchAnswersForInspection(id);
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
        cAnswers,
        { baseUrl },
      );
      if (summary.gated) {
        console.log(`[submit] compliance tickets for ${id}: gated (already processed) — none created`);
      } else if (summary.created.length || summary.failed.length) {
        console.log(`[submit] compliance tickets for ${id}: created [${summary.created.join('; ')}]${summary.failed.length ? ` failed [${summary.failed.join(', ')}]` : ''}`);
      }
    } catch (e) {
      console.warn('[submit] compliance ticket creation skipped (continuing):', e);
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
        await updateInspection(id, { device_type: stamps.deviceType, device_installed: stamps.deviceInstalled, serial_number: stamps.serialNumber, pool_condition: pool.poolCondition, pool_feedback: pool.poolFeedback, pool_photo_urls: pool.poolPhotoUrls });
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
      // New Construction RRQC: also push the verdict to the associated PROPERTY
      // record (rrqc_result), and on a PASS stamp rrqc_pass_date with today's date
      // (blank on a FAIL). Best-effort; never blocks the completion above.
      if ((existing?.templateType || '') === 'qc_new_construction_rrqc') {
        try {
          await stampRrqcResultOnProperty(id, inspectionResult, existing?.propertyRecordId || null);
        } catch (e) {
          console.warn('[submit] RRQC property stamp skipped (continuing):', e);
        }
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
          // BOUND this self-call so it can never starve the Slack post below. It's
          // an awaited fetch to finalize (which downloads + embeds + downscales
          // photos and is capped at 60s); with no timeout a hung/slow finalize
          // could block submit until its own limit and the pending-approval Slack
          // card would never fire (observed: big scopes submitted but no card
          // posted). If the PDF isn't ready in time we post the card WITHOUT the
          // "Open report" link — finalize regenerates the PDF at approval anyway.
          const ctrl = new AbortController();
          const to = setTimeout(() => ctrl.abort(), 75000);
          try {
            const r = await fetch(`${proto}://${host}/api/inspections/${id}/finalize`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', cookie: req.headers.cookie || '' },
              body: JSON.stringify({ regenerateOnly: true }),
              signal: ctrl.signal,
            });
            if (!r.ok) console.warn(`[submit] review PDF pre-generate returned HTTP ${r.status}`);
          } finally {
            clearTimeout(to);
          }
        }
      } catch (e) {
        console.warn('[submit] review PDF pre-generate failed/timed out (continuing to Slack post):', e);
      }
      // Scope PENDING APPROVAL Slack notification (ported from HubSpot Workflow
      // A): region → POD channel → post the pending card → write back the
      // permalink to slackmessagelink. Runs AFTER the master PDF pre-gen above so
      // the card's "Open report" link is populated. Deduped on slackmessagelink;
      // best-effort — never blocks the submit.
      try {
        const r = await postScopePendingApproval(id);
        console.log(`[submit] scope pending Slack for ${id}: ${r.status}${r.error ? ' — ' + r.error : ''}`);
      } catch (e) {
        console.warn('[submit] scope pending Slack skipped (continuing):', e);
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

    // NOTE: on a FIRST completion the "Inspection Completed" email is sent from
    // /api/pdf (after the report PDF is generated), NOT here — at submit time the
    // PDF doesn't exist yet, so sending here produced the reported attachment-less
    // email. We only send here when a PDF ALREADY exists (reopen → resubmit): in
    // that case /api/pdf sees a prior PDF and won't re-send, so this covers it
    // with the existing report attached. (Rate cards email at finalize; QC uses
    // qc-finalize.)
    if (!isRateCard && inspection && (inspection.pdfMasterUrl || inspection.pdfUrl)) {
      // A PDF already exists (e.g. reopen → resubmit) → /api/pdf won't re-send
      // (not its first PDF), so send here WITH the existing report attached.
      // New Construction RRQC also CCs the associated community's rrqc_walk_email
      // (fail-open — inspector-only if there's no community or the field is blank).
      let extraTo: string[] = [];
      if ((inspection.templateType || '') === 'qc_new_construction_rrqc' && inspection.propertyRecordId) {
        const walkEmail = await fetchPropertyCommunityRrqcWalkEmail(inspection.propertyRecordId).catch(() => null);
        if (walkEmail) extraTo = [walkEmail];
      }
      await notifyInspectionCompleted({
        inspectionId: id,
        inspectorEmail: inspection.inspectorEmail,
        templateLabel: templateLabel(inspection.templateType),
        address: inspection.propertyAddressSnapshot || inspection.inspectionName || 'the property',
        pdfUrl: inspection.pdfMasterUrl || inspection.pdfUrl,
        baseUrl: appBaseUrl(req),
        extraTo,
      });
    }

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
  } finally {
    inFlightSubmit.delete(id);
    // Release the durable lock so a legitimate later submit (after a reopen) isn't
    // blocked for the whole window.
    if (submitDurableLockHeld) {
      try { await updateInspection(id, { [SUBMIT_LOCK_PROP]: '' }); } catch { /* non-fatal */ }
    }
  }
}
