/**
 * Inspection-milestone celebration email (1,000 / 2,500 / 5,000 / 10,000). Sent
 * to the inspector who LOGGED the milestone inspection — a company-wide moment
 * that lands on their walk — with a call to email Hayden & Eric for a prize.
 *
 * buildMilestoneEmail() returns the subject + HTML/text. sendMilestoneEmail()
 * sends it from the system mailbox to one recipient (used by both the admin
 * preview button and the live milestone trigger).
 */
import { sendReplyEmailWithToken } from '@/lib/gmail';

const PINK = '#ff0060';
const PINK_DEEP = '#c8004d';
const TEAL = '#73e3df';
const INK = '#0f1115';

// Prize claims go to Hayden AND Eric (both on the To line). Overridable via env
// (comma-separated) if the recipients ever change.
const PRIZE_RECIPIENTS = (process.env.MILESTONE_PRIZE_TO || 'hwoods@resihome.com,eric.williams@resihome.com')
  .split(',').map((s) => s.trim()).filter(Boolean);

function esc(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function buildMilestoneEmail(opts: { count?: number; recipientName?: string } = {}): { subject: string; html: string; text: string } {
  const name = (opts.recipientName || '').trim();
  const greeting = name ? `Congratulations, ${esc(name)}!` : 'Congratulations!';
  const n = opts.count ?? 1000;
  const count = n.toLocaleString();
  const to = PRIZE_RECIPIENTS.join(',');
  const prizeMailto = `mailto:${to}?subject=${encodeURIComponent(`My ${count}th Inspection Prize 🎉`)}&body=${encodeURIComponent(`Hi Hayden & Eric — I just logged ResiWalk's ${count}th completed inspection and would love to claim my prize!`)}`;

  const subject = `🎉 You logged ResiWalk's ${count}th inspection!`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:${INK};">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f5f7;padding:28px 12px;"><tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 6px 24px rgba(0,0,0,0.10);">

      <!-- Celebration header -->
      <tr><td style="background:${PINK};background:linear-gradient(135deg,${PINK} 0%,${PINK_DEEP} 100%);padding:34px 24px 26px;text-align:center;">
        <div style="font-size:34px;line-height:1;letter-spacing:2px;">🎉 🎊 🥳 🎊 🎉</div>
        <div style="margin-top:14px;color:#ffffff;font-size:15px;font-weight:bold;letter-spacing:3px;text-transform:uppercase;opacity:.92;">Milestone Unlocked</div>
        <div style="margin-top:6px;color:#ffffff;font-size:64px;font-weight:900;line-height:1;">${count}<span style="font-size:30px;font-weight:800;">th</span></div>
        <div style="margin-top:6px;color:#ffffff;font-size:17px;font-weight:bold;opacity:.95;">Inspection in ResiWalk</div>
        <div style="margin-top:12px;display:inline-block;background:rgba(255,255,255,.18);color:#ffffff;font-size:13px;font-weight:bold;padding:6px 14px;border-radius:999px;">🏅 And you're the one who logged it</div>
      </td></tr>

      <!-- Message -->
      <tr><td style="padding:28px 30px 6px;">
        <div style="font-size:22px;font-weight:800;color:${INK};">${greeting}</div>
        <p style="font-size:15px;line-height:1.6;color:#3a3f47;margin:12px 0 0;">
          You just completed ResiWalk's <strong>${count}th inspection</strong> — the walk that pushed the whole team
          past ${count}. Out of every inspection logged in ResiWalk, the milestone landed on <strong>yours</strong>,
          and that's a moment worth celebrating. 👏
        </p>
      </td></tr>

      <!-- Prize callout -->
      <tr><td style="padding:20px 30px 8px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#ecfbfa;border:2px dashed ${TEAL};border-radius:14px;">
          <tr><td style="padding:20px 22px;text-align:center;">
            <div style="font-size:30px;line-height:1;">🎁</div>
            <div style="margin-top:8px;font-size:18px;font-weight:800;color:${INK};">Being the one to hit #${count} comes with an extra prize.</div>
            <p style="font-size:14px;line-height:1.55;color:#37474a;margin:8px 0 16px;">
              Email <strong>Hayden &amp; Eric</strong> to claim what's waiting for you.
            </p>
            <a href="${prizeMailto}" style="display:inline-block;background:${PINK};color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:13px 26px;border-radius:999px;">🏆 Email Hayden &amp; Eric to Claim</a>
          </td></tr>
        </table>
      </td></tr>

      <tr><td style="padding:14px 30px 30px;">
        <p style="font-size:14px;line-height:1.6;color:#3a3f47;margin:0;">
          Here's to the next milestone — thanks for being the one to get us there. 🚀
        </p>
        <p style="font-size:14px;line-height:1.6;color:#3a3f47;margin:14px 0 0;">— The ResiWalk Team</p>
      </td></tr>

      <tr><td style="padding:16px 24px;background:#faf7f8;text-align:center;font-size:11px;color:#8a8f98;border-top:1px solid #eee;">
        Sent from ResiWalk · Celebrating ${count} completed inspections
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

  const text = [
    '🎉 MILESTONE UNLOCKED 🎉',
    '',
    `The ${count}th inspection in ResiWalk — and you're the one who logged it. 🏅`,
    '',
    name ? `Congratulations, ${name}!` : 'Congratulations!',
    '',
    `You just completed ResiWalk's ${count}th inspection — the walk that pushed the whole team past ${count}. Out of every inspection logged in ResiWalk, the milestone landed on yours. 👏`,
    '',
    `🎁 Being the one to hit #${count} comes with an extra prize. Email Hayden & Eric to claim what's waiting for you.`,
    `   Email: ${PRIZE_RECIPIENTS.join(', ')}`,
    '',
    "Here's to the next milestone — thanks for being the one to get us there. 🚀",
    '— The ResiWalk Team',
  ].join('\n');

  return { subject, html, text };
}

/** Send the milestone email from the system mailbox to one recipient. Never throws. */
export async function sendMilestoneEmail(to: string, opts: { count?: number; recipientName?: string } = {}): Promise<{ sent: boolean; error?: string }> {
  const refreshToken = process.env.SYSTEM_GMAIL_REFRESH_TOKEN || '';
  const fromEmail = process.env.SYSTEM_GMAIL_FROM || '';
  if (!refreshToken || !fromEmail) return { sent: false, error: 'SYSTEM_GMAIL_* not configured' };
  const { subject, html, text } = buildMilestoneEmail(opts);
  try {
    return await sendReplyEmailWithToken({
      refreshToken, fromEmail, fromName: process.env.SYSTEM_GMAIL_FROM_NAME || 'ResiWalk',
      to: [to], subject, htmlBody: html, textBody: text,
    });
  } catch (e: any) {
    return { sent: false, error: String(e?.message || e).slice(0, 160) };
  }
}
