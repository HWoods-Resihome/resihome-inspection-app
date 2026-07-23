/**
 * GET /api/services/admin/notes-inbox-check         → run the reply-by-email
 *   ingestion sweep now and report per-message decisions (admin diagnostic).
 * GET .../notes-inbox-check?id=<serviceId>           → only that service's replies.
 *
 * Use this to see WHY a given email reply did/didn't land in a service's notes
 * thread: each recent [SVC#…] message is listed with its parsed service id and
 * the decision (ingested / already-ingested / no-token / empty-after-strip /
 * service-not-found / own-outbound / other-service). Ingests real notes (same as
 * the cron) — it is not a dry run.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isAppAdmin } from '@/lib/adminAccess';
import { sweepNotesInbox } from '@/lib/services/notesInbox';

export const config = { maxDuration: 120 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  const ok = (await servicesEnabled(email).catch(() => false)) && (await isAppAdmin(email).catch(() => false));
  if (!ok) return res.status(403).json({ error: 'Admin only' });

  const serviceId = typeof req.query.id === 'string' && /^\d+$/.test(req.query.id.trim()) ? req.query.id.trim() : undefined;
  try {
    const result = await sweepNotesInbox({ serviceId, max: 40, minIntervalMs: 0, debug: true });
    return res.status(200).json(result);
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 400) });
  }
}
