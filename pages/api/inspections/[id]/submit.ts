import type { NextApiRequest, NextApiResponse } from 'next';
import { updateInspection, fetchInspectionById, stampFirstCompleted } from '@/lib/hubspot';
import { getSessionFromRequest } from '@/lib/auth';

/**
 * Finalize an existing inspection. All answers should already be saved via
 * autosave. This endpoint just sets status=Completed, completed_at, and
 * touches up any inspection-level summary fields.
 *
 * The PDF is generated separately via /api/pdf (unchanged from earlier rounds).
 */
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

  try {
    const body = req.body || {};
    const totalQuestionsAnswered: number | undefined = body.totalQuestionsAnswered;
    const totalPhotos: number | undefined = body.totalPhotos;

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
    // Non-rate-card templates complete here → stamp first completion timestamp.
    if (!isRateCard) await stampFirstCompleted(id, nowIso);
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
    }
    const inspection = await fetchInspectionById(id);

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
