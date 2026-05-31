/**
 * Session-expiry guard.
 *
 * The session is a 30-day JWT cookie. If it lapses while an inspector is in the
 * field, API calls start returning 401. Two problems that this guards against:
 *   1. The inspector keeps "working" but nothing actually saves.
 *   2. A 401 is a 4xx, and the offline outbox drops permanent 4xx entries — so
 *      a stale session could silently DISCARD queued changes. (flushOutbox is
 *      separately patched to keep 401/403 entries instead of dropping them.)
 *
 * We wrap fetch to notice same-origin /api 401s and dispatch a one-shot
 * `resihome:session-expired` event. The UI listens and prompts a re-login,
 * reassuring the inspector that their queued work is safe and will sync.
 */

export const SESSION_EXPIRED_EVENT = 'resihome:session-expired';

let installed = false;
let notified = false;

export function installSessionGuard(): void {
  if (installed || typeof window === 'undefined' || !window.fetch) return;
  installed = true;

  const orig = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await orig(input, init);
    try {
      if (res.status === 401 && isSameOriginApi(input)) {
        notifyExpired();
      }
    } catch {/* never break the real request */}
    return res;
  };
}

function isSameOriginApi(input: RequestInfo | URL): boolean {
  try {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    const u = new URL(url, window.location.origin);
    if (u.origin !== window.location.origin) return false;
    // The auth endpoints legitimately return 401 (e.g. a bad login) — ignore.
    if (u.pathname.startsWith('/api/auth/')) return false;
    return u.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

function notifyExpired(): void {
  if (notified) return; // one prompt is enough
  notified = true;
  window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
}
