/**
 * GET /api/admin/rebrand-file-urls — admin one-time backfill that rewrites stored
 * RAW Vercel Blob URLs to our branded /m/ domain across service + inspection
 * records (so nothing in HubSpot still points at *.blob.vercel-storage.com).
 *
 * Self-advancing + CSP-safe: each request processes ONE page of the current phase
 * (services → inspections → answers) then meta-refreshes to the next page/phase,
 * carrying running totals in the URL — no client JS, no cron needed. DRY-RUN by
 * default (counts what WOULD change); add &apply=1 to write. Idempotent: a branded
 * URL no longer matches the blob host, so re-running is safe.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { rebrandBlobUrlsBatch, type RebrandObject } from '@/lib/hubspot';
import { appOrigin, reqOriginOf } from '@/lib/appUrl';

export const config = { maxDuration: 300 };

const PHASES: RebrandObject[] = ['service', 'inspection', 'answer'];
const PHASE_LABEL: Record<RebrandObject, string> = { service: 'Services', inspection: 'Inspections', answer: 'Inspection photos/answers' };

const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const n = (v: any) => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? x : 0; };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).send('Not authenticated.');
  if (!(await isAppAdmin(session.email).catch(() => false))) return res.status(403).send('Admin only.');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).send('Method not allowed'); }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  // Branding must be live (the /m/* rewrite exists) or the rewritten URLs won't resolve.
  if (process.env.NEXT_PUBLIC_BLOB_PROXY !== '1') {
    return res.status(200).send(shell(
      `<p style="color:#b91c1c"><b>Branding isn't enabled.</b> Set <code>BLOB_PUBLIC_HOST</code> (the store host, e.g. <code>7imh0yfpshxqifte.public.blob.vercel-storage.com</code>) and redeploy first — otherwise the rewritten /m/ URLs won't resolve.</p>`
    ));
  }

  const origin = appOrigin(reqOriginOf(req as any));
  const apply = req.query.apply === '1' || req.query.apply === 'true';
  const started = req.query.go === '1';

  // Landing page (no run yet): explain + offer dry-run and apply links.
  if (!started) {
    return res.status(200).send(shell(
      `<p>Rewrites every stored raw Vercel Blob URL (<code>…public.blob.vercel-storage.com/…</code>) to <code>${esc(origin)}/m/…</code> across Services + Inspections. Idempotent and safe to re-run.</p>`
      + `<p><b>Target origin:</b> <code>${esc(origin)}</code></p>`
      + `<div style="display:flex;gap:12px;margin-top:16px">`
      + `<a href="?go=1&apply=0" style="padding:10px 18px;border:1px solid #cbd5e1;border-radius:8px;text-decoration:none;color:#111;font-weight:600">Dry run (count only)</a>`
      + `<a href="?go=1&apply=1" onclick="return confirm('Apply and permanently rewrite stored URLs?')" style="padding:10px 18px;background:#ff0060;color:#fff;border-radius:8px;text-decoration:none;font-weight:700">Apply &amp; rewrite</a>`
      + `</div>`
    ));
  }

  // Current position + running totals (carried in the URL across meta-refreshes).
  const phase = (PHASES.includes(req.query.phase as RebrandObject) ? req.query.phase : 'service') as RebrandObject;
  const after = typeof req.query.after === 'string' ? req.query.after : '';
  const tot = { scanned: n(req.query.s), changed: n(req.query.c), patched: n(req.query.p) };

  let rep;
  try {
    rep = await rebrandBlobUrlsBatch({ object: phase, after: after || undefined, apply, origin, limit: apply ? 40 : 100 });
  } catch (e: any) {
    return res.status(200).send(shell(`<p style="color:#b91c1c"><b>Error:</b> ${esc(String(e?.message || e))}</p><p><a href="?go=1&apply=${apply ? 1 : 0}">Restart</a></p>`));
  }
  tot.scanned += rep.scanned; tot.changed += rep.changed; tot.patched += rep.patched;

  // Decide the next step: more pages in this phase, else advance to the next phase.
  const phaseIdx = PHASES.indexOf(phase);
  let next: { phase: RebrandObject; after: string } | null = null;
  if (!rep.done) next = { phase, after: rep.after };
  else if (phaseIdx < PHASES.length - 1) next = { phase: PHASES[phaseIdx + 1], after: '' };

  const totalsHtml =
    `<table style="border-collapse:collapse;margin:12px 0">`
    + `<tr><td style="padding:2px 12px 2px 0;color:#64748b">Scanned</td><td style="font-weight:700">${tot.scanned.toLocaleString()}</td></tr>`
    + `<tr><td style="padding:2px 12px 2px 0;color:#64748b">${apply ? 'Rewritten' : 'Would rewrite'}</td><td style="font-weight:700">${(apply ? tot.patched : tot.changed).toLocaleString()}</td></tr>`
    + `</table>`;

  if (next) {
    const q = new URLSearchParams({ go: '1', apply: apply ? '1' : '0', phase: next.phase, after: next.after, s: String(tot.scanned), c: String(tot.changed), p: String(tot.patched) });
    const nextUrl = `?${q.toString()}`;
    return res.status(200).send(shell(
      `<meta http-equiv="refresh" content="0.4; url=${esc(nextUrl)}">`
      + `<p><b>${apply ? 'Applying' : 'Dry run'}…</b> phase: <b>${esc(PHASE_LABEL[next.phase])}</b></p>`
      + totalsHtml
      + (rep.error ? `<p style="color:#b45309">last batch note: ${esc(rep.error)}</p>` : '')
      + `<p style="color:#94a3b8;font-size:12px">Auto-continuing… if it stalls, <a href="${esc(nextUrl)}">click to continue</a>. Keep this tab open.</p>`
    ));
  }

  // Finished all phases.
  return res.status(200).send(shell(
    `<h2 style="color:#059669">✅ ${apply ? 'Backfill complete' : 'Dry run complete'}</h2>`
    + totalsHtml
    + (apply
        ? `<p>All stored blob URLs now point at <code>${esc(origin)}/m/…</code>.</p>`
        : `<p>${tot.changed.toLocaleString()} record(s) would be rewritten. Run it for real:</p><p><a href="?go=1&apply=1" onclick="return confirm('Apply and permanently rewrite stored URLs?')" style="padding:10px 18px;background:#ff0060;color:#fff;border-radius:8px;text-decoration:none;font-weight:700">Apply &amp; rewrite</a></p>`)
    + (rep.error ? `<p style="color:#b45309">last batch note: ${esc(rep.error)}</p>` : '')
  ));
}

function shell(body: string): string {
  return `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Rebrand File URLs</title>`
    + `<body style="font:14px/1.5 system-ui,sans-serif;margin:0;background:#f8fafc;color:#111">`
    + `<div style="max-width:820px;margin:0 auto;padding:22px">`
    + `<h1 style="font-size:20px;margin:0 0 12px">Move stored file URLs to the ResiWalk domain</h1>`
    + body + `</div></body>`;
}
