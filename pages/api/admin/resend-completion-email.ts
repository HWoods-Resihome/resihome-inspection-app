/**
 * GET /api/admin/resend-completion-email?id=<recordId>
 *
 * Re-send the completion email for ONE inspection, reading LIVE data from HubSpot
 * (so a corrected address / re-pointed property + a freshly regenerated PDF are
 * reflected). Mirrors the per-item send in cron/completion-email-backstop, minus
 * that sweep's gating (missing-stamp + cutover env + status window) — this is a
 * deliberate admin action for a specific record, e.g. after fixing a wrong
 * address. Re-stamps completion_emailed_at.
 *
 *   ?id=<recordId>   required — the inspection to resend for
 *   ?dryRun=1        preview the recipients + attachment without sending
 *
 * Admin-gated (@resihome.com). Regenerate the PDF FIRST
 * (/api/admin/regenerate-inspection-pdfs?id=…) so the attached report is current.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import {
  fetchInspectionById, fetchPropertyCommunityRrqcWalkEmail, updateInspection,
} from '@/lib/hubspot';
import { notifyInspectionCompleted } from '@/lib/notifications/triggers';
import { appBaseUrl } from '@/lib/notifications/send';
import { templateLabel } from '@/lib/templateLabels';

export const config = { maxDuration: 120 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.email))) return res.status(403).json({ error: 'Admin only.' });

  const id = typeof req.query.id === 'string' ? req.query.id.trim() : '';
  if (!id) return res.status(400).json({ error: 'Add ?id=<inspection record id>.' });
  const dryRun = req.query.dryRun === '1' || req.query.dry === '1';

  try {
    const insp = await fetchInspectionById(id);
    if (!insp) return res.status(404).json({ error: 'Inspection not found' });

    // RRQC completions also copy the community's walk distribution address.
    let extraTo: string[] = [];
    if ((insp.templateType || '') === 'qc_new_construction_rrqc' && insp.propertyRecordId) {
      const walk = await fetchPropertyCommunityRrqcWalkEmail(insp.propertyRecordId).catch(() => null);
      if (walk) extraTo = [walk];
    }
    const address = insp.propertyAddressSnapshot || insp.inspectionName || 'the property';

    if (dryRun) {
      return res.status(200).json({
        ok: true, dryRun: true, id,
        wouldSend: { to: insp.inspectorEmail || null, alsoTo: extraTo, address, pdfUrl: insp.pdfUrl || null, template: insp.templateType },
      });
    }

    await notifyInspectionCompleted({
      inspectionId: id,
      inspectorEmail: insp.inspectorEmail,
      templateLabel: templateLabel(insp.templateType),
      address,
      pdfUrl: insp.pdfUrl || undefined,
      baseUrl: appBaseUrl(req),
      extraTo,
      force: true, // deliberate admin resend — bypass the recipient's toggle
    });
    await updateInspection(id, { completion_emailed_at: new Date().toISOString() }).catch(() => {});

    return res.status(200).json({ ok: true, id, sentTo: insp.inspectorEmail || null, alsoTo: extraTo, address });
  } catch (e: any) {
    console.error('[resend-completion-email] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
