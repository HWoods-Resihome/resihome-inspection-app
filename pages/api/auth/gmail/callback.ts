// Gmail OAuth callback. Google redirects here after the user approves.
//
// Steps:
//   1. Verify the state cookie matches (CSRF protection)
//   2. Exchange the authorization code for a refresh token
//   3. Encrypt + store the refresh token in an HTTP-only cookie
//   4. Redirect the user back into the app. If a finalizeAfter inspection id
//      was carried through, redirect to that inspection with ?finalizeNow=1
//      so the page auto-kicks the finalize flow.

import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import {
  getGmailOAuthConfig,
  exchangeCodeForRefreshToken,
  gmailTokenCookie,
} from '@/lib/gmailAuth';
import { parse, serialize } from 'cookie';

const STATE_COOKIE = 'resihome_gmail_oauth_state';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    res.redirect(302, '/login');
    return;
  }

  const cfg = getGmailOAuthConfig();
  if (!cfg) {
    res.status(503).send('Gmail not configured.');
    return;
  }

  // Handle user-denied / error responses from Google
  if (req.query.error) {
    res.redirect(302, `/?gmail_error=${encodeURIComponent(String(req.query.error))}`);
    return;
  }

  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  if (!code || !state) {
    res.redirect(302, '/?gmail_error=missing_code');
    return;
  }

  // Verify CSRF
  const cookies = parse(req.headers.cookie || '');
  const expectedCsrf = cookies[STATE_COOKIE];
  const [csrf, finalizeAfter] = state.split('.');
  if (!expectedCsrf || expectedCsrf !== csrf) {
    res.redirect(302, '/?gmail_error=state_mismatch');
    return;
  }

  try {
    const { refreshToken } = await exchangeCodeForRefreshToken(cfg, code);
    if (!refreshToken) {
      // Google only returns a refresh token when access_type=offline +
      // prompt=consent (both set in buildGmailConsentUrl). If it's still
      // missing the user may have a stale grant; ask them to retry.
      res.redirect(302, '/?gmail_error=no_refresh_token');
      return;
    }

    // Store encrypted token cookie + clear the state cookie.
    res.setHeader('Set-Cookie', [
      gmailTokenCookie(refreshToken),
      serialize(STATE_COOKIE, '', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 0,
      }),
    ]);

    // Redirect: if we came from a finalize attempt, bounce back to that
    // inspection and auto-run finalize. Otherwise land on home with a success
    // flag the UI can toast on.
    if (finalizeAfter) {
      res.redirect(302, `/inspection/${finalizeAfter}?finalizeNow=1`);
    } else {
      res.redirect(302, '/?gmail_connected=1');
    }
  } catch (e: any) {
    console.error('[gmail callback] token exchange failed:', e);
    res.redirect(302, `/?gmail_error=${encodeURIComponent('exchange_failed')}`);
  }
}
