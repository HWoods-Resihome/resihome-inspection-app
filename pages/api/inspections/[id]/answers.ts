import type { NextApiRequest, NextApiResponse } from 'next';
import {
  upsertAnswers,
  archiveAnswers,
  updateInspection,
  touchInspection,
  fetchInspectionById,
  answerHasProperty,
  type AnswerUpsert,
} from '@/lib/hubspot';
import { getSessionFromRequest } from '@/lib/auth';
import { externalWriteDenial } from '@/lib/inspectionGuard';
import { enforceRateLimit } from '@/lib/rateLimit';
import { reportServerError } from '@/lib/serverErrorReporter';

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

  // Per-user autosave throttle (generous — autosave is debounced; this only
  // catches a runaway loop hammering HubSpot). Keyed per inspection so editing
  // two inspections doesn't share a budget.
  if (enforceRateLimit(res, { key: `${session.email}:${id}`, route: 'answers', max: 600 })) return;

  try {
    const body = req.body as BodyShape;
    const upserts = body?.upserts || [];
    const archives = body?.archives || [];

    // The 1099 recommended-rent input writes `recommended_amount` on the answer.
    // Until that property is provisioned (/admin/setup), strip it so an unknown
    // property can't 400 the save. Only checks when an upsert actually carries it.
    if (upserts.some((u) => u?.answerProps && 'recommended_amount' in u.answerProps)) {
      if (!(await answerHasProperty('recommended_amount'))) {
        for (const u of upserts) {
          if (u?.answerProps) delete (u.answerProps as Record<string, any>).recommended_amount;
        }
      }
    }

    const t0 = Date.now();

    // Preflight: a `note` over HubSpot's text ceiling 400s the write with a
    // cryptic "Cannot set PropertyValueCoordinates{…}" error. The Final Checklist
    // persists its whole state (incl. photo URLs) as a JSON blob in `note`, which
    // we CAN'T safely truncate (that corrupts the JSON), so reject it here with a
    // clear, actionable reason instead of forwarding HubSpot's opaque one — and
    // skip the doomed round-trip. No data is lost: the client blocks submit and
    // the inspector removes a few checklist photos. (answer_value / answer_summary
    // are already capped in buildQaAnswerProps, so only `note` can reach this.)
    const HUBSPOT_TEXT_MAX = 65536;
    const overLimit: Array<{ recordId: string; answerIdExternal: string; failed: true; reason: string }> = [];
    const sendable: AnswerUpsert[] = [];
    for (const u of upserts) {
      const note = u?.answerProps?.note;
      if (typeof note === 'string' && note.length > HUBSPOT_TEXT_MAX) {
        overLimit.push({
          recordId: u.recordId || '',
          answerIdExternal: String(u.answerProps?.answer_id_external || ''),
          failed: true,
          reason: `This record is too large to save (${note.length.toLocaleString()} characters; HubSpot's limit is ${HUBSPOT_TEXT_MAX.toLocaleString()}). Remove a few checklist photos and try again.`,
        });
      } else {
        sendable.push(u);
      }
    }

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

    const upsertResults = await upsertAnswers(id, sendable);
    if (archives.length > 0) {
      await archiveAnswers(archives);
    }
    // Stamp "last edited" so the list can sort by most-recently-touched.
    await touchInspection(id);

    const elapsed = Date.now() - t0;
    if (elapsed > 5000) {
      console.warn(`[answers] slow autosave: ${elapsed}ms, upserts=${upserts.length}, archives=${archives.length}`);
    }

    return res.status(200).json({ success: true, results: [...upsertResults, ...overLimit], elapsedMs: elapsed });
  } catch (e: any) {
    reportServerError(e, { route: 'POST /api/inspections/[id]/answers', method: 'POST', userEmail: session.email, inspectionId: typeof id === 'string' ? id : undefined });
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
