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
import { getSessionFromRequest, createSessionCookie, createOAuthExchangeToken, readReturnTo, clearReturnToCookie } from '@/lib/auth';
import {
  getGmailOAuthConfig,
  getLoginOAuthConfig,
  exchangeCodeForRefreshToken,
  gmailTokenCookie,
  emailFromIdToken,
  encryptToken,
} from '@/lib/gmailAuth';
import { fetchActiveUsers } from '@/lib/hubspot';
import { isWorkspaceDomainEmail } from '@/lib/userAccess';
import { parse, serialize } from 'cookie';

const LOGIN_STATE_COOKIE = 'resihome_login_oauth_state';
const CONNECT_STATE_COOKIE = 'resihome_gmail_oauth_state';
// (C) SYSTEM-MAILBOX MINT flow — admin re-minting SYSTEM_GMAIL_REFRESH_TOKEN
// with send+modify scopes (see /api/admin/system-gmail-connect).
const SYSTEM_STATE_COOKIE = 'resihome_sysgmail_oauth_state';

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
  // (C) SYSTEM-MAILBOX MINT flow — matched FIRST by exact state match with its
  // own cookie (so a stale login/connect cookie can't misroute it). Shows the
  // fresh refresh token to the app admin who started the flow; stores nothing.
  // ---------------------------------------------------------------
  if (cookies[SYSTEM_STATE_COOKIE] && state && state === cookies[SYSTEM_STATE_COOKIE]) {
    res.setHeader('Set-Cookie', clearCookie(SYSTEM_STATE_COOKIE));
    const { getSessionFromRequest: getSess } = await import('@/lib/auth');
    const { isAppAdmin } = await import('@/lib/adminAccess');
    const sess = await getSess(req).catch(() => null);
    if (!sess?.email || !(await isAppAdmin(sess.realEmail || sess.email).catch(() => false))) {
      return res.status(403).send('Admin only.');
    }
    if (req.query.error) return res.status(400).send(`Google returned: ${String(req.query.error)}`);
    if (!code) return res.status(400).send('Missing authorization code.');
    try {
      const r = await exchangeCodeForRefreshToken(cfg, code);
      const grantedEmail = r.idToken ? emailFromIdToken(r.idToken) : null;
      if (!r.refreshToken) return res.status(400).send('Google did not return a refresh token — retry the flow (it forces prompt=consent, so this is usually a mid-flow cancel).');
      const sysFrom = (process.env.SYSTEM_GMAIL_FROM || '').toLowerCase();
      const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const mismatch = sysFrom && grantedEmail && grantedEmail !== sysFrom
        ? `<p style="color:#b45309;background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:10px 14px;"><b>Heads up:</b> you authorized <b>${esc(grantedEmail)}</b>, but SYSTEM_GMAIL_FROM is <b>${esc(sysFrom)}</b>. Either redo this signed into ${esc(sysFrom)}, or also update SYSTEM_GMAIL_FROM to ${esc(grantedEmail)}.</p>`
        : '';
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font-family:system-ui;max-width:640px;margin:32px auto;padding:0 16px;color:#1a1a1a;">
  <h2 style="color:#ff0060;">System mailbox reconnected</h2>
  <p>Google granted <b>send + read (gmail.modify)</b> for <b>${esc(grantedEmail || 'the authorized account')}</b>. Finish with two steps:</p>
  <ol style="line-height:1.7;">
    <li>In <b>Vercel → Project → Settings → Environment Variables</b>, replace <code>SYSTEM_GMAIL_REFRESH_TOKEN</code> with the value below.</li>
    <li><b>Redeploy</b> (or push any commit) so the new value takes effect.</li>
  </ol>
  ${mismatch}
  <p style="margin-top:14px;"><b>New refresh token</b> (shown once — treat it like a password):</p>
  <textarea readonly onclick="this.select()" style="width:100%;height:90px;font-family:monospace;font-size:12px;padding:10px;border:1px solid #d1d5db;border-radius:8px;">${esc(r.refreshToken)}</textarea>
  <p style="color:#6b7280;font-size:13px;">Reply-by-email sync starts working on the next deploy after the env var is updated. This page stored nothing.</p>
</body>`);
    } catch (e: any) {
      console.error('[sysgmail callback] exchange failed:', e);
      return res.status(500).send('Token exchange failed — check the server logs and retry.');
    }
  }

  // ---------------------------------------------------------------
  // (A) LOGIN flow — the auth gate
  // ---------------------------------------------------------------
  if (isLoginFlow) {
    const fail = (reason: string) => res.redirect(302, `/login?error=${encodeURIComponent(reason)}`);

    if (req.query.error) return fail(String(req.query.error));
    if (!code || !state) return fail('google_missing_code');

    const expectedCsrf = cookies[LOGIN_STATE_COOKIE];
    // The native marker (if present) is appended as a trailing ".native".
    // Strip it FIRST so the csrf/email parse below is byte-for-byte identical to
    // the original (emails contain dots, so we must not split on them naively).
    let stateCore = state;
    let isNativeClient = false;
    if (stateCore.endsWith('.native')) {
      isNativeClient = true;
      stateCore = stateCore.slice(0, -'.native'.length);
    }
    const dot = stateCore.indexOf('.');
    const csrf = dot >= 0 ? stateCore.slice(0, dot) : stateCore;
    const claimedEmail = dot >= 0 ? decodeURIComponent(stateCore.slice(dot + 1)).toLowerCase() : '';
    if (!expectedCsrf || expectedCsrf !== csrf) return fail('google_state_mismatch');
    if (!claimedEmail) return fail('google_state_mismatch');

    // The code must be exchanged with the SAME OAuth client that issued it.
    // External logins start on the External app, so pick the client by the
    // claimed email's Workspace DOMAIN — must mirror google-login.ts exactly
    // (permission allowlisting does NOT change which OAuth app was used).
    const externalLogin = !isWorkspaceDomainEmail(claimedEmail);
    const loginCfg = getLoginOAuthConfig(externalLogin) || cfg;

    let verifiedEmail: string | null = null;
    let refreshToken: string | null = null;
    try {
      const r = await exchangeCodeForRefreshToken(loginCfg, code);
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
      const users = await fetchActiveUsers();
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
    const setCookies: string[] = [sessionCookie, clearCookie(LOGIN_STATE_COOKIE), clearReturnToCookie()];
    if (refreshToken) setCookies.push(gmailTokenCookie(refreshToken));
    res.setHeader('Set-Cookie', setCookies);

    // NATIVE return path (gated by the state marker): the session cookie just
    // set lands in the system BROWSER's cookie jar, which the app's webview
    // can't read on Android. Hand the app a short-TTL token via the resiwalk://
    // deep link; the app loads /api/auth/exchange?t=... in its own webview to
    // set the session cookie in the webview jar. Browser users never hit this.
    if (isNativeClient) {
      // Carry the Gmail refresh token (encrypted) through the exchange token so
      // the app webview gets the gmail cookie too — otherwise Gmail-send stays
      // "not connected" in the app even though the system-browser login granted
      // it. encryptToken matches what gmailTokenCookie stores, so the value on
      // the deep link is never a usable credential.
      const gmailEnc = refreshToken ? encryptToken(refreshToken) : undefined;
      const exchangeToken = await createOAuthExchangeToken({
        userId: match.id,
        email: match.email,
        name: match.fullName,
      }, gmailEnc);
      res.redirect(302, `resiwalk://auth-callback?t=${encodeURIComponent(exchangeToken)}`);
      return;
    }

    // Deep-link preservation: return to the originally-requested page if any.
    res.redirect(302, readReturnTo(req));
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
    res.redirect(302, `/app?gmail_error=${encodeURIComponent(String(req.query.error))}`);
    return;
  }
  if (!code || !state) {
    res.redirect(302, '/app?gmail_error=missing_code');
    return;
  }

  const expectedCsrf = cookies[CONNECT_STATE_COOKIE];
  const [csrf, finalizeAfter] = state.split('.');
  if (!expectedCsrf || expectedCsrf !== csrf) {
    res.redirect(302, '/app?gmail_error=state_mismatch');
    return;
  }

  try {
    const { refreshToken } = await exchangeCodeForRefreshToken(cfg, code);
    if (!refreshToken) {
      res.redirect(302, '/app?gmail_error=no_refresh_token');
      return;
    }
    res.setHeader('Set-Cookie', [
      gmailTokenCookie(refreshToken),
      clearCookie(CONNECT_STATE_COOKIE),
    ]);
    if (finalizeAfter) {
      res.redirect(302, `/inspection/${finalizeAfter}?finalizeNow=1`);
    } else {
      res.redirect(302, '/app?gmail_connected=1');
    }
  } catch (e: any) {
    console.error('[gmail callback] token exchange failed:', e);
    res.redirect(302, `/app?gmail_error=${encodeURIComponent('exchange_failed')}`);
  }
}
