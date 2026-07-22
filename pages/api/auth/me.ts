import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isFinalizeAdmin } from '@/lib/finalizeAccess';
import { isExternalEmail, EXTERNAL_TEMPLATE } from '@/lib/userAccess';
import { isAppAdmin } from '@/lib/adminAccess';
import { servicesEnabled } from '@/lib/servicesAccess';
import { canViewInsights } from '@/lib/insightsAccess';
import { isResiwalkActive, inspectionsEnabled, inspectionAccessLevel } from '@/lib/userManagement';
import { vendorInspectionLevel } from '@/lib/inspectionGuard';
import { warnOnBootIfMisconfigured } from '@/lib/configValidation';

// Cheap, env-only, once-per-cold-instance: log a warning if a required env var
// is missing/invalid. Hit on essentially every app load, so it acts as a boot
// check without a dedicated boot hook (serverless has none).
warnOnBootIfMisconfigured();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const user = await getSessionFromRequest(req);
  if (!user) return res.status(401).json({ authenticated: false });
  // ResiWalk Active gate: a user an admin has switched OFF is treated as signed
  // out (vendors are never gated here). Seed admins are always active. Effective
  // within the ~60s override cache. Skipped for the impersonation target so
  // "view as" still works.
  if (!user.vendor && !user.impersonating && !(await isResiwalkActive(user.email).catch(() => true))) {
    return res.status(200).json({ authenticated: false, deactivated: true });
  }
  const external = isExternalEmail(user.email);
  const isAdmin = await isAppAdmin(user.email);
  // Effective inspections LEVEL: a vendor's tri-state (Vendor Management) or a
  // per-user override (User Management) can grant FULL — "everything, any type,
  // like an internal user". Only below-full external users keep the 1099-only
  // template restriction; domain alone no longer decides it.
  const level = user.vendor
    ? ((await vendorInspectionLevel(user.email).catch(() => null)) ?? 'limited')
    : await inspectionAccessLevel(user.email).catch(() => (external ? 'limited' as const : 'full' as const));
  const externalRestricted = external && level !== 'full';
  return res.status(200).json({
    authenticated: true,
    user,
    // App admin: AI Knowledge curation, the form builder, and admin management.
    isAdmin,
    // Per-section access (from User Management, backward-compatible defaults) so
    // the app can show/hide sections to match each user's toggles.
    access: {
      inspections: await inspectionsEnabled(user.email).catch(() => true),
      services: await servicesEnabled(user.email).catch(() => false),
      insights: await canViewInsights(user.email).catch(() => false),
      admin: isAdmin,
    },
    // Whether this user may finalize their OWN submitted inspection (bypass the
    // dual-approval lock). Everyone else must hand off to a second reviewer.
    isFinalizeAdmin: isFinalizeAdmin(user.email),
    // External (non-internal-domain) users are limited to the 1099 template —
    // UNLESS their effective inspections level is FULL (vendor tri-state or
    // User Management override), which unlocks every template like an internal
    // user. Server-side write guards enforce the same level independently.
    isExternal: externalRestricted,
    allowedTemplate: externalRestricted ? EXTERNAL_TEMPLATE : null,
    // Admin "view as": when set, isAdmin/isExternal above reflect the IMPERSONATED
    // user (so the app shows exactly what they'd see); realEmail is the admin, used
    // to render the banner + allow stopping.
    impersonating: !!user.impersonating,
    realEmail: user.realEmail || null,
    realName: user.realName || null,
  });
}
