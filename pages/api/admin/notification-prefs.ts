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

const norm = (e?: string | null) => String(e || '').trim().toLowerCase();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.realEmail || session.email))) return res.status(403).json({ error: 'Admin only.' });

  if (req.method === 'GET') {
    const [staff, raw] = await Promise.all([
      fetchActiveUsers().catch(() => []),
      readNotificationPrefsRaw().catch(() => ({} as Record<string, Record<string, boolean>>)),
    ]);
    const all = raw || {};
    // Union of staff, vendors, and anyone who already has saved prefs.
    const byEmail = new Map<string, { email: string; name: string; kind: 'staff' | 'vendor' | 'other' }>();
    for (const u of staff) { const e = norm(u.email); if (e) byEmail.set(e, { email: u.email, name: u.fullName || u.email, kind: 'staff' }); }
    for (const v of SERVICE_VENDORS) { const e = norm(v.email); if (e && !byEmail.has(e)) byEmail.set(e, { email: v.email, name: v.name, kind: 'vendor' }); }
    for (const e of Object.keys(all)) { const k = norm(e); if (k && !byEmail.has(k)) byEmail.set(k, { email: e, name: e, kind: 'other' }); }

    const users = Array.from(byEmail.values())
      .map((u) => {
        const saved = all[norm(u.email)] || {};
        const prefs = {} as Record<NotificationKey, boolean>;
        for (const key of NOTIFICATION_KEYS) prefs[key] = saved[key] !== false; // default ON
        return { ...u, prefs };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

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
