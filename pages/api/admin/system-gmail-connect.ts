/**
 * GET /api/admin/system-gmail-connect  (app-admin only)
 *
 * Re-mint the SYSTEM mailbox refresh token with BOTH scopes the app needs:
 * gmail.send (notifications, sign-in codes) AND gmail.modify (reading reply
 * emails into service note threads + marking them read).
 *
 * Flow: this endpoint redirects to Google's consent screen signed into the
 * system mailbox (login_hint = SYSTEM_GMAIL_FROM). Approving lands on the
 * shared OAuth callback, which recognizes the system-mint state cookie and
 * shows the new refresh token with paste-into-Vercel instructions — the token
 * is NOT stored anywhere by this flow.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { randomBytes } from 'crypto';
import { serialize } from 'cookie';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { getGmailOAuthConfig, buildGmailConsentUrl, GMAIL_SEND_SCOPE } from '@/lib/gmailAuth';

export const SYSTEM_GMAIL_STATE_COOKIE = 'resihome_sysgmail_oauth_state';
export const SYSTEM_GMAIL_SCOPES = `openid email ${GMAIL_SEND_SCOPE} https://www.googleapis.com/auth/gmail.modify`;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email) return res.status(401).send('Not authenticated.');
  if (!(await isAppAdmin(session.realEmail || session.email).catch(() => false))) {
    return res.status(403).send('Admin only.');
  }
  const cfg = getGmailOAuthConfig();
  if (!cfg) return res.status(503).send('Gmail OAuth is not configured (GMAIL_CLIENT_ID / SECRET / REDIRECT_URI).');

  const csrf = randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', serialize(SYSTEM_GMAIL_STATE_COOKIE, csrf, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 10 * 60, // the consent round-trip only
  }));
  res.redirect(302, buildGmailConsentUrl(cfg, {
    state: csrf,
    scope: SYSTEM_GMAIL_SCOPES,
    loginHint: process.env.SYSTEM_GMAIL_FROM || undefined,
    prompt: 'consent',   // force a fresh refresh token
  }));
}
