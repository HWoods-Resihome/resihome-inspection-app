/**
 * lib/slack.ts — minimal Slack chat.postMessage helper (Bot token).
 *
 * Requires SLACK_BOT_TOKEN (xoxb-…) and the bot to be a member of the target
 * channel. Best-effort: returns { ok:false, error } instead of throwing, so a
 * Slack outage never blocks the caller (e.g. an inspection submit).
 */
export interface SlackPostResult { ok: boolean; ts?: string; channel?: string; error?: string }

export async function postSlackMessage(
  channel: string,
  opts: { text: string; blocks?: any[]; attachments?: any[]; thread_ts?: string },
): Promise<SlackPostResult> {
  const token = (process.env.SLACK_BOT_TOKEN || '').trim();
  if (!token) return { ok: false, error: 'SLACK_BOT_TOKEN not set' };
  if (!channel) return { ok: false, error: 'no channel' };
  try {
    const resp = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel, text: opts.text, blocks: opts.blocks, attachments: opts.attachments, thread_ts: opts.thread_ts, unfurl_links: false }),
    });
    const j = await resp.json().catch(() => ({} as any));
    if (!j.ok) return { ok: false, channel, error: String(j.error || `http ${resp.status}`) };
    return { ok: true, ts: j.ts, channel: j.channel || channel };
  } catch (e: any) {
    return { ok: false, channel, error: String(e?.message || e).slice(0, 200) };
  }
}

/** Low-level Slack Web API POST (JSON). Returns the raw response object. */
export async function slackCall(method: string, body: any): Promise<any> {
  const token = (process.env.SLACK_BOT_TOKEN || '').trim();
  if (!token) return { ok: false, error: 'SLACK_BOT_TOKEN not set' };
  try {
    const resp = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });
    return await resp.json().catch(() => ({ ok: false, error: `http ${resp.status}` }));
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

/** chat.getPermalink → permalink string, or '' on failure. */
export async function getSlackPermalink(channel: string, ts: string): Promise<string> {
  const token = (process.env.SLACK_BOT_TOKEN || '').trim();
  if (!token || !channel || !ts) return '';
  try {
    const url = `https://slack.com/api/chat.getPermalink?channel=${encodeURIComponent(channel)}&message_ts=${encodeURIComponent(ts)}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const j = await resp.json().catch(() => ({} as any));
    return j.ok && j.permalink ? String(j.permalink) : '';
  } catch {
    return '';
  }
}
