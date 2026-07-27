/**
 * GET /api/admin/test-reinspect-alert?id=<inspectionId>[&notes=1]
 *
 * Manually fire the Turn Re-Inspect / New Construction RRQC result Slack card for
 * one inspection, so an admin can verify the card in a browser without completing
 * a real inspection. Posts to whatever the admin Slack-Notifications gate resolves
 * for that alert (SANDBOX by default until it's flipped live), so a test lands in
 * the sandbox channel, not the real leasing channels.
 *
 * Deal notes are SKIPPED by default (so a test never writes notes to real leasing
 * deals); pass &notes=1 to include them. Admin-session OR CRON_SECRET gated.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { fetchInspectionById } from '@/lib/hubspot';
import { reqOriginOf } from '@/lib/appUrl';
import { postReinspectResultAlert } from '@/lib/reinspectAlerts';
import { REINSPECT_TEMPLATES } from '@/lib/reinspectAlertsConfig';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Auth: CRON_SECRET bearer/?key= OR an app-admin session.
  const secret = process.env.CRON_SECRET || '';
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : (typeof req.query.key === 'string' ? req.query.key : '');
  let authorized = !!secret && provided === secret;
  if (!authorized) {
    const session = await getSessionFromRequest(req).catch(() => null);
    authorized = !!session?.email && (await isAppAdmin(session.email).catch(() => false));
  }
  if (!authorized) return res.status(401).json({ error: 'Admins only' });

  const id = String(req.query.id || '').trim();
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Pass ?id=<inspectionId>' });

  const insp = await fetchInspectionById(id).catch(() => null);
  if (!insp) return res.status(404).json({ error: 'Inspection not found' });
  const templateType = insp.templateType || '';
  if (!REINSPECT_TEMPLATES[templateType]) {
    return res.status(200).json({
      ok: false,
      reason: 'NOT_APPLICABLE',
      message: `This inspection is "${templateType}". Result alerts only fire for Turn Re-Inspect (pm_turn_reinspect_qc) or New Construction RRQC (qc_new_construction_rrqc).`,
      inspectionResult: insp.inspectionResult || null,
    });
  }

  const result = await postReinspectResultAlert({
    inspectionId: id,
    templateType,
    baseUrl: reqOriginOf(req),
    skipDealNotes: req.query.notes !== '1', // default: don't touch real deals
  });
  return res.status(200).json({ ok: result.status === 'SENT', ...result, note: 'Posts to the sandbox channel until the alert is flipped live in Admin ▸ Slack Notifications.' });
}
