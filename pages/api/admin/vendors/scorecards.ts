/**
 * GET /api/admin/vendors/scorecards  (app-admin only)
 *
 * Per-vendor service performance, aggregated from the live work-order window
 * (the same cached list the Services home uses — no extra HubSpot scans):
 *   open        — current assigned/submitted/review count
 *   pastDue     — open orders whose due date has passed
 *   completed90 — orders completed in the trailing 90 days
 *   onTimePct   — % of those completed on/before their due date (null = none)
 *   lastCompletedAt — most recent completion (ISO), for "active?" at a glance
 *
 * Keyed by vendor email AND by lowercased vendor display name so the Vendor
 * Management cards can match either (legacy rows are name-stamped only).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { searchServiceWorkOrders } from '@/lib/hubspot';
import { easternTodayISO } from '@/lib/services/time';

export interface VendorScore {
  open: number;
  pastDue: number;
  completed90: number;
  onTimePct: number | null;
  lastCompletedAt: string | null;
}

const WINDOW_DAYS = 90;
// The source list is itself cached (SVC_LIST_TTL); this only avoids re-tallying
// 3000 rows on every card expand.
let _cache: { at: number; body: any } | null = null;
const TTL_MS = 5 * 60 * 1000;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.realEmail || session.email).catch(() => false))) {
    return res.status(403).json({ error: 'Admin only.' });
  }
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Method not allowed' }); }

  if (_cache && Date.now() - _cache.at < TTL_MS) return res.status(200).json(_cache.body);

  try {
    const services = (await searchServiceWorkOrders({})) || [];
    const today = easternTodayISO();
    const cutoff = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

    type Tally = VendorScore & { onTime90: number };
    const byKey = new Map<string, Tally>();
    const keysFor = (s: { vendor: string | null; vendorEmail?: string | null }): string[] => {
      const keys: string[] = [];
      const e = String(s.vendorEmail || '').trim().toLowerCase();
      const n = String(s.vendor || '').trim().toLowerCase();
      if (e) keys.push(`e:${e}`);
      if (n) keys.push(`n:${n}`);
      return keys;
    };
    const tally = (key: string): Tally => {
      let t = byKey.get(key);
      if (!t) { t = { open: 0, pastDue: 0, completed90: 0, onTimePct: null, lastCompletedAt: null, onTime90: 0 }; byKey.set(key, t); }
      return t;
    };

    for (const s of services) {
      if (s.forBilling) continue;   // billing split lines aren't vendor work
      const keys = keysFor(s);
      if (!keys.length) continue;
      const openStatus = s.status === 'assigned' || s.status === 'submitted' || s.status === 'review';
      const isPastDue = openStatus && !!s.dueDate && s.dueDate < today;
      const completedRecent = s.status === 'completed' && !!s.completedAt && s.completedAt >= cutoff;
      for (const k of keys) {
        const t = tally(k);
        if (openStatus) t.open++;
        if (isPastDue) t.pastDue++;
        if (completedRecent) {
          t.completed90++;
          if (s.onTime) t.onTime90++;
          if (!t.lastCompletedAt || (s.completedAt as string) > t.lastCompletedAt) t.lastCompletedAt = s.completedAt as string;
        } else if (s.status === 'completed' && s.completedAt && (!t.lastCompletedAt || s.completedAt > t.lastCompletedAt)) {
          t.lastCompletedAt = s.completedAt;
        }
      }
    }

    const byEmail: Record<string, VendorScore> = {};
    const byName: Record<string, VendorScore> = {};
    for (const [key, t] of byKey.entries()) {
      const score: VendorScore = {
        open: t.open, pastDue: t.pastDue, completed90: t.completed90,
        onTimePct: t.completed90 > 0 ? Math.round((t.onTime90 / t.completed90) * 100) : null,
        lastCompletedAt: t.lastCompletedAt,
      };
      if (key.startsWith('e:')) byEmail[key.slice(2)] = score;
      else byName[key.slice(2)] = score;
    }

    const body = { byEmail, byName, windowDays: WINDOW_DAYS };
    _cache = { at: Date.now(), body };
    return res.status(200).json(body);
  } catch (e: any) {
    console.error('[admin/vendors] scorecards failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
