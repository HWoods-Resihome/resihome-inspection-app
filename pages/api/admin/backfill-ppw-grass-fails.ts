/**
 * GET /api/admin/backfill-ppw-grass-fails
 *
 * Back-posts the 1099 grass-fail → PPW dispatch Slack alert for every 1099
 * Leasing Agent inspection COMPLETED on/after a cutoff (default 2026-07-02) that
 * marked the grass/landscaping question as a Fail. Use this to catch up the
 * "#1099-agent-ppw-fails" channel for the window it went silent.
 *
 * SAFE: dry-run by default — open the URL signed in as an app admin to see which
 * inspections WOULD post. Add ?apply=1 to actually post to Slack. Idempotent:
 * postGrassFailAlertOnSubmit stamps each inspection (ppw_fail_alert_at) once it
 * posts to the live channel, so a re-run skips ones already sent.
 *
 * Query: ?since=YYYY-MM-DD (default 2026-07-02), ?apply=1, ?limit=N (default
 * 200), ?after=<n> to resume. Only leasing_agent_1099_property_inspection.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { fetchInspections, fetchAnswersForInspection } from '@/lib/hubspot';
import { isCompletedStatus } from '@/lib/userAccess';
import { postGrassFailAlertOnSubmit, findGrassAnswer, isGrassFail } from '@/lib/grassFailAlert';

export const config = { maxDuration: 300 };

const TEMPLATE = 'leasing_agent_1099_property_inspection';
const DEFAULT_SINCE = '2026-07-02';

/** Completion-ish timestamp for the window filter (ms), or null if none. */
function completedMs(i: { completedAt: string | null; submittedAt: string | null; updatedAt: string | null }): number | null {
  const raw = i.completedAt || i.submittedAt || i.updatedAt;
  if (!raw) return null;
  const ms = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.email))) return res.status(403).json({ error: 'Admin only.' });

  const apply = String(req.query.apply || '') === '1';
  const sinceStr = (String(req.query.since || '') || DEFAULT_SINCE).trim();
  const sinceMs = Date.parse(`${sinceStr}T00:00:00Z`);
  if (!Number.isFinite(sinceMs)) return res.status(400).json({ error: `bad since date: ${sinceStr}` });
  const startIdx = Math.max(0, Number(req.query.after) || 0);
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 200));
  const deadline = Date.now() + 250_000;

  const fwdHost = req.headers['x-forwarded-host'] || req.headers.host;
  const fwdProto = (req.headers['x-forwarded-proto'] as string) || 'https';
  const baseUrl = fwdHost ? `${fwdProto}://${fwdHost}` : undefined;

  try {
    const all = await fetchInspections();
    // 1099s completed within the window, oldest-first so the channel reads in order.
    const targets = all
      .filter((i) => i.templateType === TEMPLATE)
      .map((i) => ({ i, ms: completedMs(i) }))
      .filter((x) => x.ms != null && (x.ms as number) >= sinceMs)
      .sort((a, b) => (a.ms as number) - (b.ms as number))
      .map((x) => x.i);

    let processed = 0, posted = 0, skippedNoGrassFail = 0, skippedNoAnswers = 0,
      alreadyPosted = 0, errors = 0;
    // Split the no-answer records by whether they're actually COMPLETED. A
    // not-completed 1099 (scheduled/in-progress/cancelled) legitimately has no
    // submitted answers; a COMPLETED one with none would be a real anomaly worth
    // flagging (grass is required, so it should be there).
    let noAnswersNotCompleted = 0, noAnswersCompleted = 0;
    const noAnswerStatusCounts: Record<string, number> = {};
    const willPost: Array<{ id: string; address: string; response: string; when: string }> = [];
    const completedNoAnswerSamples: Array<{ id: string; status: string; when: string }> = [];
    const skippedSamples: string[] = [];
    const errorSamples: string[] = [];

    let idx = startIdx;
    for (; idx < targets.length && idx < startIdx + limit; idx++) {
      const insp = targets[idx];
      processed++;
      try {
        const answers = await fetchAnswersForInspection(insp.recordId);
        if (!answers.length) {
          skippedNoAnswers++;
          const status = (insp.status || '(blank)').trim() || '(blank)';
          noAnswerStatusCounts[status] = (noAnswerStatusCounts[status] || 0) + 1;
          // "Completed" = a completed status OR a completed_at stamp. Only those
          // are anomalies (a finished 1099 should carry the required grass answer).
          const looksCompleted = isCompletedStatus(insp.status) || !!insp.completedAt;
          if (looksCompleted) {
            noAnswersCompleted++;
            if (completedNoAnswerSamples.length < 20) {
              completedNoAnswerSamples.push({ id: insp.recordId, status, when: insp.completedAt || insp.submittedAt || insp.updatedAt || '' });
            }
          } else {
            noAnswersNotCompleted++;
          }
          continue;
        }
        const grass = findGrassAnswer(answers);
        if (!isGrassFail(grass)) {
          skippedNoGrassFail++;
          if (skippedSamples.length < 10) skippedSamples.push(`${insp.recordId}: grass=${(grass?.answerValue || 'none').trim()}`);
          continue;
        }

        const entry = {
          id: insp.recordId,
          address: insp.propertyAddressSnapshot || '',
          response: (grass!.answerValue || '').trim(),
          when: insp.completedAt || insp.submittedAt || insp.updatedAt || '',
        };

        if (apply) {
          const r = await postGrassFailAlertOnSubmit(
            { recordId: insp.recordId, propertyAddressSnapshot: entry.address, inspectorName: insp.inspectorName || '' },
            answers,
            { baseUrl },
          );
          if (r.posted) { posted++; willPost.push(entry); }
          else if ((r.reason || '').startsWith('gated')) { alreadyPosted++; }
          else {
            errors++;
            if (errorSamples.length < 10) errorSamples.push(`${insp.recordId}: ${r.reason || r.error}`);
          }
        } else {
          posted++; // would-post count in dry-run
          willPost.push(entry);
        }
      } catch (e: any) {
        errors++;
        if (errorSamples.length < 10) errorSamples.push(`${insp.recordId}: ${String(e?.message || e).slice(0, 160)}`);
        console.error(`[backfill-ppw-grass-fails] ${insp.recordId} failed:`, String(e?.message || e).slice(0, 200));
      }
      if (Date.now() > deadline) { idx++; break; }
    }

    const done = idx >= targets.length;
    const nextAfter = done ? null : idx;
    return res.status(200).json({
      ok: true,
      mode: apply ? 'apply' : 'dry-run (add ?apply=1 to post)',
      since: sinceStr,
      totalWindow1099s: targets.length,
      processed,
      [apply ? 'posted' : 'wouldPost']: posted,
      alreadyPosted,
      skippedNoGrassFail,
      skippedNoAnswers,
      // Breakdown of the no-answer records so "so many skipped" is explainable:
      // not-completed ones are expected (no submitted answers yet); completed
      // ones with no answers are a real anomaly to investigate.
      noAnswersNotCompleted,
      noAnswersCompleted,
      noAnswerStatusCounts,
      completedNoAnswerSamples,
      errors,
      done,
      nextAfter,
      resume: nextAfter != null
        ? `/api/admin/backfill-ppw-grass-fails?since=${sinceStr}&after=${nextAfter}&limit=${limit}${apply ? '&apply=1' : ''}`
        : null,
      sample: willPost.slice(0, 50),
      skippedSamples,
      errorSamples,
    });
  } catch (e: any) {
    console.error('[backfill-ppw-grass-fails] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
