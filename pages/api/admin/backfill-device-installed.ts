/**
 * GET|POST /api/admin/backfill-device-installed  (app-admin only)
 *
 * Seed the Smart Home "Device Installed" field on existing inspections to "No"
 * so the new field is never blank on records created before it existed. By
 * default it only fills BLANK values (won't clobber a record that already
 * captured a real Yes/No). Pass ?force=1 to set EVERY record to "No".
 *
 * AUTO-DRAINS within a ~250s budget; if more remain it returns `nextAfter` + a
 * `resume` URL — open that to continue. Idempotent. Requires the `device_installed`
 * property to exist (provision it first via Admin Flows → Provision Fields).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { fetchInspections, readInspectionProps, updateInspection } from '@/lib/hubspot';

export const config = { maxDuration: 300 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.realEmail || session.email))) return res.status(403).json({ error: 'Admin only.' });
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const force = String(req.query.force || '') === '1';
  const startIdx = Math.max(0, Number(req.query.after) || 0);
  const limit = Math.max(1, Math.min(1000, Number(req.query.limit) || 400));
  const deadline = Date.now() + 250_000;

  try {
    const all = await fetchInspections();
    let processed = 0, set = 0, skippedAlreadySet = 0, errors = 0;
    const errorSamples: string[] = [];
    let i = startIdx;
    for (; i < all.length && i < startIdx + limit; i++) {
      const insp = all[i];
      processed++;
      try {
        if (!force) {
          const props = await readInspectionProps(insp.recordId, ['device_installed']);
          const cur = (props?.device_installed || '').toString().trim();
          if (cur) { skippedAlreadySet++; continue; } // keep a real captured value
        }
        await updateInspection(insp.recordId, { device_installed: 'No' });
        set++;
      } catch (e: any) {
        errors++;
        if (errorSamples.length < 8) errorSamples.push(`${insp.recordId}: ${String(e?.detail || e?.message || e).slice(0, 160)}`);
      }
      if (Date.now() > deadline) { i++; break; }
    }

    const done = i >= all.length;
    const nextAfter = done ? null : i;
    const hint = (set === 0 && errors > 0)
      ? 'All writes failed — the "device_installed" property may not exist yet. Run Admin Flows → Provision Fields (Setup), then re-run this backfill.'
      : undefined;
    return res.status(200).json({
      ok: true,
      mode: force ? 'force (set every record to "No")' : 'fill blanks only',
      total: all.length,
      processed,
      set,
      skippedAlreadySet,
      errors,
      done,
      nextAfter,
      resume: nextAfter != null
        ? `/api/admin/backfill-device-installed?after=${nextAfter}&limit=${limit}${force ? '&force=1' : ''}`
        : null,
      ...(hint ? { hint } : {}),
      errorSamples,
    });
  } catch (e: any) {
    console.error('[backfill-device-installed] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
