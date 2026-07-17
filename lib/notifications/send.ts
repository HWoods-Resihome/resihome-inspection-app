/**
 * ResiWalk notification email sender. Composes a compact, on-brand transactional
 * email (pink header, meta rows, a primary action button, optional PDF attachment)
 * and sends it from the SYSTEM mailbox — so it works from crons and from actions
 * triggered by a different user than the recipient. Best-effort: never throws.
 *
 * Requires SYSTEM_GMAIL_REFRESH_TOKEN + SYSTEM_GMAIL_FROM (same as the sign-in
 * code emails). Without them it logs and returns { sent:false } so callers stay
 * unaffected.
 */
import { sendReplyEmailWithToken } from '@/lib/gmail';

const BRAND = '#ff0060';

/** App base URL for in-email links. Prefers the request host (when a live
 *  request is driving the send), else APP_PUBLIC_URL, else the prod domain. */
export function appBaseUrl(req?: { headers: Record<string, any> } | null): string {
  const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host;
  if (host) { const proto = (req?.headers?.['x-forwarded-proto'] as string) || 'https'; return `${proto}://${host}`; }
  return (process.env.APP_PUBLIC_URL || 'https://resiwalk.com').replace(/\/+$/, '');
}

function esc(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export interface NotificationEmail {
  to: string;
  /** Extra To recipients beyond the primary (e.g. a community RRQC distribution
   *  address). De-duped against `to`; invalid/blank entries are dropped. */
  alsoTo?: string[];
  subject: string;
  heading: string;           // pink header title
  intro: string;             // one-line lead paragraph
  rows: Array<[string, string]>;   // meta label/value pairs
  linkUrl: string;
  linkLabel: string;
  /** Optional PDF (or other) attachment — bytes already in memory. */
  attachment?: { filename: string; content: Buffer; mimeType: string } | null;
}

function buildHtml(e: NotificationEmail): string {
  const rows = e.rows.filter(([, v]) => String(v || '').trim()).map(([k, v]) => `
    <tr>
      <td style="padding:3px 0;width:140px;color:#6b7280;font-size:13px;">${esc(k)}</td>
      <td style="padding:3px 0;font-size:13px;"><strong>${esc(v)}</strong></td>
    </tr>`).join('');
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f9fafb;padding:24px 0;"><tr><td align="center">
    <table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
      <tr><td style="background:${BRAND};padding:18px 24px;color:#ffffff;">
        <div style="font-size:18px;font-weight:bold;">${esc(e.heading)}</div>
      </td></tr>
      <tr><td style="padding:18px 24px 6px 24px;font-size:14px;color:#1a1a1a;">${esc(e.intro)}</td></tr>
      ${rows ? `<tr><td style="padding:6px 24px 8px 24px;"><table cellpadding="0" cellspacing="0" border="0" width="100%">${rows}</table></td></tr>` : ''}
      <tr><td style="padding:12px 24px 20px 24px;">
        <a href="${esc(e.linkUrl)}" style="display:inline-block;background:${BRAND};color:#ffffff;text-decoration:none;font-weight:bold;font-size:14px;padding:11px 20px;border-radius:8px;">${esc(e.linkLabel)}</a>
      </td></tr>
      <tr><td style="padding:14px 24px;background:#f9fafb;text-align:center;font-size:11px;color:#6b7280;border-top:1px solid #e5e7eb;">
        Sent from ResiWalk. Manage these emails under Settings → Notification Settings.
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
}

function buildText(e: NotificationEmail): string {
  const lines = [e.heading, '', e.intro, ''];
  for (const [k, v] of e.rows) if (String(v || '').trim()) lines.push(`${k}: ${v}`);
  lines.push('', `${e.linkLabel}: ${e.linkUrl}`, '', '-- Sent from ResiWalk. Manage these emails under Settings → Notification Settings.');
  return lines.join('\n');
}

/** Send one notification email from the system mailbox. Never throws. */
export async function sendNotificationEmail(e: NotificationEmail): Promise<{ sent: boolean; error?: string }> {
  const refreshToken = process.env.SYSTEM_GMAIL_REFRESH_TOKEN || '';
  const fromEmail = process.env.SYSTEM_GMAIL_FROM || '';
  if (!refreshToken || !fromEmail) {
    console.warn('[notify] SYSTEM_GMAIL_* not configured — skipping notification email to', e.to);
    return { sent: false, error: 'system_email_not_configured' };
  }
  try {
    // Primary recipient + any extra To addresses, trimmed, valid, de-duped
    // (case-insensitively), preserving order with `to` first.
    const seen = new Set<string>();
    const toList = [e.to, ...(e.alsoTo || [])]
      .map((x) => String(x || '').trim())
      .filter((x) => {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)) return false;
        const k = x.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    return await sendReplyEmailWithToken({
      refreshToken, fromEmail, fromName: process.env.SYSTEM_GMAIL_FROM_NAME || 'ResiWalk',
      to: toList,
      subject: e.subject, htmlBody: buildHtml(e), textBody: buildText(e),
      attachments: e.attachment ? [e.attachment] : [],
    });
  } catch (err: any) {
    console.warn('[notify] send threw:', String(err?.message || err).slice(0, 160));
    return { sent: false, error: String(err?.message || err).slice(0, 160) };
  }
}

/** Fetch a stored file URL to a Buffer for attaching (best-effort → null). */
export async function fetchToBuffer(url: string): Promise<Buffer | null> {
  try {
    const r = await fetch(String(url || '').split('#')[0]);
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch { return null; }
}
