import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { externalWriteDenial } from '@/lib/inspectionGuard';
import { recordAuditEvent, readAuditLog } from '@/lib/auditLog';

/**
 * POST /api/inspections/[id]/audit-edit
 *
 * Records an "edited" audit event for the current user. The client (autosave)
 * calls this ONCE per editing session — on the first save after opening the
 * inspection, and again after the app is re-entered following an absence — NOT on
 * every keystroke. We also dedupe server-side: if this same actor already has an
 * 'edit' event within the last few minutes, we skip, so quick app-switches /
 * multiple tabs can't spam the trail. Best-effort; never blocks editing.
 */
// Just under the client's 60s "re-entry" re-arm, so a genuine go-out-and-back-in
// edit always records, while true duplicates (multiple tabs firing at once) dedupe.
const DEDUPE_WINDOW_MS = 45 * 1000;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const { id } = req.query;
  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'Missing inspection id' });

  // Only let a user mark an edit on an inspection they can actually write — stops
  // an external account writing spurious edit events into another inspection's
  // audit trail. No-op for internal staff.
  const denial = await externalWriteDenial(session.email, id);
  if (denial) return res.status(403).json({ error: denial });

  try {
    // Skip if this actor already logged an edit very recently.
    const now = Date.now();
    const log = await readAuditLog(id).catch(() => []);
    const recent = log.some((e) =>
      e.action === 'edit' &&
      e.actorEmail === session.email &&
      now - new Date(e.ts).getTime() < DEDUPE_WINDOW_MS);

    if (!recent) {
      await recordAuditEvent({
        inspectionId: id,
        action: 'edit',
        actorEmail: session.email,
        actorName: session.name,
        detail: 'Edited',
      });
    }
    return res.status(200).json({ success: true, recorded: !recent });
  } catch (e: any) {
    console.error(`POST /api/inspections/${id}/audit-edit failed:`, e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
