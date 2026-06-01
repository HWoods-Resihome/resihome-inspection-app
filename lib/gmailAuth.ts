// Gmail OAuth token storage + crypto. SERVER-ONLY.
//
// Storage model (per Hayden's choice): the user's Gmail refresh token is
// encrypted and kept in an HTTP-only cookie. No external store. The token is
// scoped to the logged-in @resihome.com user's Google account, so emails send
// from *their* address. Re-authorization is required once per device/browser
// (or if they clear cookies), which is fine for an internal tool.
//
// Crypto: AES-256-GCM with a key derived from SESSION_SECRET (already required
// to be >= 32 chars). The refresh token never leaves the server in plaintext.

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';
import { serialize, parse } from 'cookie';
import type { NextApiRequest } from 'next';

export const GMAIL_TOKEN_COOKIE = 'resihome_gmail_token';
// Refresh tokens are long-lived; keep the cookie for 90 days. Google refresh
// tokens for Internal Workspace apps don't expire unless revoked, so the
// limiting factor is the cookie lifetime.
const COOKIE_MAX_AGE_DAYS = 90;

function encryptionKey(): Buffer {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error('SESSION_SECRET env var is missing or shorter than 32 chars');
  }
  // Derive a fixed 32-byte key from the secret (SESSION_SECRET may be longer)
  return createHash('sha256').update(s).digest();
}

/** Encrypt a refresh token into a compact base64 string: iv:tag:ciphertext */
export function encryptToken(plaintext: string): string {
  const iv = randomBytes(12); // GCM standard nonce size
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/** Decrypt a token produced by encryptToken. Returns null on any failure. */
export function decryptToken(encoded: string): string | null {
  try {
    const [ivB64, tagB64, ctB64] = encoded.split(':');
    if (!ivB64 || !tagB64 || !ctB64) return null;
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
    return plaintext.toString('utf8');
  } catch {
    return null;
  }
}

/** Build the Set-Cookie header value storing an encrypted refresh token. */
export function gmailTokenCookie(refreshToken: string): string {
  return serialize(GMAIL_TOKEN_COOKIE, encryptToken(refreshToken), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE_DAYS * 24 * 60 * 60,
  });
}

/** Clear the Gmail token cookie (disconnect). */
export function clearGmailTokenCookie(): string {
  return serialize(GMAIL_TOKEN_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

/** Read + decrypt the refresh token from the request cookies. Null if absent. */
export function getGmailRefreshToken(req: NextApiRequest): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  const cookies = parse(cookieHeader);
  const enc = cookies[GMAIL_TOKEN_COOKIE];
  if (!enc) return null;
  return decryptToken(enc);
}

// ---- OAuth config ----

export interface GmailOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Read OAuth config from env. Returns null if not fully configured. */
export function getGmailOAuthConfig(): GmailOAuthConfig | null {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const redirectUri = process.env.GMAIL_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
// Identity scopes — let us read which Google account actually authenticated so
// we can verify it matches the email the user typed on the login page.
export const IDENTITY_SCOPES = 'openid email';
// Full scope set requested at login: prove identity (everyone) + Gmail send
// (granted by internal users; external users simply won't use it).
export const LOGIN_SCOPES = `${IDENTITY_SCOPES} ${GMAIL_SEND_SCOPE}`;

/**
 * Build the Google OAuth consent URL.
 *   - access_type=offline   -> we get a refresh token
 *   - prompt=consent        -> forces refresh token issuance even on re-auth
 *   - login_hint            -> pre-fill the user's email on the consent screen
 *   - state                 -> opaque value we round-trip (carries CSRF token +
 *                              optional "finalize after" inspection id)
 *   - scope                 -> defaults to Gmail-send only (post-login connect);
 *                              login flow passes LOGIN_SCOPES to also verify id.
 */
export function buildGmailConsentUrl(cfg: GmailOAuthConfig, opts: {
  state: string;
  loginHint?: string;
  scope?: string;
  includeHd?: boolean;
  // OAuth prompt behavior. Default 'consent' (forces a refresh token). Pass
  // 'select_account' for returning logins that already hold a refresh token, so
  // Google doesn't re-show the consent screen on every sign-in.
  prompt?: 'consent' | 'select_account' | 'none';
}): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: opts.scope || GMAIL_SEND_SCOPE,
    access_type: 'offline',
    prompt: opts.prompt || 'consent',
    state: opts.state,
  });
  // Workspace-domain hint is helpful for internal users but would block valid
  // external Google accounts, so only set it when explicitly requested.
  if (opts.includeHd) params.set('hd', 'resihome.com');
  if (opts.loginHint) params.set('login_hint', opts.loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/** Decode the email claim from a Google id_token (JWT). No signature check is
 *  needed here because the token came directly from Google's token endpoint
 *  over TLS in response to our own client_secret-authenticated request. */
export function emailFromIdToken(idToken: string): string | null {
  try {
    const payload = idToken.split('.')[1];
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (json.email_verified === false) return null;
    return typeof json.email === 'string' ? json.email.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Exchange an authorization code for tokens. Returns the refresh token. */
export async function exchangeCodeForRefreshToken(
  cfg: GmailOAuthConfig,
  code: string
): Promise<{ refreshToken: string | null; accessToken: string; expiresIn: number; idToken: string | null }> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  return {
    refreshToken: json.refresh_token || null,
    accessToken: json.access_token,
    expiresIn: json.expires_in,
    idToken: json.id_token || null,
  };
}

/** Trade a refresh token for a fresh short-lived access token. */
export async function refreshAccessToken(
  cfg: GmailOAuthConfig,
  refreshToken: string
): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: 'refresh_token',
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Access token refresh failed ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  return json.access_token;
}
