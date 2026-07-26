/**
 * GET /api/admin/impersonate-users — the impersonatable USER roster for the admin
 * "view as" picker. App-admin only.
 *
 * A user qualifies when they (have been on an inspection OR have logged in at
 * least once) AND are still active. So a real user who's signed in shows up even
 * with no inspections (e.g. Laura), while stale directory entries who've never
 * touched the app don't clutter the list, and deactivated/removed users drop off.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { fetchInspections } from '@/lib/hubspot';
import { readLoginActivity } from '@/lib/loginActivity';
import { isResiwalkActive } from '@/lib/userManagement';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.realEmail || session.email))) return res.status(403).json({ error: 'Admin only.' });

  try {
    const [all, loginMap] = await Promise.all([
      fetchInspections(),
      readLoginActivity().catch(() => ({})),
    ]);
    const byEmail = new Map<string, string>(); // lowercased email → display name
    // Candidates: inspectors seen on inspections…
    for (const i of all) {
      const email = (i.inspectorEmail || '').trim();
      if (!email.includes('@')) continue;
      const key = email.toLowerCase();
      if (!byEmail.has(key)) byEmail.set(key, i.inspectorName || email);
    }
    // …plus anyone who has actually signed in at least once.
    for (const [email, rec] of Object.entries(loginMap)) {
      const key = String(email).trim().toLowerCase();
      if (!key.includes('@')) continue;
      if (!byEmail.has(key)) byEmail.set(key, (rec?.name || '').trim() || email);
    }
    // Keep only still-active users (drops explicitly deactivated / removed).
    const entries = Array.from(byEmail.entries());
    const active = await Promise.all(entries.map(([email]) => isResiwalkActive(email).catch(() => true)));
    const users = entries
      .filter((_, i) => active[i])
      .map(([email, name]) => ({ email, name }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
    return res.status(200).json({ users });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
