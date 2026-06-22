import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isFinalizeAdmin } from '@/lib/finalizeAccess';
import { isExternalEmail, EXTERNAL_TEMPLATE } from '@/lib/userAccess';
import { isAppAdmin } from '@/lib/adminAccess';
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
  const external = isExternalEmail(user.email);
  return res.status(200).json({
    authenticated: true,
    user,
    // App admin: AI Knowledge curation, the form builder, and admin management.
    isAdmin: await isAppAdmin(user.email),
    // Whether this user may finalize their OWN submitted inspection (bypass the
    // dual-approval lock). Everyone else must hand off to a second reviewer.
    isFinalizeAdmin: isFinalizeAdmin(user.email),
    // External (non-internal-domain) users are limited to the 1099 template:
    // start one, view 1099-type inspections, no editing completed ones.
    isExternal: external,
    allowedTemplate: external ? EXTERNAL_TEMPLATE : null,
    // Admin "view as": when set, isAdmin/isExternal above reflect the IMPERSONATED
    // user (so the app shows exactly what they'd see); realEmail is the admin, used
    // to render the banner + allow stopping.
    impersonating: !!user.impersonating,
    realEmail: user.realEmail || null,
    realName: user.realName || null,
  });
}
