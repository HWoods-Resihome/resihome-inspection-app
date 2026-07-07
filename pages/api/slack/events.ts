/**
 * POST /api/slack/events — Slack Events API endpoint for the Resiwalk bot.
 *
 * PHASE 1 (this file): the verified, access-gated SKELETON — no intelligence yet.
 * It proves the mechanics before any AI spend:
 *   1. verify the Slack signature (raw body + signing secret, replay-protected)
 *   2. answer the url_verification handshake (so Slack accepts the Request URL)
 *   3. dedupe Slack's retries (same event delivered more than once)
 *   4. ACK 200 in <3s, then do the work in the background via waitUntil()
 *   5. act only on @mentions / DMs from a human; ignore the bot's own posts
 *   6. gate to internal (@resihome/@resicap/@resipro) emails
 *   7. echo the question back in-thread (Phase 2 swaps this for real answers)
 *
 * Body parsing is DISABLED because the signature is computed over the exact raw
 * body — re-stringified JSON would not match. Fails closed if the signing secret
 * isn't configured.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { waitUntil } from '@vercel/functions';
import {
  verifySlackSignature, getBotUserId, getSlackUserEmail, isAllowedEmail,
  isActionableEvent, stripBotMention, postThreadReply, type SlackEvent,
} from '@/lib/slackBot';

export const config = { api: { bodyParser: false }, maxDuration: 60 };

// Best-effort in-memory dedupe of Slack's at-least-once delivery. Keyed by
// event_id with a short TTL. A cold start loses this, but combined with a fast
// ack (retries are rare) it's enough for Phase 1; Phase 2 can harden if needed.
const seen = new Map<string, number>();
const DEDUPE_TTL_MS = 5 * 60 * 1000;
function alreadyHandled(eventId: string | undefined): boolean {
  if (!eventId) return false;
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > DEDUPE_TTL_MS) seen.delete(k);
  if (seen.has(eventId)) return true;
  seen.set(eventId, now);
  if (seen.size > 1000) seen.clear();
  return false;
}

function readRawBody(req: NextApiRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }

  const rawBody = await readRawBody(req);
  let body: any = {};
  try { body = JSON.parse(rawBody); } catch { return res.status(400).json({ error: 'bad json' }); }

  // 1) URL verification handshake FIRST — before any signature/secret gate.
  //    It's a one-time, non-sensitive echo, and answering it here lets the Slack
  //    "Request URL" verify even before SLACK_SIGNING_SECRET has propagated. Real
  //    events (below) still require a valid signature.
  if (body.type === 'url_verification') {
    return res.status(200).json({ challenge: body.challenge });
  }

  // 2) Everything else must be a signed Slack request.
  if (!process.env.SLACK_SIGNING_SECRET) return res.status(503).json({ error: 'Slack events not configured' });
  const sig = req.headers['x-slack-signature'] as string | undefined;
  const ts = req.headers['x-slack-request-timestamp'] as string | undefined;
  if (!verifySlackSignature(rawBody, sig, ts)) {
    return res.status(401).json({ error: 'bad signature' });
  }

  // 3) Event callback: dedupe retries, then ACK immediately and process async.
  if (body.type === 'event_callback') {
    if (alreadyHandled(body.event_id)) return res.status(200).json({ ok: true, deduped: true });
    // Snapshot only serializable fields the worker needs (req is not usable after ack).
    const event = body.event as SlackEvent;
    res.status(200).json({ ok: true });
    waitUntil(handleEvent(event).catch((e) => console.error('[slack-events] worker failed:', e)));
    return;
  }

  // Anything else (e.g. app_rate_limited) — just ack.
  return res.status(200).json({ ok: true });
}

/**
 * Background worker (Phase 1: echo). Runs after the 200 ack via waitUntil so
 * Slack never sees a slow response. Phase 2 replaces the echo block with intent
 * routing + pricing / inspection answers.
 */
async function handleEvent(event: SlackEvent): Promise<void> {
  const botUserId = await getBotUserId();
  if (!isActionableEvent(event, botUserId)) return;

  const channel = event.channel || '';
  const threadTs = event.thread_ts || event.ts || '';
  if (!channel || !threadTs) return;

  // Internal-only gate. Resolve the asker's email; refuse anyone else.
  const email = await getSlackUserEmail(event.user || '');
  if (!isAllowedEmail(email)) {
    await postThreadReply(channel, threadTs, {
      text: 'Sorry — the Resiwalk assistant is available to Resihome staff only.',
    });
    return;
  }

  const question = stripBotMention(event.text, botUserId);
  if (!question) {
    await postThreadReply(channel, threadTs, {
      text: '👋 Hi! Ask me things like “when was the last scope completed at <address>”, “how many inspections did <name> complete this month”, or “how much to replace carpet and pad in a 3br in Nashville”.',
    });
    return;
  }

  // Phase 1 echo — confirms signing, gating, and threading end-to-end. Phase 2
  // swaps this for the intent router + real answers.
  await postThreadReply(channel, threadTs, {
    text: `👋 Got your question — answering these is coming online shortly:\n\n> ${question}`,
  });
}
