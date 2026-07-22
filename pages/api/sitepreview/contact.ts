/**
 * POST /api/sitepreview/contact — the ResiWalk preview site's "Contact us" form.
 *
 * Emails the inquiry to the ResiWalk team (eric.williams@ + hwoods@) via the
 * system mailbox (sendSystemEmail). Public (no session) — validated + rate-
 * limited + honeypotted so it can't be abused as an open relay/spam sink.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { sendSystemEmail } from '@/lib/gmail';
import { enforceRateLimit } from '@/lib/rateLimit';

const RECIPIENTS = ['eric.williams@resihome.com', 'hwoods@resihome.com'];

const clip = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  if (enforceRateLimit(res, { key: ip, route: 'sitepreview-contact', max: 5, windowMs: 15 * 60_000 })) return;

  try {
    const b = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})) as Record<string, unknown>;

    // Honeypot: bots fill hidden fields. Silently accept, send nothing.
    if (clip(b.website, 1)) return res.status(200).json({ ok: true });

    const name = clip(b.name, 200);
    const email = clip(b.email, 200);
    const company = clip(b.company, 200);
    const phone = clip(b.phone, 60);
    const message = clip(b.message, 5000);

    if (!name || !email || !message) return res.status(400).json({ error: 'Please complete your name, email, and message.' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });

    const subject = `ResiWalk inquiry — ${name}${company ? ` (${company})` : ''}`;
    const rows: [string, string][] = [
      ['Name', name], ['Company', company || '—'], ['Email', email], ['Phone', phone || '—'],
    ];
    const htmlBody = `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1b1b1f">
        <div style="background:#ff0060;color:#fff;padding:18px 22px;border-radius:12px 12px 0 0">
          <h2 style="margin:0;font-size:18px">New ResiWalk website inquiry</h2>
        </div>
        <div style="border:1px solid #eee;border-top:0;border-radius:0 0 12px 12px;padding:22px">
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            ${rows.map(([k, v]) => `<tr><td style="padding:6px 0;color:#777;width:110px">${k}</td><td style="padding:6px 0;font-weight:600">${esc(v)}</td></tr>`).join('')}
          </table>
          <div style="margin-top:16px;padding-top:16px;border-top:1px solid #eee">
            <div style="color:#777;font-size:13px;margin-bottom:6px">Message</div>
            <div style="white-space:pre-wrap;font-size:14px;line-height:1.5">${esc(message)}</div>
          </div>
          <div style="margin-top:18px;font-size:12px;color:#999">Submitted via resiwalk.com/sitepreview · reply directly to ${esc(email)}</div>
        </div>
      </div>`;
    const textBody = `New ResiWalk website inquiry\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nMessage:\n${message}\n\n— resiwalk.com/sitepreview`;

    let sent = 0;
    for (const to of RECIPIENTS) {
      const r = await sendSystemEmail({ to, subject, htmlBody, textBody });
      if (r.sent) sent++;
      else console.warn(`[sitepreview-contact] send to ${to} failed:`, r.error);
    }
    if (!sent) return res.status(502).json({ error: 'We couldn’t send your message right now — please email eric.williams@resihome.com directly.' });

    return res.status(200).json({ ok: true });
  } catch (e: any) {
    console.error('[sitepreview-contact] failed:', e);
    return res.status(500).json({ error: 'Something went wrong — please try again.' });
  }
}
