/**
 * GET /api/cron/warm-inspections — keep the shared (KV) cache hot for the default
 * home view so field users never hit the cold path (1 list + 5 count searches
 * against HubSpot). Scheduled by Vercel Cron every minute; Vercel attaches
 * `Authorization: Bearer $CRON_SECRET`, which we require (also accept `?key=` for
 * manual runs). No-ops cheaply when no KV store is connected.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { warmInspectionsCache } from '@/pages/api/inspections';
import { runAsBackground } from '@/lib/hubspot';

export const config = { maxDuration: 30 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return res.status(503).json({ error: 'CRON_SECRET not configured.' });
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : (typeof req.query.key === 'string' ? req.query.key : '');
  if (provided !== secret) return res.status(401).json({ error: 'Unauthorized' });

  try {
    // Run in the background HubSpot lane so warming can never starve live
    // inspectors of request slots during a busy period.
    const warmed = await runAsBackground(() => warmInspectionsCache());
    return res.status(200).json({ ok: true, warmed });
  } catch (e: any) {
    console.error('[warm-inspections] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
