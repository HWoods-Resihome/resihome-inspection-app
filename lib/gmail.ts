// Gmail send via the user's OAuth refresh token.
//
// Flow:
//   1. Read the encrypted refresh token from the request cookie
//   2. Trade it for a short-lived access token
//   3. Fetch each attachment (PDF/xlsx) from its HubSpot Files URL as bytes
//   4. Build a multipart/mixed MIME message (HTML body + attachments)
//   5. base64url-encode and POST to the Gmail send endpoint
//
// All composition (subject/body/recipients) lives in lib/email.ts. This file
// is purely the transport.

import type { NextApiRequest } from 'next';
import type { InspectionEmailPayload } from './email';
import {
  getGmailOAuthConfig,
  getGmailRefreshToken,
  refreshAccessToken,
} from './gmailAuth';

export interface SendInspectionEmailResult {
  sent: boolean;
  reason?:
    | 'gmail_not_configured'
    | 'gmail_not_connected'
    | 'gmail_token_expired'
    | 'send_failed';
  message?: string;
  recipients?: { to: string[]; cc: string[] };
  // Threading handles for a later follow-up (e.g. the SFTP error reply).
  messageId?: string;   // RFC822 Message-ID header we set on this message
  threadId?: string;    // Gmail thread id returned by the send
  subject?: string;     // the subject we sent (so a reply can "Re: …" it)
}

/** Generate an RFC822 Message-ID anchored to the sender's domain. */
export function newMessageId(seed: string, fromEmail: string): string {
  const domain = (fromEmail.split('@')[1] || 'resiwalk.com').trim();
  const rand = Math.random().toString(36).slice(2, 10);
  return `<resiwalk.${seed}.${Date.now()}.${rand}@${domain}>`;
}

/** RFC 2047 encode a header value if it contains non-ASCII (for subjects). */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Fetch a file URL and return its bytes. */
async function fetchAttachment(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`attachment fetch ${res.status} for ${url.slice(0, 80)}`);
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

/**
 * Build a multipart/mixed MIME message as a single string. Structure:
 *   multipart/mixed
 *     multipart/alternative
 *       text/plain
 *       text/html
 *     application/pdf (attachment) ...
 *     application/vnd...sheet (attachment) ...
 */
async function buildMimeMessage(
  payload: InspectionEmailPayload,
  fromEmail: string,
  extraHeaders?: { messageId?: string; inReplyTo?: string; references?: string }
): Promise<string> {
  const mixedBoundary = `mixed_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const altBoundary = `alt_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  const lines: string[] = [];
  lines.push(`From: ${fromEmail}`);
  lines.push(`To: ${payload.to.join(', ')}`);
  if (payload.cc.length > 0) lines.push(`Cc: ${payload.cc.join(', ')}`);
  lines.push(`Subject: ${encodeHeader(payload.subject)}`);
  // Our own Message-ID lets a later background job thread a reply to this exact
  // message (via In-Reply-To/References). Reply headers thread the follow-up.
  if (extraHeaders?.messageId) lines.push(`Message-ID: ${extraHeaders.messageId}`);
  if (extraHeaders?.inReplyTo) lines.push(`In-Reply-To: ${extraHeaders.inReplyTo}`);
  if (extraHeaders?.references) lines.push(`References: ${extraHeaders.references}`);
  lines.push('MIME-Version: 1.0');
  lines.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
  lines.push('');

  // alternative part (plain + html)
  lines.push(`--${mixedBoundary}`);
  lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
  lines.push('');
  lines.push(`--${altBoundary}`);
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('');
  lines.push(Buffer.from(payload.textBody, 'utf8').toString('base64'));
  lines.push('');
  lines.push(`--${altBoundary}`);
  lines.push('Content-Type: text/html; charset="UTF-8"');
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('');
  lines.push(Buffer.from(payload.htmlBody, 'utf8').toString('base64'));
  lines.push('');
  lines.push(`--${altBoundary}--`);
  lines.push('');

  // attachments. Gmail rejects messages over ~25 MB (the whole base64-encoded
  // message), bouncing with "An error occurred. Your message was not sent." We
  // cap the cumulative RAW attachment bytes well under that (base64 inflates
  // ~33%); any attachment that would push us over is skipped — recipients still
  // get it from the download Links in the email body.
  const MAX_TOTAL_ATTACH_BYTES = 17 * 1024 * 1024;
  let attachBytes = 0;
  for (const att of payload.attachments) {
    let bytes: Buffer;
    try {
      bytes = await fetchAttachment(att.url);
    } catch (e) {
      console.error(`[gmail] skipping attachment (fetch failed): ${att.filename}`, e);
      continue;
    }
    if (attachBytes + bytes.length > MAX_TOTAL_ATTACH_BYTES) {
      console.warn(`[gmail] skipping attachment (size cap ${MAX_TOTAL_ATTACH_BYTES} exceeded): ${att.filename} (${bytes.length} bytes; ${attachBytes} already attached) — available via the email's download links`);
      continue;
    }
    attachBytes += bytes.length;
    lines.push(`--${mixedBoundary}`);
    lines.push(`Content-Type: ${att.mimeType}; name="${att.filename}"`);
    lines.push('Content-Transfer-Encoding: base64');
    lines.push(`Content-Disposition: attachment; filename="${att.filename}"`);
    lines.push('');
    // Wrap base64 at 76 chars per MIME convention
    const b64 = bytes.toString('base64').replace(/(.{76})/g, '$1\r\n');
    lines.push(b64);
    lines.push('');
  }

  lines.push(`--${mixedBoundary}--`);
  return lines.join('\r\n');
}

/** Convert a MIME string to base64url (Gmail's required raw format). */
function toBase64Url(s: string): string {
  return Buffer.from(s, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Send the inspection email on behalf of the logged-in user.
 *
 * `req` is needed to read the encrypted refresh-token cookie. `userEmail`
 * comes from the session and is used as the From address.
 */
export async function sendInspectionEmail(
  payload: InspectionEmailPayload,
  userEmail: string,
  req: NextApiRequest
): Promise<SendInspectionEmailResult> {
  const cfg = getGmailOAuthConfig();
  if (!cfg) {
    console.log('[sendInspectionEmail] Gmail not configured. Would have sent:');
    console.log('  To:', payload.to.join(', '), '| Cc:', payload.cc.join(', '));
    console.log('  Subject:', payload.subject);
    console.log('  Attachments:', payload.attachments.map((a) => a.filename).join(', '));
    return {
      sent: false,
      reason: 'gmail_not_configured',
      message: 'Gmail OAuth not configured on the server. Email skipped.',
      recipients: { to: payload.to, cc: payload.cc },
    };
  }

  const refreshToken = getGmailRefreshToken(req);
  if (!refreshToken) {
    return {
      sent: false,
      reason: 'gmail_not_connected',
      message: 'Gmail not connected. Connect your account to enable email.',
      recipients: { to: payload.to, cc: payload.cc },
    };
  }

  let accessToken: string;
  try {
    accessToken = await refreshAccessToken(cfg, refreshToken);
  } catch (e) {
    console.error('[sendInspectionEmail] refresh failed:', e);
    return {
      sent: false,
      reason: 'gmail_token_expired',
      message: 'Gmail authorization expired. Please reconnect your account.',
      recipients: { to: payload.to, cc: payload.cc },
    };
  }

  try {
    const messageId = newMessageId('insp', userEmail);
    const mime = await buildMimeMessage(payload, userEmail, { messageId });
    const raw = toBase64Url(mime);
    const res = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ raw }),
      }
    );
    if (!res.ok) {
      const text = await res.text();
      console.error('[sendInspectionEmail] Gmail send failed:', res.status, text.slice(0, 300));
      return {
        sent: false,
        reason: 'send_failed',
        message: `Gmail rejected the message (${res.status}).`,
        recipients: { to: payload.to, cc: payload.cc },
      };
    }
    const sendData = await res.json().catch(() => ({} as any));
    return {
      sent: true,
      recipients: { to: payload.to, cc: payload.cc },
      messageId,
      threadId: sendData?.threadId ? String(sendData.threadId) : undefined,
      subject: payload.subject,
    };
  } catch (e: any) {
    console.error('[sendInspectionEmail] send threw:', e);
    return {
      sent: false,
      reason: 'send_failed',
      message: String(e?.message || e).slice(0, 200),
      recipients: { to: payload.to, cc: payload.cc },
    };
  }
}

// ---------------------------------------------------------------------------
// Background reply sender (used by the SFTP-watch cron).
//
// Unlike sendInspectionEmail (which reads the token from the request cookie),
// this takes a refresh token explicitly — the cron has no cookie — and sends a
// reply threaded to an existing message, with ONE in-memory attachment (the
// error CSV downloaded from the SFTP). Never throws.
// ---------------------------------------------------------------------------
export interface ReplyEmailInput {
  refreshToken: string;
  fromEmail: string;
  to: string[];
  cc?: string[];
  subject: string;          // already-prefixed (e.g. "Re: ...")
  htmlBody: string;
  textBody: string;
  inReplyToMessageId?: string;
  threadId?: string;
  attachments?: Array<{ filename: string; content: Buffer; mimeType: string }>;
}

function buildReplyMime(input: ReplyEmailInput): string {
  const mixedBoundary = `mixed_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const altBoundary = `alt_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const lines: string[] = [];
  lines.push(`From: ${input.fromEmail}`);
  lines.push(`To: ${input.to.join(', ')}`);
  if (input.cc && input.cc.length) lines.push(`Cc: ${input.cc.join(', ')}`);
  lines.push(`Subject: ${encodeHeader(input.subject)}`);
  lines.push(`Message-ID: ${newMessageId('sftp', input.fromEmail)}`);
  if (input.inReplyToMessageId) {
    lines.push(`In-Reply-To: ${input.inReplyToMessageId}`);
    lines.push(`References: ${input.inReplyToMessageId}`);
  }
  lines.push('MIME-Version: 1.0');
  lines.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
  lines.push('');
  lines.push(`--${mixedBoundary}`);
  lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
  lines.push('');
  lines.push(`--${altBoundary}`);
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('');
  lines.push(Buffer.from(input.textBody, 'utf8').toString('base64'));
  lines.push('');
  lines.push(`--${altBoundary}`);
  lines.push('Content-Type: text/html; charset="UTF-8"');
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('');
  lines.push(Buffer.from(input.htmlBody, 'utf8').toString('base64'));
  lines.push('');
  lines.push(`--${altBoundary}--`);
  lines.push('');
  for (const att of input.attachments || []) {
    lines.push(`--${mixedBoundary}`);
    lines.push(`Content-Type: ${att.mimeType}; name="${att.filename}"`);
    lines.push('Content-Transfer-Encoding: base64');
    lines.push(`Content-Disposition: attachment; filename="${att.filename}"`);
    lines.push('');
    lines.push(att.content.toString('base64').replace(/(.{76})/g, '$1\r\n'));
    lines.push('');
  }
  lines.push(`--${mixedBoundary}--`);
  return lines.join('\r\n');
}

export async function sendReplyEmailWithToken(
  input: ReplyEmailInput
): Promise<{ sent: boolean; error?: string }> {
  const cfg = getGmailOAuthConfig();
  if (!cfg) return { sent: false, error: 'gmail_not_configured' };
  let accessToken: string;
  try {
    accessToken = await refreshAccessToken(cfg, input.refreshToken);
  } catch (e: any) {
    return { sent: false, error: `token_refresh_failed: ${String(e?.message || e).slice(0, 120)}` };
  }
  try {
    const raw = toBase64Url(buildReplyMime(input));
    const body: Record<string, any> = { raw };
    if (input.threadId) body.threadId = input.threadId; // keep it in the same Gmail thread
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { sent: false, error: `gmail_${res.status}: ${text.slice(0, 160)}` };
    }
    return { sent: true };
  } catch (e: any) {
    return { sent: false, error: String(e?.message || e).slice(0, 160) };
  }
}
