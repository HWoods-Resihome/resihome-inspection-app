/**
 * GET|POST /api/admin/backfill-service-coords  (app-admin only)
 *
 * Stamp latitude/longitude onto existing Service Work Orders that don't have
 * them, so the services calendar map plots their pins without a live geocode.
 * Resolves via the shared geocode resolver using the service's address +
 * locality. Skips services that already carry coordinates. Time-bounded with a
 * `resume` URL. Idempotent.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { searchServiceWorkOrders, patchServiceWorkOrder } from '@/lib/hubspot';
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
    const all = await searchServiceWorkOrders();
    if (!all) return res.status(200).json({ ok: true, note: 'Service object not configured (no HUBSPOT_SERVICE_TYPE_ID).', missingCoords: 0, done: true });
    const geoAddress = (s: typeof all[number]) => [s.address, s.locality].map((x) => (x || '').trim()).filter(Boolean).join(', ');
    const targets = all.filter((s) =>
      !(Number.isFinite(s.lat) && Number.isFinite(s.lng)) && geoAddress(s).length >= 5);

    let processed = 0, stamped = 0, noMatch = 0, errors = 0;
    const errorSamples: string[] = [];
    let i = startIdx;
    for (; i < targets.length; i++) {
      const s = targets[i];
      processed++;
      try {
        const c = await resolveCoords({ address: geoAddress(s) });
        if (c) { await patchServiceWorkOrder(s.id, { latitude: c.lat, longitude: c.lng }); stamped++; }
        else noMatch++;
      } catch (e: any) {
        errors++;
        if (errorSamples.length < 8) errorSamples.push(`${s.id}: ${String(e?.message || e).slice(0, 140)}`);
      }
      if (Date.now() > deadline) { i++; break; }
    }

    const done = i >= targets.length;
    const nextAfter = done ? null : i;
    return res.status(200).json({
      ok: true, missingCoords: targets.length, processed, stamped, noMatch, errors,
      done, nextAfter,
      resume: nextAfter != null ? `/api/admin/backfill-service-coords?after=${nextAfter}` : null,
      errorSamples,
    });
  } catch (e: any) {
    console.error('[backfill-service-coords] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
