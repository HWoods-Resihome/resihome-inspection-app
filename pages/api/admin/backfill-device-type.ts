/**
 * GET|POST /api/admin/backfill-device-type  (app-admin only)
 *
 * Backfill the Smart Home "Device Type" field on existing inspections from the
 * answer already captured in their Final Checklist (the "Device Type" question:
 * Bluetooth Lock / Smart Home Hub / No Smart Devices). Idempotent — it just
 * mirrors the stored answer onto the field. Inspections with no Final Checklist
 * data are skipped.
 *
 * AUTO-DRAINS within a ~250s budget; if more remain it returns `nextAfter` + a
 * `resume` URL — open that to continue. Requires the `device_type` property to
 * exist (provision it first via Admin Flows → Provision Fields).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { fetchInspections, fetchAnswersForInspection, updateInspection } from '@/lib/hubspot';
import { fcSmartHomeStamps, parseFcAnswers } from '@/lib/finalChecklist';

export const config = { maxDuration: 300 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.realEmail || session.email))) return res.status(403).json({ error: 'Admin only.' });
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const startIdx = Math.max(0, Number(req.query.after) || 0);
  // Each record is a full answers read, so keep batches modest and lean on resume.
  const limit = Math.max(1, Math.min(400, Number(req.query.limit) || 150));
  const deadline = Date.now() + 250_000;

  try {
    const all = await fetchInspections();
    let processed = 0, set = 0, skippedNoFc = 0, errors = 0;
    const errorSamples: string[] = [];
    let i = startIdx;
    for (; i < all.length && i < startIdx + limit; i++) {
      const insp = all[i];
      processed++;
      try {
        const answers = await fetchAnswersForInspection(insp.recordId);
        const fcRec = answers.find((a) => a.questionIdExternal === 'fc__all' || String(a.answerIdExternal || '').startsWith('FINALCHECKLIST-'));
        if (!fcRec) { skippedNoFc++; continue; } // no Final Checklist on this inspection
        const { deviceType } = fcSmartHomeStamps(parseFcAnswers(fcRec.note));
        await updateInspection(insp.recordId, { device_type: deviceType });
        set++;
      } catch (e: any) {
        errors++;
        if (errorSamples.length < 8) errorSamples.push(`${insp.recordId}: ${String(e?.detail || e?.message || e).slice(0, 160)}`);
      }
      if (Date.now() > deadline) { i++; break; }
    }

    const done = i >= all.length;
    const nextAfter = done ? null : i;
    // Every write failing usually means the field isn't provisioned yet.
    const hint = (set === 0 && errors > 0)
      ? 'All writes failed — the "device_type" property may not exist yet. Run Admin Flows → Provision Fields (Setup), then re-run this backfill.'
      : undefined;
    return res.status(200).json({
      ok: true,
      total: all.length,
      processed,
      set,
      skippedNoFc,
      errors,
      done,
      nextAfter,
      resume: nextAfter != null ? `/api/admin/backfill-device-type?after=${nextAfter}&limit=${limit}` : null,
      ...(hint ? { hint } : {}),
      errorSamples,
    });
  } catch (e: any) {
    console.error('[backfill-device-type] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
