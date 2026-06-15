import type { NextApiRequest, NextApiResponse } from 'next';
import {
  upsertAnswers,
  archiveAnswers,
  updateInspection,
  touchInspection,
  fetchInspectionById,
  type AnswerUpsert,
} from '@/lib/hubspot';
import { getSessionFromRequest } from '@/lib/auth';
import { externalWriteDenial } from '@/lib/inspectionGuard';

export const config = {
  api: { bodyParser: { sizeLimit: '5mb' } },
};

interface BodyShape {
  upserts: AnswerUpsert[];
  archives?: string[];
  bumpStatusToInProgress?: boolean;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const { id } = req.query;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Missing inspection id' });
  }

  // External (1099) users: only their 1099 inspections, and never once completed.
  const denial = await externalWriteDenial(session.email, id);
  if (denial) return res.status(403).json({ error: denial });

  try {
    const body = req.body as BodyShape;
    const upserts = body?.upserts || [];
    const archives = body?.archives || [];

    const t0 = Date.now();

    // Server-side status transition: if this is the FIRST edit and the
    // inspection is still Scheduled, flip it to In Progress.
    if (body.bumpStatusToInProgress) {
      const insp = await fetchInspectionById(id);
      if (insp && (insp.status || '').toLowerCase() === 'scheduled') {
        await updateInspection(id, {
          status: 'in_progress',
          started_at: new Date().toISOString(),
        });
      }
    }

    const upsertResults = await upsertAnswers(id, upserts);
    if (archives.length > 0) {
      await archiveAnswers(archives);
    }
    // Stamp "last edited" so the list can sort by most-recently-touched.
    await touchInspection(id);

    const elapsed = Date.now() - t0;
    if (elapsed > 5000) {
      console.warn(`[answers] slow autosave: ${elapsed}ms, upserts=${upserts.length}, archives=${archives.length}`);
    }

    return res.status(200).json({ success: true, results: upsertResults, elapsedMs: elapsed });
  } catch (e: any) {
    console.error(`POST /api/inspections/${id}/answers failed:`, e);
    // Surface HubSpot's validation detail (this is an internal staff write path,
    // so the real reason — e.g. which property/value was rejected — is far more
    // useful than a generic "Upstream request failed (400)" when diagnosing a
    // failed submit in the field).
    const detail = e && (e as any).detail ? ` — ${String((e as any).detail).slice(0, 300)}` : '';
    // Return a HubSpot 4xx AS a 4xx so a permanent bad-request drops from the
    // offline queue instead of retrying forever (which wedges sync + blocks submit).
    const upstream = (e as any)?.status;
    const status = (typeof upstream === 'number' && upstream >= 400 && upstream < 500 && upstream !== 429) ? upstream : 500;
    return res.status(status).json({ error: `${String(e.message || e)}${detail}` });
  }
}
