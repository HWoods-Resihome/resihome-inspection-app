/**
 * POST /api/admin/training-guide/deploy — force an immediate push of the
 * committed ResiWalk Training Guide HTML into its HubSpot file (the "Replace"
 * action), bypassing the changed-hash check. For an instant deploy without
 * waiting for the cron. App-admin only (or CRON_SECRET bearer/key for scripts).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { syncTrainingGuideToHubspot } from '@/lib/trainingGuide';

export const config = { maxDuration: 120 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth: CRON_SECRET bearer/key (scripts) OR an app-admin session.
  let authorized = false;
  const secret = process.env.CRON_SECRET || '';
  if (secret) {
    const auth = req.headers.authorization || '';
    const provided = auth.startsWith('Bearer ') ? auth.slice(7) : (typeof req.query.key === 'string' ? req.query.key : '');
    if (provided === secret) authorized = true;
  }
  if (!authorized) {
    const session = await getSessionFromRequest(req);
    if (session && (await isAppAdmin(session.email))) authorized = true;
  }
  if (!authorized) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const result = await syncTrainingGuideToHubspot({ force: true });
    console.log('[training-guide-deploy]', JSON.stringify(result));
    return res.status(result.synced ? 200 : 502).json(result);
  } catch (e: any) {
    console.error('[training-guide-deploy] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
