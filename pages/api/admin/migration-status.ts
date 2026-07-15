/**
 * GET /api/admin/migration-status  (app-admin only)
 *
 * Read-only tally of what's LEFT to migrate to Vercel Blob: how many inspection
 * (answer) and service records still reference a HubSpot-hosted photo, plus the
 * photo counts. Answers "how many more do I have to migrate?" without changing
 * anything.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { migrationRemainingCounts } from '@/lib/hubspot';

export const config = { maxDuration: 60 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email || !(await isAppAdmin(session.realEmail || session.email).catch(() => false))) {
    return res.status(403).json({ error: 'Admin only' });
  }
  try {
    const remaining = await migrationRemainingCounts();
    return res.status(200).json(remaining);
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
