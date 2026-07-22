/**
 * GET /api/admin/env-nonsecret — admin-only. Prints the LIVE values of a FIXED
 * allowlist of NON-SECRET config env vars (object type ids, public origins,
 * redirect URIs, API base urls, public flags, OAuth client ids, public keys), so
 * an admin can read/verify them without un-sensitizing each one in Vercel first.
 *
 * SECURITY: the allowlist below is the ONLY thing this route can ever read — it
 * never echoes an arbitrary/queried key, and every name here is non-secret by
 * design. Secrets (tokens, API keys, passwords, OAuth client SECRETS, DB URLs)
 * are intentionally absent and will never be returned here.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';

// FIXED allowlist — non-secret only. Do NOT add tokens/keys/passwords/secrets.
const NON_SECRET_ENV: string[] = [
  // HubSpot object type ids + portal (appear in every HubSpot URL — not secret)
  'HUBSPOT_PORTAL_ID',
  'HUBSPOT_INSPECTION_TYPE_ID',
  'HUBSPOT_INSPECTION_QUESTION_TYPE_ID',
  'HUBSPOT_INSPECTION_ANSWER_TYPE_ID',
  'HUBSPOT_PROPERTY_TYPE_ID',
  'HUBSPOT_RATE_CARD_LINE_ITEM_TYPE_ID',
  'HUBSPOT_REGION_RATE_TYPE_ID',
  'HUBSPOT_SERVICE_TYPE_ID',
  'HUBSPOT_SERVICE_RULE_TYPE_ID',
  // Public origins / redirect URIs (public by nature)
  'PUBLIC_APP_ORIGIN',
  'NEXT_PUBLIC_APP_ORIGIN',
  'APP_PUBLIC_URL',
  'GMAIL_REDIRECT_URI',
  'MS_REDIRECT_URI',
  'MS_TENANT',
  // OAuth CLIENT IDs (exposed to the browser during sign-in — not secret; the
  // matching *_SECRET values are deliberately excluded)
  'GOOGLE_EXTERNAL_CLIENT_ID',
  'GMAIL_CLIENT_ID',
  'MS_CLIENT_ID',
  // Integration base urls / versions / hostnames (config, not credentials)
  'MAINTENANCE_AI_BASE_URL',
  'MAINTENANCE_AI_API_VERSION',
  'MAINTENANCE_AI_TICKET_URL_TEMPLATE',
  'MAINTENANCE_AI_TICKET_TYPE_ID',
  'MAINTENANCE_AI_EVICTION_TICKET_TYPE_ID',
  'HBMM_LOGIN_URL',
  'HBMM_TICKET_TYPE_TARGET',
  'RENTLY_UNLOCK_ENDPOINT',
  'SYSTEM_GMAIL_FROM',
  'SFTP_REMOTE_DIR',
  'SFTP_PORT',
  // Blob storage (host/store id are visible in every file URL — not secret)
  'BLOB_PUBLIC_HOST',
  'BLOB_STORE_ID',
  'BLOB_WEBHOOK_PUBLIC_KEY',
  // Public keys / public flags (browser-exposed by design)
  'VAPID_SUBJECT',
  'NEXT_PUBLIC_VAPID_PUBLIC_KEY',
  'NEXT_PUBLIC_SERVICES_ENABLED',
  'NEXT_PUBLIC_BLOB_PROXY',
  'NEXT_PUBLIC_PROXIMITY_THRESHOLD_M',
];

const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).send('Not authenticated.');
  if (!(await isAppAdmin(session.email).catch(() => false))) return res.status(403).send('Admin only.');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).send('Method not allowed'); }

  const rows = NON_SECRET_ENV.map((name) => {
    const raw = process.env[name];
    const set = raw != null && raw !== '';
    return { name, set, value: set ? String(raw) : '' };
  });

  // JSON view for scripting/copy.
  if (req.query.format === 'json') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const out: Record<string, string | null> = {};
    for (const r of rows) out[r.name] = r.set ? r.value : null;
    return res.status(200).json({ nonSecret: out });
  }

  const dotenv = rows.filter((r) => r.set).map((r) => `${r.name}=${r.value}`).join('\n');
  const table = rows.map((r) =>
    `<tr><td style="padding:4px 14px 4px 0;font-family:ui-monospace,monospace;white-space:nowrap">${esc(r.name)}</td>`
    + `<td style="padding:4px 0;font-family:ui-monospace,monospace;word-break:break-all">${r.set ? esc(r.value) : '<span style="color:#94a3b8">(not set)</span>'}</td></tr>`
  ).join('');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(
    `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Non-secret env</title>`
    + `<body style="font:14px/1.5 system-ui,sans-serif;margin:0;background:#f8fafc;color:#111">`
    + `<div style="max-width:900px;margin:0 auto;padding:22px">`
    + `<h1 style="font-size:20px;margin:0 0 6px">Non-secret environment values</h1>`
    + `<p style="color:#64748b;margin:0 0 16px">Live values from the running app. <b>Only non-secret config</b> is shown — tokens, keys, passwords, OAuth client secrets, and DB URLs are never returned here. Verify against Vercel; these are the ones safe to mark not-sensitive.</p>`
    + `<table style="border-collapse:collapse;background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:8px;width:100%">${table}</table>`
    + `<h3 style="margin:20px 0 6px">Copy (.env format — only the set ones)</h3>`
    + `<pre style="background:#0f172a;color:#e2e8f0;padding:14px;border-radius:10px;overflow:auto;white-space:pre-wrap;word-break:break-all">${esc(dotenv)}</pre>`
    + `<p style="color:#94a3b8;font-size:12px">JSON: <code>?format=json</code></p>`
    + `</div></body>`
  );
}
