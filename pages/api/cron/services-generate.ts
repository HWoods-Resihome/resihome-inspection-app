/**
 * GET /api/cron/services-generate — nightly rule → work-order generation.
 *
 * Runs the validated generation engine in APPLY mode: for each active Service
 * Rule, creates the Service Work Orders its coverage + enrollment call for
 * (idempotent — one open order per rule+target). Scheduled by Vercel Cron (see
 * vercel.json). Requires CRON_SECRET (Vercel sends it as a Bearer token; a
 * `?key=` fallback allows manual triggering). Skips as a safe no-op when
 * CRON_SECRET isn't set.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { runServiceGeneration } from '@/lib/services/generate';
import { easternTodayISO } from '@/lib/services/time';
import { recordErrorEvent } from '@/lib/errorLog';
import { reclaimTenantServicePools } from '@/lib/hubspot';

export const config = { maxDuration: 300 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return res.status(200).json({ ok: true, skipped: true, reason: 'CRON_SECRET not configured.' });
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : (typeof req.query.key === 'string' ? req.query.key : '');
  if (provided !== secret) return res.status(401).json({ error: 'Unauthorized' });

  const today = easternTodayISO();
  try {
    // Pools upkeep FIRST: any Tenant-Service pool that has left Tenant Leased is
    // flipped back to ResiHome, so this same run re-enrolls it into pool orders.
    const poolsReclaimed = await reclaimTenantServicePools().catch((e) => {
      console.warn('[cron/services-generate] pool reclaim failed:', String(e?.message || e).slice(0, 160));
      return 0;
    });
    const report = await runServiceGeneration(true, today);
    if (report === null) return res.status(200).json({ ok: true, skipped: true, reason: 'Service objects not configured.' });
    console.log('[cron/services-generate]', JSON.stringify({ created: report.created, skipped: report.skippedExisting, errors: report.errors, backlog: report.communityBacklogAlerts.length }));
    // Community contract backlog (≥3 open orders of the same type on one community
    // → the vendor is behind) → Admin ▸ Error Log so it's visible, not a hard stop.
    if (report.communityBacklogAlerts.length) {
      void recordErrorEvent({
        kind: 'server', source: 'server',
        message: `Community service backlog: ${report.communityBacklogAlerts.length} contract(s) with 3+ open orders stacked. ${report.communityBacklogAlerts.slice(0, 10).join(' | ')}`.slice(0, 1000),
        url: '/api/cron/services-generate',
        meta: { backlog: report.communityBacklogAlerts.length, today },
      });
    }
    // Surface per-rule generation failures in the Admin ▸ Error Log so a broken
    // rule/target isn't buried in Vercel logs. One event summarizing the run, with
    // up to 10 failing (rule → target → error) samples.
    if (report.errors > 0) {
      const samples = report.items
        .filter((it) => it.action === 'error')
        .slice(0, 10)
        .map((it) => `${it.ruleName || it.ruleId} · ${it.target}: ${it.error || 'unknown error'}`);
      void recordErrorEvent({
        kind: 'server', source: 'server',
        message: `Service generation finished with ${report.errors} error(s) (created ${report.created}). ${samples.join(' | ')}`.slice(0, 1000),
        url: '/api/cron/services-generate',
        meta: { created: report.created, skippedExisting: report.skippedExisting, errors: report.errors, today },
      });
    }
    return res.status(200).json({ ok: true, created: report.created, skippedExisting: report.skippedExisting, errors: report.errors, poolsReclaimed });
  } catch (e: any) {
    console.error('[cron/services-generate] failed:', e);
    // A hard failure of the whole run → Admin ▸ Error Log (best-effort).
    void recordErrorEvent({
      kind: 'server', source: 'server',
      message: `Service generation cron FAILED: ${String(e?.message || e)}`.slice(0, 1000),
      url: '/api/cron/services-generate',
      meta: { today },
    });
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
