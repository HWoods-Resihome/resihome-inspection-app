/**
 * GET /api/cron/services-due — daily per-vendor PAST-DUE DIGEST.
 *
 * Once a day, emails each vendor ONE summary listing ALL of their still-open
 * (assigned) services whose due date has passed. It's a running digest: a service
 * keeps appearing every day until it's submitted, so this doubles as the
 * escalation nudge (no more "fires once then goes quiet"). Respects each vendor's
 * past-due notification toggle. Scheduled by Vercel Cron (see vercel.json).
 * Requires CRON_SECRET (Bearer or ?key= fallback); safe no-op when unset.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { searchServiceWorkOrdersByStatus } from '@/lib/hubspot';
import { worktypeLabel, subtypeLabel } from '@/lib/services/worktypes';
import { easternTodayISO } from '@/lib/services/time';
import { notifyVendorPastDueDigest } from '@/lib/notifications/triggers';
import { appBaseUrl } from '@/lib/notifications/send';
import { isNotificationEnabled } from '@/lib/notifications/prefs';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';

export const config = { maxDuration: 300 };

const normDate = (v: any): string => { const t = String(v ?? '').trim(); if (!t) return ''; if (/^\d{10,}$/.test(t)) return new Date(Number(t)).toISOString().slice(0, 10); return t.slice(0, 10); };
const daysBetween = (aISO: string, bISO: string): number =>
  Math.round((Date.parse(`${aISO}T00:00:00Z`) - Date.parse(`${bISO}T00:00:00Z`)) / 86400000);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Vercel Cron (CRON_SECRET bearer / ?key=) OR an app-admin session — so an
  // admin can open /api/cron/services-due?dryRun=1 in the browser to see exactly
  // who would get a digest and why anyone is skipped.
  const secret = process.env.CRON_SECRET || '';
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : (typeof req.query.key === 'string' ? req.query.key : '');
  let authorized = !!secret && provided === secret;
  if (!authorized) {
    const session = await getSessionFromRequest(req).catch(() => null);
    authorized = !!session?.email && (await isAppAdmin(session.email).catch(() => false));
  }
  if (!authorized) return res.status(401).json({ error: 'Unauthorized' });
  const dryRun = req.query.dryRun === '1' || req.query.dry === '1';

  const today = easternTodayISO();
  const baseUrl = appBaseUrl();
  try {
    const open = await searchServiceWorkOrdersByStatus('assigned', 5000);
    if (open === null) return res.status(200).json({ ok: true, skipped: true, reason: 'Service objects not configured.' });
    // Every open (assigned) service whose due date has passed, at any age.
    const pastDue = open.filter((s) => {
      const due = normDate(s.props.due_date);
      if (!due) return false;
      return daysBetween(today, due) >= 1;   // >0 means past due by N days
    });
    // Group by vendor email → one digest each.
    type Item = { serviceId: string; address: string; locality?: string; worktypeLabel: string; subtypeLabel: string; dueDate: string; daysOverdue: number };
    const byVendor = new Map<string, { name: string; email: string; services: Item[] }>();
    for (const s of pastDue) {
      const p = s.props;
      const email = String(p.vendor_email || '').trim();
      if (!email) continue;   // unassigned / no vendor email → nobody to nudge
      const key = email.toLowerCase();
      let g = byVendor.get(key);
      if (!g) { g = { name: String(p.vendor_name || ''), email, services: [] }; byVendor.set(key, g); }
      const due = normDate(p.due_date);
      g.services.push({
        serviceId: s.id,
        address: p.address_snapshot || p.service_name || 'a property', locality: p.locality_snapshot,
        worktypeLabel: worktypeLabel(String(p.worktype || '')), subtypeLabel: subtypeLabel(String(p.worktype || ''), String(p.subtype || '')),
        dueDate: due, daysOverdue: daysBetween(today, due),
      });
    }
    const vendors = Array.from(byVendor.values());

    // Dry-run report: who WOULD get a digest, and why anyone is skipped —
    // no emails leave. For diagnosing "the digest isn't sending".
    if (dryRun) {
      const report = await Promise.all(vendors.map(async (g) => ({
        vendor: g.name || g.email, email: g.email, pastDueServices: g.services.length,
        prefOn: await isNotificationEnabled(g.email, 'service_past_due').catch(() => true),
      })));
      return res.status(200).json({
        ok: true, dryRun: true, scanned: open.length, pastDue: pastDue.length,
        systemEmailConfigured: !!(process.env.SYSTEM_GMAIL_REFRESH_TOKEN && process.env.SYSTEM_GMAIL_FROM),
        wouldSend: report.filter((r) => r.prefOn).length,
        vendors: report,
      });
    }

    // Throttled sends (batches of 5) so many vendors can't fire a burst of Gmail
    // sends and trip rate limits. Each send reports an outcome so the cron log
    // shows exactly what happened per vendor.
    const outcomes: { email: string; outcome: string }[] = [];
    const send = async (g: typeof vendors[number]) => {
      const outcome = await notifyVendorPastDueDigest({ vendorEmail: g.email, vendorName: g.name, services: g.services, baseUrl });
      outcomes.push({ email: g.email, outcome });
    };
    for (let i = 0; i < vendors.length; i += 5) {
      await Promise.allSettled(vendors.slice(i, i + 5).map(send));
    }
    const sent = outcomes.filter((o) => o.outcome === 'sent').length;
    console.log('[cron/services-due]', JSON.stringify({ scanned: open.length, pastDue: pastDue.length, vendors: vendors.length, sent, outcomes }));
    return res.status(200).json({ ok: true, scanned: open.length, pastDue: pastDue.length, vendors: vendors.length, sent, outcomes });
  } catch (e: any) {
    console.error('[cron/services-due] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
