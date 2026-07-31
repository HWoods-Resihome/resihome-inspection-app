/**
 * GET /api/cron/report-schedules — hourly send of due billing-report schedules.
 *
 * Scheduled by Vercel Cron (hourly, on the hour). For each enabled schedule
 * whose ET hour + cadence day match this hour (and that hasn't already run this
 * ET day), resolves its relative date range, builds the .xlsx, emails it from
 * the system mailbox, and stamps lastRunDate. Requires CRON_SECRET.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { listSchedules, isScheduleDue, sendScheduleNow, markScheduleRun, etParts, recordCronTick, recordCronRun } from '@/lib/reportSchedules';

export const config = { maxDuration: 300 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const now = new Date();
  const p = etParts(now);
  // Heartbeat FIRST — before the auth gate — so a fresh tick proves Vercel is
  // invoking the cron regardless of whether the secret matches. (Previously the
  // tick ran only AFTER auth, so a bad CRON_SECRET looked identical to "the cron
  // isn't firing", which sent troubleshooting down the wrong path.)
  await recordCronTick(now);

  const secret = process.env.CRON_SECRET || '';
  if (!secret) {
    await recordCronRun({ at: now.toISOString(), hourET: p.hour, outcome: 'skipped_no_secret' });
    return res.status(200).json({ ok: true, skipped: true, reason: 'CRON_SECRET not configured.' });
  }
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : (typeof req.query.key === 'string' ? req.query.key : '');
  if (provided !== secret) {
    await recordCronRun({ at: now.toISOString(), hourET: p.hour, outcome: 'unauthorized' });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const todayET = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  let sent = 0; let failed = 0;
  const results: any[] = [];
  try {
    const due = (await listSchedules()).filter((s) => isScheduleDue(s, now));
    for (const s of due) {
      try {
        const r = await sendScheduleNow(s, req, now);
        if (r.sent) { await markScheduleRun(s.id, todayET); sent++; results.push({ id: s.id, rows: r.rows }); }
        else { failed++; results.push({ id: s.id, error: r.error }); console.warn('[cron/report-schedules] send failed:', s.id, r.error); }
      } catch (e: any) { failed++; results.push({ id: s.id, error: String(e?.message || e).slice(0, 160) }); }
    }
    await recordCronRun({ at: now.toISOString(), hourET: p.hour, outcome: 'ok', due: due.length, sent, failed });
    return res.status(200).json({ ok: true, hourET: p.hour, due: due.length, sent, failed, results });
  } catch (e: any) {
    console.error('[cron/report-schedules] failed:', e);
    await recordCronRun({ at: now.toISOString(), hourET: p.hour, outcome: 'error', error: String(e?.message || e).slice(0, 200) });
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
