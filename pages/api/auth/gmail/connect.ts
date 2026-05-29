// Initiates the Gmail OAuth flow. Redirects the user to Google's consent
// screen. On approval Google redirects back to /api/auth/gmail/callback.
//
// Query params:
//   finalizeAfter (optional) — an inspection record id. Round-tripped through
//     the OAuth `state` so the callback can bounce the user back to that
//     inspection and auto-kick the finalize flow once connected.

import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { getGmailOAuthConfig, buildGmailConsentUrl } from '@/lib/gmailAuth';
import { randomBytes } from 'crypto';
import { serialize } from 'cookie';

const STATE_COOKIE = 'resihome_gmail_oauth_state';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    res.redirect(302, '/login');
    return;
  }

  const cfg = getGmailOAuthConfig();
  if (!cfg) {
    res.status(503).send(
      'Gmail is not configured on the server yet. Set GMAIL_CLIENT_ID, ' +
      'GMAIL_CLIENT_SECRET, and GMAIL_REDIRECT_URI environment variables.'
    );
    return;
  }

  // CSRF token + optional finalizeAfter, packed into state.
  const csrf = randomBytes(16).toString('hex');
  const finalizeAfter = typeof req.query.finalizeAfter === 'string' ? req.query.finalizeAfter : '';
  const state = `${csrf}.${finalizeAfter}`;

  // Stash the CSRF token in a short-lived cookie so the callback can verify
  // the state wasn't forged.
  res.setHeader('Set-Cookie', serialize(STATE_COOKIE, csrf, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 10 * 60, // 10 minutes to complete the flow
  }));

  const url = buildGmailConsentUrl(cfg, { state, loginHint: session.email });
  res.redirect(302, url);
}
