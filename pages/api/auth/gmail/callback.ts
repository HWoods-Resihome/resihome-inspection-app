// Google OAuth callback — shared by TWO flows, distinguished by which state
// cookie is present:
//
//  (A) LOGIN flow (resihome_login_oauth_state): no session exists yet. We
//      verify the Google account's email matches the claimed (HubSpot-validated)
//      email, then mint the 30-day session. If a Gmail refresh token was granted
//      (internal users), store it too. This is the new auth gate.
//
//  (B) CONNECT flow (resihome_gmail_oauth_state): user is already logged in and
//      is connecting/repairing Gmail send. Requires a session. (Legacy behavior.)

import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest, createSessionCookie } from '@/lib/auth';
import {
  getGmailOAuthConfig,
  exchangeCodeForRefreshToken,
  gmailTokenCookie,
  emailFromIdToken,
} from '@/lib/gmailAuth';
import { fetchUsers } from '@/lib/hubspot';
import { parse, serialize } from 'cookie';

const LOGIN_STATE_COOKIE = 'resihome_login_oauth_state';
const CONNECT_STATE_COOKIE = 'resihome_gmail_oauth_state';

function clearCookie(name: string): string {
  return serialize(name, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cfg = getGmailOAuthConfig();
  if (!cfg) {
    res.status(503).send('Gmail not configured.');
    return;
  }

  const cookies = parse(req.headers.cookie || '');
  const isLoginFlow = !!cookies[LOGIN_STATE_COOKIE];

  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';

  // ---------------------------------------------------------------
  // (A) LOGIN flow — the auth gate
  // ---------------------------------------------------------------
  if (isLoginFlow) {
    const fail = (reason: string) => res.redirect(302, `/login?error=${encodeURIComponent(reason)}`);

    if (req.query.error) return fail(String(req.query.error));
    if (!code || !state) return fail('google_missing_code');

    const expectedCsrf = cookies[LOGIN_STATE_COOKIE];
    const dot = state.indexOf('.');
    const csrf = dot >= 0 ? state.slice(0, dot) : state;
    const claimedEmail = dot >= 0 ? decodeURIComponent(state.slice(dot + 1)).toLowerCase() : '';
    if (!expectedCsrf || expectedCsrf !== csrf) return fail('google_state_mismatch');
    if (!claimedEmail) return fail('google_state_mismatch');

    let verifiedEmail: string | null = null;
    let refreshToken: string | null = null;
    try {
      const r = await exchangeCodeForRefreshToken(cfg, code);
      refreshToken = r.refreshToken;
      verifiedEmail = r.idToken ? emailFromIdToken(r.idToken) : null;
    } catch (e) {
      console.error('[login callback] token exchange failed:', e);
      return fail('google_exchange_failed');
    }

    if (!verifiedEmail) return fail('google_no_identity');

    // SECURITY: the Google account that authenticated must be the same email
    // the user claimed (and that we HubSpot-validated). This is the whole point.
    if (verifiedEmail !== claimedEmail) {
      console.warn(`[login callback] email mismatch: claimed=${claimedEmail} google=${verifiedEmail}`);
      return fail('google_email_mismatch');
    }

    // Re-confirm the verified email is still an active HubSpot user, then mint
    // the session against the canonical HubSpot record.
    let match;
    try {
      const users = await fetchUsers();
      match = users.find((u) => u.email.toLowerCase() === verifiedEmail);
    } catch (e) {
      console.error('[login callback] HubSpot user check failed:', e);
      return fail('verify_failed');
    }
    if (!match) return fail('not_recognized');

    const sessionCookie = await createSessionCookie({
      userId: match.id,
      email: match.email,
      name: match.fullName,
    });

    // Store the Gmail refresh token if Google granted one (internal users who
    // approved the send scope). External users may not grant it — that's fine,
    // they're authenticated either way and don't send email.
    const setCookies: string[] = [sessionCookie, clearCookie(LOGIN_STATE_COOKIE)];
    if (refreshToken) setCookies.push(gmailTokenCookie(refreshToken));
    res.setHeader('Set-Cookie', setCookies);

    res.redirect(302, '/');
    return;
  }

  // ---------------------------------------------------------------
  // (B) CONNECT flow — legacy, requires an existing session
  // ---------------------------------------------------------------
  const session = await getSessionFromRequest(req);
  if (!session) {
    res.redirect(302, '/login');
    return;
  }

  if (req.query.error) {
    res.redirect(302, `/?gmail_error=${encodeURIComponent(String(req.query.error))}`);
    return;
  }
  if (!code || !state) {
    res.redirect(302, '/?gmail_error=missing_code');
    return;
  }

  const expectedCsrf = cookies[CONNECT_STATE_COOKIE];
  const [csrf, finalizeAfter] = state.split('.');
  if (!expectedCsrf || expectedCsrf !== csrf) {
    res.redirect(302, '/?gmail_error=state_mismatch');
    return;
  }

  try {
    const { refreshToken } = await exchangeCodeForRefreshToken(cfg, code);
    if (!refreshToken) {
      res.redirect(302, '/?gmail_error=no_refresh_token');
      return;
    }
    res.setHeader('Set-Cookie', [
      gmailTokenCookie(refreshToken),
      clearCookie(CONNECT_STATE_COOKIE),
    ]);
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
