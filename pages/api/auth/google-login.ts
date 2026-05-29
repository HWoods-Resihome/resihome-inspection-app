// Step 2 of login: the user has typed an email that we've confirmed is an
// active HubSpot user. This route starts the Google sign-in challenge to PROVE
// they control that email. No session exists yet — the session is only minted
// in the callback after Google confirms the email matches.
//
// Query params:
//   email (required) — the claimed email (already HubSpot-validated client-side
//     via /api/auth/login, but we re-validate here server-side too).

import type { NextApiRequest, NextApiResponse } from 'next';
import { fetchUsers } from '@/lib/hubspot';
import { getGmailOAuthConfig, buildGmailConsentUrl, LOGIN_SCOPES } from '@/lib/gmailAuth';
import { randomBytes } from 'crypto';
import { serialize } from 'cookie';

const STATE_COOKIE = 'resihome_login_oauth_state';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';
  if (!email || !email.includes('@')) {
    res.redirect(302, '/login?error=invalid_email');
    return;
  }

  const cfg = getGmailOAuthConfig();
  if (!cfg) {
    res.redirect(302, '/login?error=google_not_configured');
    return;
  }

  // Re-validate the email against HubSpot users server-side (don't trust the
  // client). Same generic failure as the email step so we don't leak which
  // emails exist.
  try {
    const users = await fetchUsers();
    const match = users.find((u) => u.email.toLowerCase() === email);
    if (!match) {
      res.redirect(302, '/login?error=not_recognized');
      return;
    }
  } catch (e) {
    console.error('[google-login] HubSpot user check failed:', e);
    res.redirect(302, '/login?error=verify_failed');
    return;
  }

  // Pack a CSRF token + the claimed email into state so the callback can both
  // verify the request wasn't forged and know which email to match against.
  const csrf = randomBytes(16).toString('hex');
  const state = `${csrf}.${encodeURIComponent(email)}`;

  res.setHeader('Set-Cookie', serialize(STATE_COOKIE, csrf, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 10 * 60, // 10 minutes to complete the Google flow
  }));

  // Request identity + Gmail-send scopes. login_hint pre-fills the account.
  const url = buildGmailConsentUrl(cfg, {
    state,
    loginHint: email,
    scope: LOGIN_SCOPES,
  });
  res.redirect(302, url);
}
