/**
 * lib/slackBot.ts — inbound Slack helpers for the conversational Resiwalk bot.
 *
 * The existing Resiwalk Slack app (SLACK_BOT_TOKEN) now ALSO receives events
 * (@mentions + DMs) at /api/slack/events. This module holds the reusable,
 * intelligence-free plumbing so Phase 2 (intent routing + pricing/inspection
 * answers) can build on a verified, access-gated foundation:
 *
 *   - verifySlackSignature()  request authenticity (HMAC v0 + 5-min replay window)
 *   - getBotUserId()          the bot's own user id (to ignore its own messages)
 *   - getSlackUserEmail()     Slack user -> email (for the internal-only gate)
 *   - isActionableEvent()     mention / DM from a human — never a bot/self/edit
 *   - stripBotMention()       remove the leading "<@BOT>" from an @mention
 *   - postThreadReply()       reply in-thread (primary card; supplements follow)
 *
 * Access policy: only internal staff may use the bot. We reuse the app's own
 * definition of "internal" (isInternalEmail → resihome.com / resicap.com /
 * resipro.com) so it stays consistent with every other server-side gate.
 */
import crypto from 'crypto';
import { postSlackMessage, type SlackPostResult } from '@/lib/slack';
import { isInternalEmail } from '@/lib/userAccess';

const BOT_TOKEN = () => (process.env.SLACK_BOT_TOKEN || '').trim();

/**
 * Verify a Slack request signature. Slack signs EVERY request (including the
 * url_verification handshake) as `v0:{timestamp}:{rawBody}` HMAC-SHA256 with the
 * app signing secret. Requires the UNPARSED raw body — the endpoint disables
 * Next's body parser and reads the stream. Rejects requests older than 5 minutes
 * (replay protection). Returns false (fail-closed) when the secret isn't set.
 */
export function verifySlackSignature(rawBody: string, signature: string | undefined, timestamp: string | undefined): boolean {
  const secret = (process.env.SLACK_SIGNING_SECRET || '').trim();
  if (!secret || !signature || !timestamp) return false;
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  // Replay window: 60 * 5 seconds. Date.now() is fine here (server runtime).
  if (Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const base = `v0:${timestamp}:${rawBody}`;
  const mine = 'v0=' + crypto.createHmac('sha256', secret).update(base).digest('hex');
  try {
    const a = Buffer.from(mine);
    const b = Buffer.from(signature);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// The bot's own user id — cached process-wide. Used to ignore the bot's own
// messages (a DM reply echoes back as a message event; without this the bot
// would answer itself in a loop).
let _botUserId: { id: string; at: number } | null = null;
export async function getBotUserId(): Promise<string> {
  if (_botUserId && Date.now() - _botUserId.at < 60 * 60 * 1000) return _botUserId.id;
  const token = BOT_TOKEN();
  if (!token) return '';
  try {
    const r = await fetch('https://slack.com/api/auth.test', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json().catch(() => ({} as any));
    const id = j?.ok ? String(j.user_id || '') : '';
    if (id) _botUserId = { id, at: Date.now() };
    return id;
  } catch { return ''; }
}

/** Resolve a Slack user id → email (needs users:read.email). '' when unknown. */
export async function getSlackUserEmail(userId: string): Promise<string> {
  const token = BOT_TOKEN();
  if (!token || !userId) return '';
  try {
    const r = await fetch(`https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const j = await r.json().catch(() => ({} as any));
    return j?.ok ? String(j.user?.profile?.email || '') : '';
  } catch { return ''; }
}

/** Only internal staff may use the bot. */
export function isAllowedEmail(email: string | null | undefined): boolean {
  return isInternalEmail(email);
}

export interface SlackEvent {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  channel?: string;
  channel_type?: string; // 'im' for DMs
  ts?: string;
  thread_ts?: string;
  app_id?: string;
}

/**
 * Is this an event we should answer? Yes for an @mention, or a DM (message with
 * channel_type 'im'). NEVER for a message from a bot (bot_id set), the bot itself,
 * or an edit/delete/system subtype — those guards prevent self-answer loops now
 * that the SAME app both posts notifications and listens.
 */
export function isActionableEvent(ev: SlackEvent | undefined, botUserId: string): boolean {
  if (!ev) return false;
  if (ev.bot_id) return false;                       // any bot (including our own posts)
  if (ev.user && botUserId && ev.user === botUserId) return false; // self
  if (ev.type === 'app_mention') return true;
  if (ev.type === 'message') {
    if (ev.subtype) return false;                    // message_changed / deleted / join / etc.
    if (ev.channel_type === 'im') return true;       // direct message to the bot
  }
  return false;
}

/** Strip a leading "<@UBOT>" (and stray whitespace) from an @mention's text. */
export function stripBotMention(text: string | undefined, botUserId: string): string {
  let t = (text || '').trim();
  if (botUserId) t = t.replace(new RegExp(`<@${botUserId}>`, 'g'), '').trim();
  // Also drop any other leading user mention token just in case.
  t = t.replace(/^<@[^>]+>\s*/, '').trim();
  return t;
}

/** Reply in the same thread. New top-level messages start their own thread. */
export async function postThreadReply(
  channel: string,
  threadTs: string,
  opts: { text: string; blocks?: any[] },
): Promise<SlackPostResult> {
  return postSlackMessage(channel, { text: opts.text, blocks: opts.blocks, thread_ts: threadTs });
}
