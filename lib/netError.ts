/**
 * Is a thrown error a transient NETWORK/connectivity failure — the request never
 * completed — rather than a genuine server/app error (an HTTP 4xx/5xx, a bad
 * payload, a thrown app assertion)?
 *
 * `navigator.onLine` is unreliable: it reports the radio state, not whether
 * requests actually succeed, so it's commonly `true` on a weak or dead signal
 * that still fails every fetch. That's exactly how "Failed to fetch" / "Load
 * failed" load errors ended up in the Admin Error Log as genuine failures — the
 * caller only checked navigator.onLine and an /abort/ match. So we also match the
 * per-browser message a failed fetch() throws:
 *   Chrome / Blink : "Failed to fetch"
 *   Safari / WebKit: "Load failed"
 *   Firefox        : "NetworkError when attempting to fetch resource"
 *   iOS            : "The network connection was lost" / "…appears to be offline"
 * plus AbortError (our fetchWithTimeout aborts on timeout) and generic timeouts.
 *
 * Deliberately does NOT match "HTTP 4xx/5xx" or app payload errors — those are
 * real failures worth logging.
 */
export function isNetworkError(err: any): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return true;
  const msg = String(err?.message || err || '').toLowerCase();
  if (!msg) return false;
  return (
    /failed to fetch/.test(msg) ||
    /load failed/.test(msg) ||
    /networkerror/.test(msg) ||
    /network (request|connection)/.test(msg) ||
    /connection (was )?lost/.test(msg) ||
    /internet connection/.test(msg) ||
    /\baborted?\b/.test(msg) ||
    /timed out|timeout/.test(msg)
  );
}
