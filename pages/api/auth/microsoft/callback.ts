// Microsoft / Outlook OAuth callback — the auth gate (Microsoft equivalent of
// the LOGIN flow in gmail/callback.ts). Verifies the Microsoft account's email
// matches the claimed (HubSpot-validated) email, then mints the SAME 30-day
// session the Google path mints. No mail scopes are involved.

import type { NextApiRequest, NextApiResponse } from 'next';
import { createSessionCookie, createOAuthExchangeToken, readReturnTo, clearReturnToCookie } from '@/lib/auth';
import { getMicrosoftOAuthConfig, exchangeMicrosoftCode, emailFromMicrosoftIdToken } from '@/lib/microsoftAuth';
import { fetchActiveUsers } from '@/lib/hubspot';
import { parse, serialize } from 'cookie';

const STATE_COOKIE = 'resihome_mslogin_oauth_state';

function clearCookie(name: string): string {
  return serialize(name, '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 0 });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const fail = (reason: string) => res.redirect(302, `/login?error=${encodeURIComponent(reason)}`);

  const cfg = getMicrosoftOAuthConfig();
  if (!cfg) return fail('microsoft_not_configured');

  const cookies = parse(req.headers.cookie || '');
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';

  if (req.query.error) return fail(String(req.query.error));
  if (!code || !state) return fail('microsoft_missing_code');

  const expectedCsrf = cookies[STATE_COOKIE];
  // Strip the optional trailing ".native" FIRST, then split csrf off the front
  // (emails contain dots) — identical to the Google callback.
  let stateCore = state;
  let isNativeClient = false;
  if (stateCore.endsWith('.native')) { isNativeClient = true; stateCore = stateCore.slice(0, -'.native'.length); }
  const dot = stateCore.indexOf('.');
  const csrf = dot >= 0 ? stateCore.slice(0, dot) : stateCore;
  const claimedEmail = dot >= 0 ? decodeURIComponent(stateCore.slice(dot + 1)).toLowerCase() : '';
  if (!expectedCsrf || expectedCsrf !== csrf) return fail('microsoft_state_mismatch');
  if (!claimedEmail) return fail('microsoft_state_mismatch');

  let verifiedEmail: string | null = null;
  try {
    const { idToken } = await exchangeMicrosoftCode(cfg, code);
    verifiedEmail = idToken ? emailFromMicrosoftIdToken(idToken) : null;
  } catch (e) {
    console.error('[microsoft callback] token exchange failed:', e);
    return fail('microsoft_exchange_failed');
  }
  if (!verifiedEmail) return fail('microsoft_no_identity');

  // SECURITY: the Microsoft account must be the email the user claimed (and that
  // we HubSpot-validated). This is the whole point of the proof.
  if (verifiedEmail !== claimedEmail) {
    console.warn(`[microsoft callback] email mismatch: claimed=${claimedEmail} ms=${verifiedEmail}`);
    return fail('microsoft_email_mismatch');
  }

  // Re-confirm it's still an active HubSpot user; mint against the canonical record.
  let match;
  try {
    const users = await fetchActiveUsers();
    match = users.find((u) => u.email.toLowerCase() === verifiedEmail);
  } catch (e) {
    console.error('[microsoft callback] HubSpot user check failed:', e);
    return fail('verify_failed');
  }
  if (!match) return fail('not_recognized');

  const sessionUser = { userId: match.id, email: match.email, name: match.fullName };
  res.setHeader('Set-Cookie', [await createSessionCookie(sessionUser), clearCookie(STATE_COOKIE), clearReturnToCookie()]);

  // Native (Capacitor) return: hand the app a short-TTL token via the deep link
  // so it can set the session cookie in its OWN webview jar (same as Google).
  if (isNativeClient) {
    const exchangeToken = await createOAuthExchangeToken(sessionUser);
    res.redirect(302, `resiwalk://auth-callback?t=${encodeURIComponent(exchangeToken)}`);
    return;
  }
  // Deep-link preservation: return to the originally-requested page if any.
  res.redirect(302, readReturnTo(req));
}
