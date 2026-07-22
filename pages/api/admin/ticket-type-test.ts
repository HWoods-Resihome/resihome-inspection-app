/**
 * GET /api/admin/ticket-type-test — admin-only tool to test the HoneyBadger
 * ("MM") ticket-type enforcement in isolation. Paste a ticket URL (or id), pick
 * the target type, and it drives the UI to force the type (with the same retry-
 * until-confirmed logic finalize uses) and reports before/after + the step log +
 * a screenshot. Optionally also fires the External-API PUT first.
 *
 * No document upload happens here — it's purely the ticket-type toggle test.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { setTicketTypeViaUi } from '@/lib/ticketUpload';
import {
  parseMmTicketId, buildTicketUrl, setMaintenanceTicketType,
  TICKET_TYPE_TURNKEY, TICKET_TYPE_EVICTION,
} from '@/lib/maintenanceAi';

// The browser automation (login → navigate → edit → save → verify, retried) can
// take a couple of minutes on a cold start.
export const config = { maxDuration: 300 };

const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

function page(bodyHtml: string): string {
  return `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">`
    + `<title>Ticket Type Test</title>`
    + `<body style="font:14px/1.5 system-ui,sans-serif;margin:0;background:#f8fafc;color:#111">`
    + `<div style="max-width:900px;margin:0 auto;padding:20px">`
    + `<h1 style="font-size:20px;margin:0 0 4px">HoneyBadger — Ticket Type Test</h1>`
    + `<p style="color:#64748b;margin:0 0 20px">Force a ticket's type via the UI (with retry-until-confirmed) and see if it sticks. No documents are uploaded.</p>`
    + bodyHtml
    + `</div></body>`;
}

function form(prefill: { url?: string; target?: string; api?: boolean }): string {
  const t = prefill.target || 'Turnkey';
  const opt = (v: string, label: string) => `<option value="${v}"${t === v ? ' selected' : ''}>${label}</option>`;
  return `<form method="GET" style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px;margin-bottom:20px">`
    + `<label style="display:block;font-weight:600;margin-bottom:4px">MM ticket URL (or id)</label>`
    + `<input name="url" value="${esc(prefill.url || '')}" placeholder="https://honeybadgermm.com/Maintenance#/EditTicket/12345" `
    + `style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #cbd5e1;border-radius:8px;font:inherit" required>`
    + `<div style="display:flex;gap:16px;align-items:end;margin-top:12px;flex-wrap:wrap">`
    + `<div><label style="display:block;font-weight:600;margin-bottom:4px">Target type</label>`
    + `<select name="target" style="padding:10px;border:1px solid #cbd5e1;border-radius:8px;font:inherit">`
    + opt('Turnkey', 'Turnkey') + opt('Evictions', 'Evictions') + `</select></div>`
    + `<label style="display:flex;align-items:center;gap:6px;padding-bottom:10px">`
    + `<input type="checkbox" name="api" value="1"${prefill.api ? ' checked' : ''}> also fire the API PUT first</label>`
    + `<button type="submit" style="margin-left:auto;padding:10px 20px;background:#ff0060;color:#fff;border:0;border-radius:8px;font:inherit;font-weight:700;cursor:pointer">Run test</button>`
    + `</div></form>`;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).send('Not authenticated.');
  if (!(await isAppAdmin(session.email).catch(() => false))) return res.status(403).send('Admin only.');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).send('Method not allowed'); }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  const rawUrl = typeof req.query.url === 'string' ? req.query.url : (typeof req.query.ticketId === 'string' ? req.query.ticketId : '');
  const target = (typeof req.query.target === 'string' && req.query.target.trim()) || 'Turnkey';
  const alsoApi = req.query.api === '1' || req.query.api === 'true';

  // No input yet → just show the form.
  if (!rawUrl.trim()) return res.status(200).send(page(form({ target })));

  const ticketId = parseMmTicketId(rawUrl);
  if (!ticketId) {
    return res.status(200).send(page(
      form({ url: rawUrl, target, api: alsoApi })
      + `<p style="color:#b91c1c"><b>Couldn't parse a ticket id</b> from "${esc(rawUrl)}". Paste the ticket URL (…/EditTicket/&lt;id&gt;) or the numeric id.</p>`
    ));
  }

  const parts: string[] = [];
  parts.push(`<p><b>Ticket:</b> #${ticketId} · <a href="${esc(buildTicketUrl(ticketId) || '#')}" target="_blank" rel="noopener">open in HoneyBadger ↗</a></p>`);

  try {
    // Optional: fire the External-API PUT first (belt-and-suspenders).
    if (alsoApi) {
      const typeId = /evic/i.test(target) ? TICKET_TYPE_EVICTION : TICKET_TYPE_TURNKEY;
      const apiRes = await setMaintenanceTicketType(ticketId, typeId);
      parts.push(
        `<h3>API PUT (ticketTypeId=${typeId})</h3>`
        + `<p>${apiRes.configured ? (apiRes.ok ? '✅ OK' : '❌ failed') : '⚠️ not configured (no API key)'}`
        + ` — status ${apiRes.status ?? '—'}${apiRes.error ? ` · ${esc(apiRes.error)}` : ''}${apiRes.body ? `<br><code style="font-size:12px">${esc(apiRes.body)}</code>` : ''}</p>`
      );
    }

    // The authoritative test: drive the UI to enforce the type (retry-until-confirmed).
    const ui = await setTicketTypeViaUi({ ticketId, target });
    parts.push(
      `<h3>UI enforcement — ${ui.ok ? '✅ confirmed as ' + esc(target) : '❌ NOT confirmed'}</h3>`
      + (ui.error ? `<p style="color:#b91c1c"><b>${esc(ui.error)}</b></p>` : '')
      + `<p style="color:#64748b">configured=${ui.configured}</p>`
      + `<h4>Steps</h4><ol style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:12px 12px 12px 32px">`
      + ui.steps.map((s) => `<li style="margin:2px 0">${esc(s)}</li>`).join('') + `</ol>`
      + (ui.screenshot ? `<h4>Screenshot at finish</h4><img src="${ui.screenshot}" style="max-width:100%;border:1px solid #cbd5e1;border-radius:8px">` : '<p><em>no screenshot</em></p>')
    );
  } catch (e: any) {
    parts.push(`<p style="color:#b91c1c"><b>Error:</b> ${esc(String(e?.message || e))}</p>`);
  }

  return res.status(200).send(page(form({ url: rawUrl, target, api: alsoApi }) + parts.join('')));
}
