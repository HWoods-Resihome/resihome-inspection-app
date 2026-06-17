// Step 2 of login: the user has typed an email that we've confirmed is an
// active HubSpot user. This route starts the Google sign-in challenge to PROVE
// they control that email. No session exists yet — the session is only minted
// in the callback after Google confirms the email matches.
//
// Query params:
//   email (required) — the claimed email (already HubSpot-validated client-side
//     via /api/auth/login, but we re-validate here server-side too).

import type { NextApiRequest, NextApiResponse } from 'next';
import { fetchActiveUsers } from '@/lib/hubspot';
import { getLoginOAuthConfig, buildGmailConsentUrl, LOGIN_SCOPES, IDENTITY_SCOPES, GMAIL_TOKEN_COOKIE } from '@/lib/gmailAuth';
import { isInternalEmail } from '@/lib/userAccess';
import { randomBytes } from 'crypto';
import { serialize } from 'cookie';

const STATE_COOKIE = 'resihome_login_oauth_state';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';
  if (!email || !email.includes('@')) {
    res.redirect(302, '/login?error=invalid_email');
    return;
  }

  // External (1099) users sign in through the SEPARATE External OAuth app
  // (identity-only, non-Workspace-allowed); internal users use the main app.
  const external = !isInternalEmail(email);
  const cfg = getLoginOAuthConfig(external);
  if (!cfg) {
    res.redirect(302, '/login?error=google_not_configured');
    return;
  }

  // Re-validate the email against HubSpot users server-side (don't trust the
  // client). Same generic failure as the email step so we don't leak which
  // emails exist.
  try {
    const users = await fetchActiveUsers();
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
  // For native (Capacitor) logins we also carry a `client=native` marker so the
  // callback knows to return via the resiwalk:// deep link instead of 302->/.
  // The marker rides in `state` (not a cookie/query) because only `state`
  // reliably survives the Google round-trip back into the system browser.
  // Format: csrf.<urlencoded-email>[.native]. The callback splits csrf off the
  // FRONT (first dot) and the optional marker off the END, leaving the email.
  const csrf = randomBytes(16).toString('hex');
  const isNative = req.query.client === 'native';
  let state = `${csrf}.${encodeURIComponent(email)}`;
  if (isNative) state += '.native';

  res.setHeader('Set-Cookie', serialize(STATE_COOKIE, csrf, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 10 * 60, // 10 minutes to complete the Google flow
  }));

  // Request identity + Gmail-send scopes. login_hint pre-fills the account.
  // Only FORCE the consent screen when we don't already hold a Gmail refresh
  // token (first login, or after it expired). Returning users who already
  // granted it just pick their account — no repeated "Allow" on every sign-in.
  // (The refresh token persists in its cookie, so email send still works.)
  // External (1099) users never send email, so request IDENTITY scopes only —
  // a clean, non-restricted Google consent (no Gmail-send "restricted" scope).
  // Internal users also get the Gmail-send scope so they can send inspection
  // emails. (The Gmail send scope is what makes the OAuth app "restricted"; only
  // internal sign-ins exercise it.)
  const hasGmailToken = !!req.cookies?.[GMAIL_TOKEN_COOKIE];
  // reconnect=1 (the in-app "Connect Gmail" button) MUST force the consent
  // screen: Google only returns a refresh_token on an explicit consent, so a
  // bare account-picker would re-auth without granting a usable Gmail token and
  // the app would keep showing "Connect Gmail".
  const reconnect = req.query.reconnect === '1';
  const url = buildGmailConsentUrl(cfg, {
    state,
    loginHint: email,
    scope: external ? IDENTITY_SCOPES : LOGIN_SCOPES,
    prompt: external ? 'select_account' : ((hasGmailToken && !reconnect) ? 'select_account' : 'consent'),
  });
  res.redirect(302, url);
}
