/**
 * Gmail READ access for the SYSTEM mailbox — used by the notes-inbox cron to
 * ingest email replies into service note threads. Uses the same
 * SYSTEM_GMAIL_REFRESH_TOKEN as sending; reading additionally requires the
 * token to carry a read scope (gmail.modify covers list/get/mark-read). When
 * the scope is missing, calls fail with a 403 and callers degrade gracefully
 * (notes still work in-app; only reply-by-email ingestion pauses).
 */
import { getGmailOAuthConfig, refreshAccessToken } from './gmailAuth';

async function systemAccessToken(): Promise<string | null> {
  const cfg = getGmailOAuthConfig();
  const refreshToken = process.env.SYSTEM_GMAIL_REFRESH_TOKEN || '';
  if (!cfg || !refreshToken) return null;
  try { return await refreshAccessToken(cfg, refreshToken); }
  catch (e: any) { console.warn('[gmail-read] token refresh failed:', String(e?.message || e).slice(0, 120)); return null; }
}

async function gmailGet(token: string, path: string): Promise<any> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`gmail_${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
  return res.json();
}

export interface InboundMessage {
  id: string;
  subject: string;
  fromEmail: string;
  bodyText: string;      // plain-text body (best part available), reply-quoting stripped by caller
}

/** Unread inbox messages matching a Gmail search query. Returns [] without read
 *  scope/config (logged once per run by the caller via the thrown error). */
// Search the system mailbox with the caller's query verbatim — NOT restricted to
// `in:inbox` or `is:unread`. Reply-by-email ingestion relies on this: a reply
// that a filter routed out of the inbox, or that got marked read in a shared
// mailbox, must still be found (idempotency downstream stops re-posting). Callers
// scope recency themselves (e.g. `newer_than:30d`).
export async function listRecentInbox(query: string, max = 30): Promise<{ token: string; ids: string[] } | null> {
  const token = await systemAccessToken();
  if (!token) return null;
  const q = encodeURIComponent(query);
  const data = await gmailGet(token, `messages?q=${q}&maxResults=${max}`);
  return { token, ids: (data.messages || []).map((m: any) => String(m.id)) };
}

function b64urlDecode(s: string): string {
  try { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); }
  catch { return ''; }
}

// Depth-first hunt for the best text part: prefer text/plain, fall back to
// text/html stripped of tags.
function extractText(payload: any): string {
  if (!payload) return '';
  const stack = [payload];
  let html = '';
  while (stack.length) {
    const part = stack.shift();
    const mime = String(part?.mimeType || '');
    const data = part?.body?.data;
    if (mime === 'text/plain' && data) return b64urlDecode(data);
    if (mime === 'text/html' && data && !html) html = b64urlDecode(data);
    for (const child of part?.parts || []) stack.push(child);
  }
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<blockquote[\s\S]*$/gi, ' ')      // quoted reply history
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}

/** Full message → subject / sender / plain-text body. */
export async function getInboundMessage(token: string, id: string): Promise<InboundMessage | null> {
  const data = await gmailGet(token, `messages/${id}?format=full`).catch(() => null);
  if (!data) return null;
  const headers: Array<{ name: string; value: string }> = data.payload?.headers || [];
  const h = (name: string) => headers.find((x) => x.name?.toLowerCase() === name.toLowerCase())?.value || '';
  const fromRaw = h('from');
  const m = /<([^>]+)>/.exec(fromRaw);
  const fromEmail = (m ? m[1] : fromRaw).trim().toLowerCase();
  return { id, subject: h('subject'), fromEmail, bodyText: extractText(data.payload) };
}

/** Mark a message read so the next sweep skips it. Best-effort. */
export async function markMessageRead(token: string, id: string): Promise<void> {
  try {
    await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/modify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
    });
  } catch (e: any) { console.warn('[gmail-read] mark-read failed:', String(e?.message || e).slice(0, 120)); }
}

/** Strip quoted history AND the sender's signature from a plain-text email
 *  reply, keeping only the fresh message text. */
export function stripQuotedReply(body: string): string {
  const lines = String(body || '').replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  const hasContent = () => out.some((l) => l.trim());
  for (const line of lines) {
    // Common reply-history markers — everything after them is quoted.
    if (/^\s*On .{5,200} wrote:\s*$/.test(line)) break;
    if (/^\s*-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    if (/^\s*From:\s.+@.+/i.test(line) && hasContent()) break;
    if (/^\s*>/.test(line)) continue;                 // inline-quoted line
    // Signature markers — everything after them is the sig block.
    if (/^\s*--\s*$/.test(line)) break;                        // RFC sig delimiter
    if (/^\s*_{3,}\s*$/.test(line)) break;                     // Outlook-style rule
    if (/^\s*(Sent from|Sent via|Get Outlook)/i.test(line)) break;   // mobile-client sigs
    if (hasContent()) {
      // A bare sign-off line ("Thanks," / "Best regards") — the sig follows.
      if (/^\s*(thanks|thank you|many thanks|best|best regards|kind regards|regards|sincerely|cheers)\s*[,.!]?\s*$/i.test(line)) break;
      // Gmail plain-text renders a bold signature name as "*Hayden Woods, CFA*"
      // — a full line wrapped in asterisks starts the sig block.
      if (/^\s*\*[^*].{0,80}\*+\s*$/.test(line)) break;
    }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
