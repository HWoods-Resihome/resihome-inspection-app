/**
 * /api/admin/users — internal user management (admin only).
 *
 *   GET  → the roster of internal users who have signed in at least once, each
 *          with name, email, last-login, and resolved access flags (ResiWalk
 *          Active, Inspections, Services, Insights, Admin).
 *   POST → apply per-user access patches. Body: { updates: { email: { active?,
 *          inspections?, services?, insights?, admin? } } }. Supports one user or
 *          a bulk map. A flag of null clears the override (back to default).
 *
 * Roster = people we KNOW have used the app: login activity ∪ saved overrides
 * ∪ inspectors seen on completed inspections (catches anyone whose sign-ins
 * predate activity tracking), INCLUDING external 1099 inspectors. Vendor
 * COMPANIES are excluded — they're managed under Vendor Management, not here.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { isInternalEmail, INTERNAL_EMAIL_ALLOWLIST } from '@/lib/userAccess';
import { readLoginActivity } from '@/lib/loginActivity';
import { readAppUsers, readAppAdmins, readInsightsUsers, fetchActiveUsers, fetchVendorAdminList, completedInspectorDirectory } from '@/lib/hubspot';
import { applyUserPatches, isSeedUserEmail, type UserPatch } from '@/lib/userManagement';

// The roster fans out ~7 HubSpot reads (login activity, overrides, the active-
// users allowlist, vendor list, admins, insights, completed-inspector scan).
// Give it real headroom so a cold instance never trips the default timeout and
// returns a non-JSON error.
export const config = { maxDuration: 60 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.email))) return res.status(403).json({ error: 'Admin only' });

  if (req.method === 'GET') {
    try {
      // Read every map ONCE, in parallel, then compute each user's flags inline.
      // (Calling the per-user resolvers instead caused a cold-cache stampede —
      // every user concurrently re-fetching the same admin/insights/override
      // blobs, dozens of duplicate HubSpot round-trips — which made this slow.)
      const [activity, overrides, hubspotUsers, vendors, adminList, insightsList, inspectorDir] = await Promise.all([
        readLoginActivity(),
        readAppUsers(),
        fetchActiveUsers().catch(() => []),   // names only — not a roster source
        fetchVendorAdminList().catch(() => []),
        readAppAdmins().catch(() => []),
        readInsightsUsers().catch(() => []),
        completedInspectorDirectory().catch(() => ({} as Record<string, string>)),
      ]);
      // Vendor COMPANY emails never belong in the people roster.
      const vendorEmails = new Set(vendors.map((v) => v.email.trim().toLowerCase()).filter(Boolean));
      // Name fallbacks for users with no activity record.
      const hsName = new Map<string, string>();
      for (const u of hubspotUsers) hsName.set(String(u.email || '').trim().toLowerCase(), String(u.fullName || ''));
      const adminSet = new Set(adminList.map((a) => a.email.trim().toLowerCase()));
      const insightsSet = new Set(insightsList.map((u) => u.email.trim().toLowerCase()));
      // Only people we KNOW used the app: signed in, has an override, or has
      // an inspection completed under their email — plus the code-allowlisted
      // staffers on outside domains (e.g. romack.dustin@gmail.com), so their
      // access is always visible/editable here even before any activity record.
      const emails = Array.from(new Set(
        [...Object.keys(activity), ...Object.keys(overrides), ...Object.keys(inspectorDir), ...INTERNAL_EMAIL_ALLOWLIST]
          .map((e) => e.trim().toLowerCase())
          .filter((e) => e && e.includes('@') && !vendorEmails.has(e)),
      ));
      const users = emails.map((email) => {
        const act = activity[email] || {};
        const ov = overrides[email] || {};
        const seed = isSeedUserEmail(email);
        // Same resolution the gates use, but from the pre-read maps (no per-user IO).
        const admin = seed ? true : (typeof ov.admin === 'boolean' ? ov.admin : adminSet.has(email));
        const services = typeof ov.services === 'boolean' ? ov.services : admin;
        const insights = typeof ov.insights === 'boolean' ? ov.insights : (admin || insightsSet.has(email));
        // Inspections is TRI-STATE (none/limited/full). Defaults: internal →
        // full; external 1099 → limited. Legacy booleans: false → none, true →
        // the domain default (matches inspectionAccessLevel).
        const iv = ov.inspections;
        const inspections: 'none' | 'limited' | 'full' =
          (iv === 'none' || iv === 'limited' || iv === 'full') ? iv
            : iv === false ? 'none'
              : isInternalEmail(email) ? 'full' : 'limited';
        const active = seed ? true : ov.active !== false;
        return {
          email,
          name: (ov.name || act.name || hsName.get(email) || inspectorDir[email] || '').toString(),
          lastLogin: act.lastAt || null,
          loginCount: act.count || 0,
          seed,
          access: { active, inspections, services, insights, admin },
        };
      });
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
