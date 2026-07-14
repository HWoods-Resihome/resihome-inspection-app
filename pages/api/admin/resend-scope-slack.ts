/**
 * GET|POST /api/admin/resend-scope-slack  (app-admin only)
 *
 * Re-fire the Scope Rate Card "Pending Approval" Slack card for scopes that are
 * awaiting approval but never got their card posted (empty `slackmessagelink`) —
 * e.g. when the submit request died during the (now-bounded) master-PDF pre-gen
 * before reaching the Slack post. Idempotent: postScopePendingApproval dedupes on
 * an existing slackmessagelink, so scopes that already posted are left alone.
 *
 *   ?id=<recordId>  → re-fire just that one inspection.
 *   (no id)         → scan pending/submitted scopes, re-fire any with no link.
 *
 * Time-bounded with a `resume` URL, mirroring the other admin backfills.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { fetchInspections, readInspectionProps } from '@/lib/hubspot';
import { postScopePendingApproval } from '@/lib/scopeApprovalSlack';

export const config = { maxDuration: 300 };

const norm = (s: string) => (s || '').trim().toLowerCase().replace(/[ -]/g, '_');

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.realEmail || session.email))) return res.status(403).json({ error: 'Admin only.' });
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Single-inspection mode: re-fire exactly one (handy for a known miss).
  const singleId = String(req.query.id || '').trim();
  if (singleId) {
    try {
      const r = await postScopePendingApproval(singleId);
      return res.status(200).json({ ok: true, id: singleId, result: r });
    } catch (e: any) {
      return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
    }
  }

  const startIdx = Math.max(0, Number(req.query.after) || 0);
  const deadline = Date.now() + 250_000;

  try {
    const all = await fetchInspections();
    const targets = all.filter((i) => {
      const st = norm(i.status);
      return i.templateType === 'pm_scope_rate_card' && (st === 'submitted' || st === 'pending_approval');
    });

    let processed = 0, posted = 0, alreadySent = 0, noChannel = 0, disabled = 0, errors = 0;
    const results: string[] = [];
    let i = startIdx;
    for (; i < targets.length; i++) {
      const insp = targets[i];
      processed++;
      try {
        // Skip the HubSpot region/routing reads when a link already exists.
        const props = await readInspectionProps(insp.recordId, ['slackmessagelink']);
        if ((props?.slackmessagelink || '').toString().trim()) { alreadySent++; }
        else {
          const r = await postScopePendingApproval(insp.recordId);
          if (r.status === 'SENT') { posted++; if (results.length < 20) results.push(`${insp.recordId}: SENT → ${r.channel}`); }
          else if (r.status === 'ALREADY_SENT') alreadySent++;
          else if (r.status === 'NO_CHANNEL') { noChannel++; if (results.length < 20) results.push(`${insp.recordId}: NO_CHANNEL (${r.error || ''})`); }
          else if (r.status === 'DISABLED') disabled++;
          else { errors++; if (results.length < 20) results.push(`${insp.recordId}: ${r.status} ${r.error || ''}`); }
        }
      } catch (e: any) {
        errors++;
        if (results.length < 20) results.push(`${insp.recordId}: ERROR ${String(e?.message || e).slice(0, 140)}`);
      }
      if (Date.now() > deadline) { i++; break; }
    }

    const done = i >= targets.length;
    const nextAfter = done ? null : i;
    return res.status(200).json({
      ok: true,
      pendingScopes: targets.length,
      processed, posted, alreadySent, noChannel, disabled, errors,
      done, nextAfter,
      resume: nextAfter != null ? `/api/admin/resend-scope-slack?after=${nextAfter}` : null,
      results,
    });
  } catch (e: any) {
    console.error('[resend-scope-slack] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
