/**
 * Firebase Cloud Messaging (FCM HTTP v1) sender — delivers push to the native
 * Capacitor app's device tokens. This is the server half of native push; the
 * native plugin (on chore/native-oauth-outbound) registers a device token and
 * POSTs it to /api/push/subscribe with platform:'native'.
 *
 * No firebase-admin dependency: we mint a Google OAuth2 access token from the
 * service account using `jose` (already a dependency) and call the FCM v1 REST
 * API directly — small and serverless-friendly.
 *
 * Inert until configured. Provide the service account as ONE env var:
 *   FCM_SERVICE_ACCOUNT_JSON = the full service-account JSON (from Firebase →
 *   Project settings → Service accounts → Generate new private key).
 */
import { SignJWT, importPKCS8 } from 'jose';

interface ServiceAccount { client_email: string; private_key: string; project_id: string; }

let _sa: ServiceAccount | null | undefined;        // undefined = not yet parsed
let _token: { value: string; exp: number } | null = null;

function serviceAccount(): ServiceAccount | null {
  if (_sa !== undefined) return _sa;
  const raw = process.env.FCM_SERVICE_ACCOUNT_JSON;
  if (!raw) { _sa = null; return null; }
  try {
    const j = JSON.parse(raw);
    if (j.client_email && j.private_key && j.project_id) {
      _sa = { client_email: j.client_email, private_key: j.private_key, project_id: j.project_id };
    } else {
      console.warn('[fcm] FCM_SERVICE_ACCOUNT_JSON missing client_email/private_key/project_id.');
      _sa = null;
    }
  } catch (e: any) {
    console.warn('[fcm] FCM_SERVICE_ACCOUNT_JSON is not valid JSON:', String(e?.message || e).slice(0, 120));
    _sa = null;
  }
  return _sa;
}

export function isFcmConfigured(): boolean {
  return !!serviceAccount();
}

/** Mint (and cache) a Google OAuth2 access token for FCM via the service account. */
async function accessToken(sa: ServiceAccount): Promise<string | null> {
  if (_token && Date.now() < _token.exp - 60_000) return _token.value;
  try {
    const now = Math.floor(Date.now() / 1000);
    const key = await importPKCS8(sa.private_key, 'RS256');
    const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/firebase.messaging' })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(sa.client_email)
      .setSubject(sa.client_email)
      .setAudience('https://oauth2.googleapis.com/token')
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(key);

    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data?.access_token) {
      console.warn('[fcm] token exchange failed:', resp.status, JSON.stringify(data).slice(0, 160));
      return null;
    }
    _token = { value: data.access_token, exp: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
    return _token.value;
  } catch (e: any) {
    console.warn('[fcm] token mint failed:', String(e?.message || e).slice(0, 160));
    return null;
  }
}

export interface FcmPayload { title: string; body: string; url?: string; tag?: string; }

/**
 * Send to one device token. Returns 'sent', 'expired' (token is dead — caller
 * should prune it), or 'error'. Never throws.
 */
export async function sendFcmToToken(token: string, payload: FcmPayload): Promise<'sent' | 'expired' | 'error'> {
  const sa = serviceAccount();
  if (!sa || !token) return 'error';
  const at = await accessToken(sa);
  if (!at) return 'error';

  const message = {
    message: {
      token,
      notification: { title: payload.title, body: payload.body },
      data: { url: payload.url || '/', ...(payload.tag ? { tag: payload.tag } : {}) },
      android: { priority: 'HIGH', notification: { default_sound: true } },
    },
  };

  try {
    const resp = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
    if (resp.ok) return 'sent';
    const err = await resp.json().catch(() => null);
    const status = err?.error?.status || err?.error?.details?.[0]?.errorCode;
    // UNREGISTERED / NOT_FOUND ⇒ the token is dead; tell the caller to prune it.
    if (resp.status === 404 || status === 'UNREGISTERED' || status === 'NOT_FOUND') return 'expired';
    console.warn('[fcm] send failed:', resp.status, JSON.stringify(err).slice(0, 160));
    return 'error';
  } catch (e: any) {
    console.warn('[fcm] send threw:', String(e?.message || e).slice(0, 120));
    return 'error';
  }
}
