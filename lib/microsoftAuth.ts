// lib/microsoftAuth.ts
//
// Microsoft / Outlook sign-in for users (notably 1099 external agents who have
// Outlook accounts, not Google). Mirrors the Google login proof flow: the user
// types a HubSpot-validated email, then proves they control it by signing in
// with Microsoft; the callback verifies the Microsoft account's email matches
// the claimed email and mints the SAME session as the Google path.
//
// Identity-only (scope: openid email profile) — no Graph/mail access.
// Configure in Vercel env (NEVER hard-code the secret):
//   MS_CLIENT_ID, MS_CLIENT_SECRET  (the secret VALUE, not the Secret ID),
//   MS_REDIRECT_URI (default https://resiwalk.com/api/auth/microsoft/callback),
//   MS_TENANT (default "common" — allows any org + personal Microsoft accounts).

export interface MicrosoftOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tenant: string;
}

export const MS_IDENTITY_SCOPES = 'openid email profile';

export function getMicrosoftOAuthConfig(): MicrosoftOAuthConfig | null {
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const redirectUri = process.env.MS_REDIRECT_URI
    || `${process.env.NEXT_PUBLIC_APP_ORIGIN || 'https://resiwalk.com'}/api/auth/microsoft/callback`;
  const tenant = (process.env.MS_TENANT || 'common').trim();
  return { clientId, clientSecret, redirectUri, tenant };
}

function authority(tenant: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0`;
}

/** Build the Microsoft authorize URL. `state` carries CSRF + claimed email. */
export function buildMicrosoftConsentUrl(cfg: MicrosoftOAuthConfig, opts: { state: string; loginHint?: string }): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    redirect_uri: cfg.redirectUri,
    response_mode: 'query',
    scope: MS_IDENTITY_SCOPES,
    state: opts.state,
  });
  if (opts.loginHint) params.set('login_hint', opts.loginHint);
  return `${authority(cfg.tenant)}/authorize?${params.toString()}`;
}

/** Exchange an authorization code for tokens; returns the id_token. */
export async function exchangeMicrosoftCode(cfg: MicrosoftOAuthConfig, code: string): Promise<{ idToken: string | null }> {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code,
    redirect_uri: cfg.redirectUri,
    grant_type: 'authorization_code',
    scope: MS_IDENTITY_SCOPES,
  });
  const r = await fetch(`${authority(cfg.tenant)}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`MS token exchange failed (${r.status}): ${t.slice(0, 200)}`);
  }
  const data = await r.json();
  return { idToken: data?.id_token || null };
}

/** Pull the email from a Microsoft id_token. Prefers `email`, falls back to
 *  `preferred_username` / `upn` (which are the account's email for most users).
 *  Decode only (no verify) — the token came straight from MS's token endpoint
 *  over TLS using our client secret, same as the Google path. */
export function emailFromMicrosoftIdToken(idToken: string): string | null {
  try {
    const payload = idToken.split('.')[1];
    if (!payload) return null;
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const claims = JSON.parse(json);
    const raw = claims.email || claims.preferred_username || claims.upn || '';
    const email = String(raw).trim().toLowerCase();
    return email.includes('@') ? email : null;
  } catch {
    return null;
  }
}
