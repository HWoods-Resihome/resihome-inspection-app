// Native OAuth return — token exchange endpoint.
//
// ONLY used by the Capacitor app on Android (and any platform where the system
// browser's cookie jar is isolated from the app webview). Flow:
//
//   system browser → /api/auth/gmail/callback (mints session + a short-TTL
//     exchange token) → 302 resiwalk://auth-callback?t=<token>
//   → OS hands the deep link to the app → app loads THIS endpoint in its OWN
//     webview: GET /api/auth/exchange?t=<token>
//   → we validate the token and set the SAME resihome_session cookie the normal
//     login sets, now in the webview's cookie jar → 302 to /
//
// This is NOT a general auth bypass:
//   - The token is a jose HS256 JWT signed with SESSION_SECRET, typ:'oauth_exchange',
//     TTL <=60s, carrying only the identity the user just proved via Google.
//   - Invalid/expired/wrong-type → 302 /login with NO session set.
//   - It mints exactly the same session createSessionCookie would; it cannot
//     grant more than a normal login.
//
// Public route (added to middleware PUBLIC_PATHS): it must be reachable before a
// session exists, like the other auth callbacks.

import type { NextApiRequest, NextApiResponse } from 'next';
import { verifyOAuthExchangeToken, createSessionCookie } from '@/lib/auth';
import { decryptToken, gmailTokenCookie } from '@/lib/gmailAuth';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const token = typeof req.query.t === 'string' ? req.query.t : '';
  if (!token) {
    res.redirect(302, '/login?error=exchange_missing_token');
    return;
  }

  const result = await verifyOAuthExchangeToken(token);
  if (!result) {
    // Expired (>60s), tampered, or not an exchange token. No session is set.
    res.redirect(302, '/login?error=exchange_invalid');
    return;
  }

  // Mint the SAME session cookie the normal browser flow sets — same name,
  // attributes, and 30-day lifetime — but now in the app webview's cookie jar.
  const { gmailEnc, ...user } = result;
  const cookies: string[] = [await createSessionCookie(user)];

  // If the login carried a Gmail refresh token, set the gmail cookie here too so
  // Gmail-send is connected in the webview jar (not just the system browser's).
  if (gmailEnc) {
    const refreshToken = decryptToken(gmailEnc);
    if (refreshToken) cookies.push(gmailTokenCookie(refreshToken));
  }

  res.setHeader('Set-Cookie', cookies);
  res.redirect(302, '/app');
}
