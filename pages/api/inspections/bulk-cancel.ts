// POST /api/inspections/bulk-cancel
//
// Body: { ids: string[] }
// Sets status to 'cancelled' for each inspection — EXCEPT completed ones,
// which can never be cancelled. Returns per-id results.

import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isExternalEmail } from '@/lib/userAccess';
import { fetchInspectionById, updateInspection } from '@/lib/hubspot';
import { bustInspectionsCache } from '@/pages/api/inspections';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const session = await getSessionFromRequest(req);
  if (!session) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  // Cancelling inspections is an internal management action — not for external
  // (1099) users.
  if (isExternalEmail(session.email)) {
    res.status(403).json({ error: 'Your account can’t cancel inspections.' });
    return;
  }

  const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.filter((x: any) => typeof x === 'string') : [];
  if (ids.length === 0) {
    res.status(400).json({ error: 'No inspection ids provided' });
    return;
  }

  const cancelled: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  // Process with a small concurrency cap so a large multi-select doesn't take
  // N sequential round-trips, while staying polite with HubSpot's rate limit.
  const CONCURRENCY = 5;
  let idx = 0;
  async function worker() {
    while (idx < ids.length) {
      const id = ids[idx++];
      try {
        // Guard: never cancel a completed inspection.
        const insp = await fetchInspectionById(id);
        const status = (insp?.status || '').trim().toLowerCase();
        if (status === 'completed' || status === 'complete' || status === 'submitted') {
          skipped.push({ id, reason: 'completed' });
          continue;
        }
        if (status === 'cancelled' || status === 'canceled') {
          cancelled.push(id); // already cancelled — idempotent success
          continue;
        }
        await updateInspection(id, { status: 'cancelled' });
        cancelled.push(id);
      } catch (e: any) {
        skipped.push({ id, reason: String(e?.message || e).slice(0, 120) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, () => worker()));

  if (cancelled.length) bustInspectionsCache(); // reflect cancellations in the list at once
  res.status(200).json({ success: true, cancelled, skipped });
}
