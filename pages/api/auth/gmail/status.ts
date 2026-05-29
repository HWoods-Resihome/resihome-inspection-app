// GET: report whether the current user has Gmail connected (token cookie
//      present) and whether the server is configured for OAuth at all.
// DELETE: disconnect (clear the token cookie).

import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { getGmailOAuthConfig, getGmailRefreshToken, clearGmailTokenCookie } from '@/lib/gmailAuth';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', clearGmailTokenCookie());
    res.status(200).json({ connected: false });
    return;
  }

  // GET
  const configured = Boolean(getGmailOAuthConfig());
  const connected = Boolean(getGmailRefreshToken(req));
  res.status(200).json({ configured, connected });
}
