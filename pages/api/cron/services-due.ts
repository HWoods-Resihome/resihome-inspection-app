/**
 * GET /api/cron/services-due — daily "service past due" vendor nudge.
 *
 * Emails the assigned vendor when one of their still-open (assigned) services has
 * JUST become past due — a service due on day D is emailed on the first run after
 * D (we look at services whose due date is in the recent window and now < today),
 * so a vendor gets one nudge per service, not a daily repeat. Respects each
 * vendor's notification toggle. Scheduled by Vercel Cron (see vercel.json).
 * Requires CRON_SECRET (Bearer or ?key= fallback); safe no-op when unset.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { searchServiceWorkOrdersByStatus } from '@/lib/hubspot';
import { worktypeLabel, subtypeLabel } from '@/lib/services/worktypes';
import { easternTodayISO } from '@/lib/services/sampleData';
import { notifyServicePastDue } from '@/lib/notifications/triggers';
import { appBaseUrl } from '@/lib/notifications/send';

export const config = { maxDuration: 300 };

const normDate = (v: any): string => { const t = String(v ?? '').trim(); if (!t) return ''; if (/^\d{10,}$/.test(t)) return new Date(Number(t)).toISOString().slice(0, 10); return t.slice(0, 10); };
const daysBetween = (aISO: string, bISO: string): number =>
  Math.round((Date.parse(`${aISO}T00:00:00Z`) - Date.parse(`${bISO}T00:00:00Z`)) / 86400000);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return res.status(200).json({ ok: true, skipped: true, reason: 'CRON_SECRET not configured.' });
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : (typeof req.query.key === 'string' ? req.query.key : '');
  if (provided !== secret) return res.status(401).json({ error: 'Unauthorized' });

  const today = easternTodayISO();
  const baseUrl = appBaseUrl();
  try {
    const open = await searchServiceWorkOrdersByStatus('assigned', 5000);
    if (open === null) return res.status(200).json({ ok: true, skipped: true, reason: 'Service objects not configured.' });
    // "Just became past due": due date is in the past but within the last few days
    // (catches a missed cron run without re-nudging weeks-old orders every day).
    const WINDOW_DAYS = Number(req.query.window || 3);
    const targets = open.filter((s) => {
      const due = normDate(s.props.due_date);
      if (!due) return false;
      const past = daysBetween(today, due);   // >0 means past due by N days
      return past >= 1 && past <= WINDOW_DAYS;
    });
    const results = await Promise.allSettled(targets.map((s) => {
      const p = s.props;
      return notifyServicePastDue({
        serviceId: s.id, vendorEmail: p.vendor_email, vendorName: p.vendor_name,
        address: p.address_snapshot || p.service_name || 'a property',
        worktypeLabel: worktypeLabel(String(p.worktype || '')), subtypeLabel: subtypeLabel(String(p.worktype || ''), String(p.subtype || '')),
        dueDate: normDate(p.due_date), baseUrl,
      });
    }));
    const attempted = results.length;
    console.log('[cron/services-due]', JSON.stringify({ scanned: open.length, attempted }));
    return res.status(200).json({ ok: true, scanned: open.length, notified: attempted });
  } catch (e: any) {
    console.error('[cron/services-due] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
