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
import { listSchedules, upsertSchedule, deleteSchedule, normalizeSchedule, sendScheduleNow, type ReportSchedule } from '@/lib/reportSchedules';

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
