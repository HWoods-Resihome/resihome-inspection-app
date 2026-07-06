/**
 * /api/admin/error-log  (admin only)
 *   GET ?limit=200 ?kind=write_denied ?email=foo ?q=text
 *     -> { events, total, kinds }
 *
 * Backs the Admin ▸ ResiWalk Insights "Error Log" — recent app failures
 * (login, inspection load, inspection start, write-denied, sync, client crash,
 * server) newest-first, with datetime, user, template, app version and the
 * causing issue. Read-only; data comes from lib/errorLog (Vercel Blob).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { readErrorLog } from '@/lib/errorLog';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.email))) return res.status(403).json({ error: 'Admin only.' });
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Method not allowed' }); }

  try {
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const limit = Math.min(500, Math.max(1, parseInt(str(req.query.limit), 10) || 200));
    const kind = str(req.query.kind).toLowerCase();
    const emailQ = str(req.query.email).toLowerCase();
    const q = str(req.query.q).toLowerCase();

    // Read a healthy window, then apply any filters, then cap to `limit`.
    let events = await readErrorLog(500);
    // Distinct kinds present (for the filter chips) — computed before filtering.
    const kinds = Array.from(new Set(events.map((e) => String(e.kind || 'client')))).sort();

    if (kind) events = events.filter((e) => String(e.kind || '').toLowerCase() === kind);
    if (emailQ) events = events.filter((e) => String(e.email || '').toLowerCase().includes(emailQ));
    if (q) events = events.filter((e) =>
      `${e.message || ''} ${e.email || ''} ${e.template || ''} ${e.inspectionId || ''} ${JSON.stringify(e.meta || {})}`
        .toLowerCase().includes(q));

    return res.status(200).json({ events: events.slice(0, limit), total: events.length, kinds });
  } catch (e: any) {
    console.error('[error-log] admin read failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
