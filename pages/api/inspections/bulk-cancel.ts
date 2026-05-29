// POST /api/inspections/bulk-cancel
//
// Body: { ids: string[] }
// Sets status to 'cancelled' for each inspection — EXCEPT completed ones,
// which can never be cancelled. Returns per-id results.

import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { fetchInspectionById, updateInspection } from '@/lib/hubspot';

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

  const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.filter((x: any) => typeof x === 'string') : [];
  if (ids.length === 0) {
    res.status(400).json({ error: 'No inspection ids provided' });
    return;
  }

  const cancelled: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const id of ids) {
    try {
      // Guard: never cancel a completed inspection.
      const insp = await fetchInspectionById(id);
      const status = (insp?.status || '').trim().toLowerCase();
      if (status === 'completed' || status === 'complete' || status === 'submitted') {
        skipped.push({ id, reason: 'completed' });
        continue;
      }
      if (status === 'cancelled' || status === 'canceled') {
        // Already cancelled — treat as success (idempotent).
        cancelled.push(id);
        continue;
      }
      await updateInspection(id, { status: 'cancelled' });
      cancelled.push(id);
    } catch (e: any) {
      skipped.push({ id, reason: String(e?.message || e).slice(0, 120) });
    }
  }

  res.status(200).json({ success: true, cancelled, skipped });
}
