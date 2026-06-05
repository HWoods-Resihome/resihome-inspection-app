import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isFinalizeAdmin } from '@/lib/finalizeAccess';
import { isExternalEmail, EXTERNAL_TEMPLATE } from '@/lib/userAccess';

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
    // Whether this user may finalize their OWN submitted inspection (bypass the
    // dual-approval lock). Everyone else must hand off to a second reviewer.
    isFinalizeAdmin: isFinalizeAdmin(user.email),
    // External (non-internal-domain) users are limited to the 1099 template:
    // start one, view 1099-type inspections, no editing completed ones.
    isExternal: external,
    allowedTemplate: external ? EXTERNAL_TEMPLATE : null,
  });
}
