/**
 * GET|POST /api/admin/notification-prefs  (app-admin only)
 *
 * GET  → every known user + their effective notification toggles, for the admin
 *        grid. Users = active staff ∪ service vendors ∪ anyone with saved prefs.
 * POST { email, prefs: { [key]: boolean } } → set another user's toggles (the
 *        admin flipping a switch on their behalf).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { fetchActiveUsers, readNotificationPrefsRaw } from '@/lib/hubspot';
import { NOTIFICATION_KEYS, type NotificationKey } from '@/lib/notifications/catalog';
import { setNotificationPrefs } from '@/lib/notifications/prefs';
import { SERVICE_VENDORS } from '@/lib/services/vendors';
import { readLoginActivity } from '@/lib/loginActivity';

const norm = (e?: string | null) => String(e || '').trim().toLowerCase();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.realEmail || session.email))) return res.status(403).json({ error: 'Admin only.' });

  if (req.method === 'GET') {
    const [staff, raw, logins] = await Promise.all([
      fetchActiveUsers().catch(() => []),
      readNotificationPrefsRaw().catch(() => ({} as Record<string, Record<string, boolean>>)),
      readLoginActivity().catch(() => ({} as Record<string, { lastAt: string; count?: number; name?: string }>)),
    ]);
    const all = raw || {};
    // Name/kind lookups for enrichment.
    const staffByEmail = new Map(staff.map((u) => [norm(u.email), u]));
    const vendorByEmail = new Map(SERVICE_VENDORS.map((v) => [norm(v.email), v]));

    // Only users who have actually SIGNED IN (login store) — plus anyone with
    // saved prefs, who must have signed in at least once (pre-tracking). This is
    // the "logged-in users" set the admin asked for, not the full directory.
    const candidateEmails = new Set<string>([...Object.keys(logins), ...Object.keys(all)].map(norm).filter(Boolean));

    const users = Array.from(candidateEmails).map((e) => {
      const staffU = staffByEmail.get(e);
      const vendorU = vendorByEmail.get(e);
      const login = logins[e];
      const saved = all[e] || {};
      const prefs = {} as Record<NotificationKey, boolean>;
      for (const key of NOTIFICATION_KEYS) prefs[key] = saved[key] !== false; // default ON
      return {
        email: staffU?.email || vendorU?.email || e,
        name: staffU?.fullName || vendorU?.name || login?.name || e,
        kind: (staffU ? 'staff' : vendorU ? 'vendor' : 'other') as 'staff' | 'vendor' | 'other',
        lastLoginAt: login?.lastAt || null,
        prefs,
      };
    }).sort((a, b) => {
      // Most-recent sign-in first; never-tracked (null) last, then by name.
      if (!!a.lastLoginAt !== !!b.lastLoginAt) return a.lastLoginAt ? -1 : 1;
      if (a.lastLoginAt && b.lastLoginAt && a.lastLoginAt !== b.lastLoginAt) return a.lastLoginAt < b.lastLoginAt ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

    return res.status(200).json({ users });
  }

  if (req.method === 'POST') {
    const body = (req.body || {}) as { email?: string; prefs?: Record<string, unknown> };
    const email = norm(body.email);
    if (!email) return res.status(400).json({ error: 'email is required' });
    const incoming = body.prefs || {};
    const clean: Partial<Record<NotificationKey, boolean>> = {};
    for (const k of NOTIFICATION_KEYS) if (typeof incoming[k] === 'boolean') clean[k] = incoming[k] as boolean;
    if (!Object.keys(clean).length) return res.status(400).json({ error: 'No valid preferences supplied.' });
    const ok = await setNotificationPrefs(email, clean);
    return res.status(200).json({ ok: true, preview: !ok });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
