import type { NextApiRequest, NextApiResponse } from 'next';
import { recordAiFeedback, type AiFeedbackEvent } from '@/lib/aiFeedback';
import { maybeRefreshLearnedKnowledge } from '@/lib/aiKnowledgeLearning';

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

  try {
    const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {});
    const raw: any[] = Array.isArray(body?.events) ? body.events
      : Array.isArray(body) ? body
      : body ? [body] : [];

    // Cap the batch so a misbehaving client can't storm the blob store.
    const events = raw.filter((e) => e && typeof e === 'object' && e.source && e.decision).slice(0, 100);
    await Promise.all(events.map((e) => recordAiFeedback(e as AiFeedbackEvent)));
    // Near-real-time learning: fold new feedback into the AI Knowledge base
    // (throttled to ~once / 3 min across the fleet, only when there's activity).
    if (events.length) await maybeRefreshLearnedKnowledge();
  } catch {
    /* swallow — feedback capture must never fail loudly */
  }

  return res.status(204).end();
}

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}
