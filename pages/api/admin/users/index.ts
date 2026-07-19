/**
 * /api/admin/users — internal user management (admin only).
 *
 *   GET  → the roster of internal users who have signed in at least once, each
 *          with name, email, last-login, and resolved access flags (ResiWALK
 *          Active, Inspections, Services, Insights, Admin).
 *   POST → apply per-user access patches. Body: { updates: { email: { active?,
 *          inspections?, services?, insights?, admin? } } }. Supports one user or
 *          a bulk map. A flag of null clears the override (back to default).
 *
 * Source of the roster is the login-activity blob (everyone who has logged in),
 * filtered to internal emails and merged with the per-user override store.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { servicesEnabled } from '@/lib/servicesAccess';
import { canViewInsights } from '@/lib/insightsAccess';
import { isInternalEmail } from '@/lib/userAccess';
import { readLoginActivity } from '@/lib/loginActivity';
import { readAppUsers } from '@/lib/hubspot';
import { isResiwalkActive, inspectionsEnabled, applyUserPatches, isSeedUserEmail, type UserPatch } from '@/lib/userManagement';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.email))) return res.status(403).json({ error: 'Admin only' });

  if (req.method === 'GET') {
    try {
      const [activity, overrides] = await Promise.all([readLoginActivity(), readAppUsers()]);
      const emails = Array.from(new Set(
        [...Object.keys(activity), ...Object.keys(overrides)]
          .map((e) => e.trim().toLowerCase())
          .filter((e) => e && isInternalEmail(e)),
      ));
      const users = await Promise.all(emails.map(async (email) => {
        const act = activity[email] || {};
        const ov = overrides[email] || {};
        const [active, inspections, services, insights, admin] = await Promise.all([
          isResiwalkActive(email), inspectionsEnabled(email), servicesEnabled(email), canViewInsights(email), isAppAdmin(email),
        ]);
        return {
          email,
          name: (ov.name || act.name || '').toString(),
          lastLogin: act.lastAt || null,
          loginCount: act.count || 0,
          seed: isSeedUserEmail(email),
          access: { active, inspections, services, insights, admin },
        };
      }));
      users.sort((a, b) => (b.lastLogin || '').localeCompare(a.lastLogin || ''));
      return res.status(200).json({ users });
    } catch (e: any) {
      return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
    }
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const updates = body.updates && typeof body.updates === 'object' ? body.updates as Record<string, UserPatch> : null;
    if (!updates || !Object.keys(updates).length) return res.status(400).json({ error: 'updates map is required' });
    try {
      const ok = await applyUserPatches(updates, session.email);
      if (!ok) return res.status(500).json({ error: 'Could not save changes.' });
      return res.status(200).json({ ok: true, count: Object.keys(updates).length });
    } catch (e: any) {
      return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
