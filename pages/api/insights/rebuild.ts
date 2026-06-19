/**
 * /api/insights/rebuild — (re)build the Insights snapshot.
 *
 * Auth (self-enforced; route is in PUBLIC_PATHS so Vercel Cron can reach it
 * without a session cookie, mirroring /api/cron/*):
 *   - Vercel Cron: GET with `Authorization: Bearer $CRON_SECRET` (auto-attached
 *     when CRON_SECRET is set), or a `?key=$CRON_SECRET` fallback.
 *   - Manual admin trigger: any signed-in app admin (POST or GET).
 *
 * Read-only against HubSpot; writes the compact snapshot to Vercel Blob.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { buildInsightsSnapshot, writeInsightsSnapshot, buildDailyRollup, writeDailyRollup } from '@/lib/insightsSnapshot';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // CRON_SECRET bearer/key (cron + scripts) OR an app-admin session (manual).
  let authorized = false;
  const secret = process.env.CRON_SECRET || '';
  if (secret) {
    const auth = req.headers.authorization || '';
    const provided = auth.startsWith('Bearer ') ? auth.slice(7)
      : (typeof req.query.key === 'string' ? req.query.key : '');
    if (provided === secret) authorized = true;
  }
  if (!authorized) {
    const session = await getSessionFromRequest(req);
    if (session && (await isAppAdmin(session.email))) authorized = true;
  }
  if (!authorized) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const snap = await buildInsightsSnapshot();
    await writeInsightsSnapshot(snap);
    // Bank today's rollup so trend/delta cards have a time series (best-effort —
    // a failed history write must not fail the snapshot).
    try { await writeDailyRollup(buildDailyRollup(snap)); }
    catch (e) { console.warn('[insights/rebuild] history write failed:', e); }
    const summary = {
      ok: true, asOf: snap.asOf, total: snap.total, scanned: snap.scanned,
      truncated: snap.truncated, buildMs: snap.buildMs,
    };
    console.log('[insights/rebuild]', JSON.stringify(summary));
    if (snap.truncated) {
      console.warn('[insights/rebuild] TRUNCATED — scan did not capture all inspections; switch to date-windowed partitioning.');
    }
    return res.status(200).json(summary);
  } catch (e: any) {
    console.error('[insights/rebuild] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
