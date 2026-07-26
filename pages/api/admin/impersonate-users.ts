/**
 * GET /api/admin/impersonate-users — the impersonatable USER roster for the admin
 * "view as" picker. App-admin only.
 *
 * Union of two sources so nobody is missing:
 *   1. The active STAFF directory (fetchActiveUsers) — every current user, even
 *      one who has never been on an inspection (e.g. a new hire like Laura).
 *   2. Inspectors seen across inspections — catches external/1099 agents who may
 *      not be in the staff owner directory.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { fetchInspections, fetchActiveUsers } from '@/lib/hubspot';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.realEmail || session.email))) return res.status(403).json({ error: 'Admin only.' });

  try {
    const [all, staff] = await Promise.all([
      fetchInspections(),
      fetchActiveUsers().catch(() => []),
    ]);
    const byEmail = new Map<string, string>(); // lowercased email → display name
    // Inspectors from inspections first (covers external agents not in the directory)…
    for (const i of all) {
      const email = (i.inspectorEmail || '').trim();
      if (!email.includes('@')) continue;
      const key = email.toLowerCase();
      if (!byEmail.has(key)) byEmail.set(key, i.inspectorName || email);
    }
    // …then every active staff user (adds anyone with no inspections, and prefers
    // the directory's authoritative name over a stale inspection snapshot).
    for (const u of staff) {
      const email = (u.email || '').trim();
      if (!email.includes('@')) continue;
      byEmail.set(email.toLowerCase(), u.fullName || byEmail.get(email.toLowerCase()) || email);
    }
    const users = Array.from(byEmail.entries())
      .map(([email, name]) => ({ email, name }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
    return res.status(200).json({ users });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
