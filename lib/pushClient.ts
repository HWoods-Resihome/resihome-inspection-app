/**
 * Client side of Web Push — request permission, subscribe through the service
 * worker, and register the subscription with the server so the user can receive
 * approval alerts. Defensive and dependency-free; never throws.
 *
 * Inert when NEXT_PUBLIC_VAPID_PUBLIC_KEY isn't configured (push not set up) or
 * the browser lacks support (e.g. iOS Safari before 16.4, or before the PWA is
 * added to the home screen).
 */

const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || '';
const ASKED_KEY = 'resiwalk_push_prompted_v1';

export function isPushSupported(): boolean {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window
    && !!VAPID_PUBLIC;
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function postSubscription(sub: PushSubscription): Promise<void> {
  await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'web', subscription: sub.toJSON() }),
  }).catch(() => {});
}

/**
 * Subscribe (idempotent) and register with the server. Assumes permission is
 * already granted — call only when Notification.permission === 'granted'.
 */
export async function ensurePushSubscription(): Promise<boolean> {
  try {
    if (!isPushSupported() || Notification.permission !== 'granted') return false;
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC),
      });
    }
    await postSubscription(sub);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prompt the user for notification permission (once), then subscribe. Returns
 * true if subscribed. Re-running after a grant is a no-op refresh.
 */
export async function requestAndSubscribe(): Promise<boolean> {
  try {
    if (!isPushSupported()) return false;
    if (Notification.permission === 'denied') return false;
    if (Notification.permission === 'default') {
      const result = await Notification.requestPermission();
      if (result !== 'granted') return false;
    }
    return await ensurePushSubscription();
  } catch {
    return false;
  }
}

async function isAuthenticated(): Promise<boolean> {
  try {
    const r = await fetch('/api/auth/me');
    if (!r.ok) return false;
    const data = await r.json();
    return !!data?.authenticated;
  } catch { return false; }
}

/**
 * App-load entry point (prompt-on-load opt-in): if already granted, silently
 * refresh the subscription; otherwise prompt exactly once per browser so we
 * don't nag on every load. Only acts for a signed-in user (the prompt is
 * irrelevant on the login screen, and subscribing requires a session). Call
 * after the service worker is registered.
 */
export async function initPushOnLoad(): Promise<void> {
  try {
    if (!isPushSupported()) return;
    if (Notification.permission === 'denied') return;
    // Already granted → refresh silently (no auth gate needed; subscribe POST
    // simply no-ops server-side if the session is gone).
    if (Notification.permission === 'granted') { await ensurePushSubscription(); return; }
    // permission 'default' — only prompt a signed-in user, once per browser.
    if (localStorage.getItem(ASKED_KEY)) return;
    if (!(await isAuthenticated())) return;
    localStorage.setItem(ASKED_KEY, '1');
    await requestAndSubscribe();
  } catch { /* never block app load */ }
}

/** Turn alerts off on this device (best-effort). */
export async function disablePush(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await fetch('/api/push/unsubscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
  } catch { /* noop */ }
}
