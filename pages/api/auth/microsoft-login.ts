// Microsoft / Outlook sign-in start — the Microsoft equivalent of
// google-login.ts. The user has typed a HubSpot-validated email; this proves
// they control it by signing in with Microsoft. No session exists yet — it's
// minted in the callback only after Microsoft confirms the email matches.

import type { NextApiRequest, NextApiResponse } from 'next';
import { fetchUsers } from '@/lib/hubspot';
import { getMicrosoftOAuthConfig, buildMicrosoftConsentUrl } from '@/lib/microsoftAuth';
import { isInternalEmail } from '@/lib/userAccess';
import { randomBytes } from 'crypto';
import { serialize } from 'cookie';

const STATE_COOKIE = 'resihome_mslogin_oauth_state';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';
  if (!email || !email.includes('@')) {
    res.redirect(302, '/login?error=invalid_email');
    return;
  }

  const cfg = getMicrosoftOAuthConfig();
  if (!cfg) {
    res.redirect(302, '/login?error=microsoft_not_configured');
    return;
  }

  // Microsoft sign-in is for EXTERNAL (1099) agents only; internal staff use
  // Google (Workspace identity + the Gmail-send token). Block internal emails
  // even if this route is hit directly.
  if (isInternalEmail(email)) {
    res.redirect(302, '/login?error=microsoft_internal_blocked');
    return;
  }

  // Re-validate the email against HubSpot users server-side (don't trust the
  // client). Generic failure so we don't leak which emails exist.
  try {
    const users = await fetchUsers();
    if (!users.find((u) => u.email.toLowerCase() === email)) {
      res.redirect(302, '/login?error=not_recognized');
      return;
    }
  } catch (e) {
    console.error('[microsoft-login] HubSpot user check failed:', e);
    res.redirect(302, '/login?error=verify_failed');
    return;
  }

  // state = csrf.<urlencoded-email>[.native] — identical scheme to google-login,
  // so the callback parses it the same way (emails contain dots).
  const csrf = randomBytes(16).toString('hex');
  const isNative = req.query.client === 'native';
  let state = `${csrf}.${encodeURIComponent(email)}`;
  if (isNative) state += '.native';

  res.setHeader('Set-Cookie', serialize(STATE_COOKIE, csrf, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 10 * 60,
  }));

  res.redirect(302, buildMicrosoftConsentUrl(cfg, { state, loginHint: email }));
}
