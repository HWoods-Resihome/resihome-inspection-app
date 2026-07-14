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
import { fetchActiveUsers, readNotificationPrefsRaw, fetchInspections, searchServiceWorkOrders } from '@/lib/hubspot';
import { NOTIFICATION_KEYS, type NotificationKey } from '@/lib/notifications/catalog';
import { setNotificationPrefs } from '@/lib/notifications/prefs';
import { SERVICE_VENDORS, vendorEmail as vendorEmailFor } from '@/lib/services/vendors';
import { readLoginActivity } from '@/lib/loginActivity';

export const config = { maxDuration: 60 };

const norm = (e?: string | null) => String(e || '').trim().toLowerCase();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.realEmail || session.email))) return res.status(403).json({ error: 'Admin only.' });

  if (req.method === 'GET') {
    const [staff, raw, logins, inspections, services] = await Promise.all([
      fetchActiveUsers().catch(() => []),
      readNotificationPrefsRaw().catch(() => ({} as Record<string, Record<string, boolean>>)),
      readLoginActivity().catch(() => ({} as Record<string, { lastAt: string; count?: number; name?: string }>)),
      fetchInspections().catch(() => []),
      searchServiceWorkOrders().catch(() => null),
    ]);
    const all = raw || {};
    const staffByEmail = new Map(staff.map((u) => [norm(u.email), u]));
    const vendorByEmail = new Map(SERVICE_VENDORS.map((v) => [norm(v.email), v]));

    // The list is limited to people actually tied to work: anyone ever ASSIGNED
    // as an inspection's inspector or a service's vendor, plus the vendor
    // registry. Everyone else (staff who've never been assigned, etc.) is left
    // off. We collect a best display name from those same records for non-staff
    // assignees (external 1099 inspectors).
    const nameByEmail = new Map<string, string>();
    const candidates = new Set<string>();
    for (const i of inspections) {
      const e = norm(i.inspectorEmail);
      if (e) { candidates.add(e); if (i.inspectorName && !nameByEmail.has(e)) nameByEmail.set(e, i.inspectorName); }
    }
    for (const s of (services || [])) {
      const e = norm(s.vendorEmail || vendorEmailFor(s.vendor) || '');
      if (e) { candidates.add(e); if (s.vendor && !nameByEmail.has(e)) nameByEmail.set(e, s.vendor); }
    }
    for (const v of SERVICE_VENDORS) { const e = norm(v.email); if (e) { candidates.add(e); if (!nameByEmail.has(e)) nameByEmail.set(e, v.name); } }

    const users = Array.from(candidates).map((e) => {
      const staffU = staffByEmail.get(e);
      const vendorU = vendorByEmail.get(e);
      const login = logins[e];
      const saved = all[e] || {};
      const prefs = {} as Record<NotificationKey, boolean>;
      for (const key of NOTIFICATION_KEYS) prefs[key] = saved[key] !== false; // default ON
      return {
        email: staffU?.email || vendorU?.email || e,
        name: staffU?.fullName || vendorU?.name || nameByEmail.get(e) || login?.name || e,
        kind: (vendorU ? 'vendor' : staffU ? 'staff' : 'other') as 'staff' | 'vendor' | 'other',
        lastLoginAt: login?.lastAt || null,
        prefs,
      };
    }).sort((a, b) => {
      // Vendors first (they're the primary dispatch audience), then most-recent
      // sign-in, then name.
      if ((a.kind === 'vendor') !== (b.kind === 'vendor')) return a.kind === 'vendor' ? -1 : 1;
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
