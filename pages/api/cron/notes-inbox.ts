/**
 * GET /api/cron/notes-inbox — background sweep of email REPLIES into service
 * note threads (every minute via Vercel Cron). The shared sweep logic lives in
 * lib/services/notesInbox.ts and ALSO runs on-demand when a thread is opened
 * (the notes GET endpoint), so this cron is the catch-all for replies nobody
 * is currently looking at.
 *
 * Requires the system Gmail token to carry a READ scope (gmail.modify). Without
 * it the sweep returns a clear reason and no-ops — in-app notes keep working.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { sweepNotesInbox } from '@/lib/services/notesInbox';

export const config = { maxDuration: 60 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return res.status(200).json({ ok: true, skipped: true, reason: 'CRON_SECRET not configured.' });
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : (typeof req.query.key === 'string' ? req.query.key : '');
  if (provided !== secret) return res.status(401).json({ error: 'Unauthorized' });

  const result = await sweepNotesInbox({ max: 20 });
  return res.status(200).json(result);
}
