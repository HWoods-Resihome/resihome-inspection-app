/**
 * GET|POST /api/admin/backfill-inspection-coords  (app-admin only)
 *
 * Stamp latitude/longitude onto existing inspections that don't have them, so the
 * calendar map plots their pins without a live geocode. Resolves via the shared
 * geocode resolver (property coords / geocoded address, state-validated). Skips
 * inspections that already carry coordinates. AUTO-DRAINS within a ~250s budget
 * and returns a `resume` URL when more remain. Idempotent.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { fetchInspections, updateInspection } from '@/lib/hubspot';
import { resolveCoords } from '@/lib/geocodeResolve';

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
  const deadline = Date.now() + 250_000;

  try {
    const all = await fetchInspections();
    // Missing coords AND has something to resolve from (address or property ref).
    const targets = all.filter((i) =>
      !(Number.isFinite(i.lat) && Number.isFinite(i.lng))
      && (i.propertyAddressSnapshot || i.propertyRecordId));

    let processed = 0, stamped = 0, noMatch = 0, errors = 0;
    const errorSamples: string[] = [];
    let i = startIdx;
    for (; i < targets.length; i++) {
      const insp = targets[i];
      processed++;
      try {
        const c = await resolveCoords({ address: insp.propertyAddressSnapshot || '', propertyId: insp.propertyRecordId || '' });
        if (c) { await updateInspection(insp.recordId, { latitude: c.lat, longitude: c.lng }); stamped++; }
        else noMatch++;
      } catch (e: any) {
        errors++;
        if (errorSamples.length < 8) errorSamples.push(`${insp.recordId}: ${String(e?.message || e).slice(0, 140)}`);
      }
      if (Date.now() > deadline) { i++; break; }
    }

    const done = i >= targets.length;
    const nextAfter = done ? null : i;
    return res.status(200).json({
      ok: true, missingCoords: targets.length, processed, stamped, noMatch, errors,
      done, nextAfter,
      resume: nextAfter != null ? `/api/admin/backfill-inspection-coords?after=${nextAfter}` : null,
      errorSamples,
    });
  } catch (e: any) {
    console.error('[backfill-inspection-coords] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
