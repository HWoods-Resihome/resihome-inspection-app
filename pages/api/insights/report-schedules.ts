/**
 * /api/insights/report-schedules  (Insights-access gated)
 *
 *  GET                          → { schedules }
 *  POST { ...schedule }         → create/update a schedule (normalized)
 *  POST { action:'test', id? | ...schedule } → build + email the report NOW
 *  DELETE { id }                → remove a schedule
 *
 * Scheduled emailed billing reports (see lib/reportSchedules). The hourly cron
 * (api/cron/report-schedules) sends the due ones; this route manages them and
 * powers the "Send test" button.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { canViewInsights } from '@/lib/insightsAccess';
import { listSchedules, upsertSchedule, deleteSchedule, normalizeSchedule, sendScheduleNow, isScheduleDue, markScheduleRun, etParts, getLastCronTick, getLastCronRun, type ReportSchedule } from '@/lib/reportSchedules';

export const config = { maxDuration: 60 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await canViewInsights(session.realEmail || session.email).catch(() => false))) {
    return res.status(403).json({ error: 'Insights access required.' });
  }

  if (req.method === 'GET') {
    return res.status(200).json({ schedules: await listSchedules() });
  }

  if (req.method === 'POST') {
    const b = req.body || {};
    // Diagnose: show why each saved schedule is / isn't due right now (ET).
    if (b.action === 'diagnose') {
      const now = new Date();
      const p = etParts(now);
      const todayET = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
      const schedules = (await listSchedules()).map((s) => ({
        id: s.id, name: s.name, enabled: s.enabled, cadence: s.cadence,
        hourET: s.hourET, dayOfWeek: s.dayOfWeek, dayOfMonth: s.dayOfMonth,
        recipients: s.recipients?.length || 0, lastRunDate: s.lastRunDate || null,
        dueNow: isScheduleDue(s, now),
        checks: {
          enabled: s.enabled, hasRecipients: !!s.recipients?.length,
          hourReached: p.hour >= (s.hourET | 0), alreadyRanToday: s.lastRunDate === todayET,
          dayMatch: s.cadence === 'daily' ? true : s.cadence === 'weekly' ? p.dow === (s.dayOfWeek ?? 1) : p.d === (s.dayOfMonth ?? 1),
        },
      }));
      // lastCronTick: proves whether Vercel is actually invoking the hourly cron.
      // A recent `at` = cron is firing (self-heal will cover any missed hour); a
      // stale/null tick = the cron isn't running (a platform/registration issue).
      const lastCronTick = await getLastCronTick();
      // lastCronRun: what the most recent invocation actually DID. Together with the
      // tick this disambiguates every failure mode — stale tick = Vercel isn't
      // firing it; fresh tick + outcome 'unauthorized' = CRON_SECRET mismatch;
      // outcome 'skipped_no_secret' = CRON_SECRET unset; outcome 'ok' with due:0 =
      // no schedule matched (check the per-schedule `checks` below).
      const lastCronRun = await getLastCronRun();
      return res.status(200).json({ nowET: { hour: p.hour, dow: p.dow, today: todayET }, lastCronTick, lastCronRun, schedules });
    }
    // Manual run: send a saved schedule NOW and stamp it (mirrors the cron), so a
    // missed send can be recovered on demand. Wrapped so a build/fetch/email
    // throw surfaces as a clear message (the whole point when troubleshooting a
    // silent miss). { action:'run', id }.
    if (b.action === 'run') {
      try {
        const found = (await listSchedules()).find((x) => x.id === String(b.id || ''));
        if (!found) return res.status(404).json({ error: 'Schedule not found.' });
        const now = new Date();
        const r = await sendScheduleNow(found, req, now);
        if (!r.sent) return res.status(502).json({ error: r.error === 'system_email_not_configured' ? 'System email is not configured (SYSTEM_GMAIL_*).' : `Email failed: ${r.error || 'unknown'}`, rows: r.rows });
        const p = etParts(now);
        await markScheduleRun(found.id, `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`);
        return res.status(200).json({ ok: true, rows: r.rows, ranAt: now.toISOString() });
      } catch (e: any) { return res.status(500).json({ error: `Run threw: ${String(e?.message || e).slice(0, 300)}` }); }
    }
    // Test send: use the posted schedule as-is (may be unsaved), or a saved id.
    if (b.action === 'test') {
      try {
        let sch: ReportSchedule;
        if (b.id && !b.recipients) {
          const found = (await listSchedules()).find((x) => x.id === b.id);
          if (!found) return res.status(404).json({ error: 'Schedule not found.' });
          sch = found;
        } else {
          sch = normalizeSchedule(b, session.email);
        }
        const r = await sendScheduleNow(sch, req);
        if (!r.sent) return res.status(502).json({ error: r.error === 'system_email_not_configured' ? 'System email is not configured (SYSTEM_GMAIL_*).' : `Email failed: ${r.error || 'unknown'}` });
        return res.status(200).json({ ok: true, rows: r.rows });
      } catch (e: any) { return res.status(500).json({ error: String(e?.message || e).slice(0, 300) }); }
    }
    try {
      const sch = normalizeSchedule(b, session.email);
      const ok = await upsertSchedule(sch);
      if (!ok) return res.status(500).json({ error: 'Could not save the schedule.' });
      return res.status(200).json({ ok: true, schedule: sch });
    } catch (e: any) { return res.status(400).json({ error: String(e?.message || e).slice(0, 300) }); }
  }

  if (req.method === 'DELETE') {
    const id = String((req.body || {}).id || req.query.id || '').trim();
    if (!id) return res.status(400).json({ error: 'id is required.' });
    const ok = await deleteSchedule(id);
    return ok ? res.status(200).json({ ok: true }) : res.status(500).json({ error: 'Could not delete the schedule.' });
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
