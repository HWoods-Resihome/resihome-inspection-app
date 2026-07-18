import type { NextApiRequest, NextApiResponse } from 'next';
import { recordAiFeedback, type AiFeedbackEvent } from '@/lib/aiFeedback';
import { maybeRefreshLearnedKnowledge } from '@/lib/aiKnowledgeLearning';
import { getSessionFromRequest } from '@/lib/auth';
import { enforceRateLimit } from '@/lib/rateLimit';
import { isExternalEmail } from '@/lib/userAccess';

/**
 * Sink for AI feedback events (see lib/aiFeedbackClient.ts) — how a human
 * responded to an AI suggestion. Persists each event via recordAiFeedback for
 * the self-improvement flywheel (few-shot examples, catalog tuning, evals).
 *
 * Like the telemetry sink, this never errors loudly: a dropped feedback event
 * must never surface to the inspector. Accepts a single event or a batch.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // AUTH REQUIRED. These events flow into maybeRefreshLearnedKnowledge(), which
  // folds them into the AI Knowledge base that is concatenated verbatim into the
  // LIVE room-scan / voice / ai-review system prompts as "authoritative guidance".
  // An unauthenticated caller could therefore poison pricing suggestions and inject
  // arbitrary text into every AI prompt fleet-wide. The beacon always carries the
  // auth cookie, so legitimate clients are unaffected.
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  // Per-user cap — this feeds the learned KB folded into every AI prompt.
  if (enforceRateLimit(res, { key: session.email || 'anon', route: 'ai-feedback', max: 60, windowMs: 60_000 })) return;

  try {
    const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {});
    const raw: any[] = Array.isArray(body?.events) ? body.events
      : Array.isArray(body) ? body
      : body ? [body] : [];

    // Stamp WHO made the decision from the session (server-authoritative — the
    // client never supplies identity). Whoever is signed in when they hit "Apply"
    // is recorded: the inspector during the inspection, or the APPROVER during
    // review. This is what lets Insights attribute an approver's AI edits to the
    // approver instead of the inspection's original inspector.
    const actorEmail = session.email || undefined;
    const actorName = session.name || undefined;

    // Cap the batch so a misbehaving client can't storm the blob store.
    const events = raw.filter((e) => e && typeof e === 'object' && e.source && e.decision).slice(0, 100);
    await Promise.all(events.map((e) =>
      recordAiFeedback({ ...(e as AiFeedbackEvent), actorEmail, actorName })));
    // Near-real-time learning: fold new feedback into the AI Knowledge base
    // (throttled to ~once / 3 min across the fleet, only when there's activity).
    // Gate the fold to INTERNAL users — the learned KB is injected into every AI
    // prompt fleet-wide, so an external (1099/vendor) account must not be able to
    // shape it. Their feedback is still recorded above (attribution/insights); it
    // just doesn't drive the shared KB. (The prompts also now treat the KB as
    // untrusted data, so embedded instructions can't steer a verdict regardless.)
    if (events.length && !isExternalEmail(session.email)) await maybeRefreshLearnedKnowledge();
  } catch {
    /* swallow — feedback capture must never fail loudly */
  }

  return res.status(204).end();
}

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}
