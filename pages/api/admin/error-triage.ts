/**
 * GET /api/admin/error-triage?hours=168&scan=1000&top=25[&format=text]
 *
 * Admin-gated. Reads the recent error log and collapses it into a RANKED list of
 * distinct issues (see lib/errorTriage) — the on-demand "what's broken right now"
 * view. Default returns JSON; ?format=text returns the paste-ready summary to
 * hand to a fixer. This is the handoff for the on-demand self-triage loop.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { readErrorLog } from '@/lib/errorLog';
import { triageErrorEvents, renderTriageText } from '@/lib/errorTriage';

export const config = { maxDuration: 60 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email || !(await isAppAdmin(session.email).catch(() => false))) {
    return res.status(403).json({ error: 'Admin only' });
  }
  const scan = Math.min(Math.max(Number(req.query.scan) || 1000, 1), 5000);
  const top = Math.min(Math.max(Number(req.query.top) || 25, 1), 100);
  const hours = Number(req.query.hours) || 0;   // 0 = no window (all scanned)
  try {
    let events = await readErrorLog(scan);
    if (hours > 0) {
      const cutoff = Date.now() - hours * 3600000;
      events = events.filter((e) => Date.parse(e.ts) >= cutoff);
    }
    const report = triageErrorEvents(events, { topN: top });
    if (String(req.query.format || '') === 'text') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send(renderTriageText(report));
    }
    return res.status(200).json({ ...report, text: renderTriageText(report) });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
