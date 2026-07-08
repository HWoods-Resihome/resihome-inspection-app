/**
 * Lightweight, dependency-free client error reporting.
 *
 * Field inspectors hit issues we never see — a render crash, a silently-dropped
 * sync, an out-of-storage write. Today those only land in the device console.
 * This batches them to /api/telemetry/error (with enough context to diagnose:
 * route, online state, user agent, optional inspection id) so they show up in
 * the server logs and, if ERROR_WEBHOOK_URL is configured, an alerting channel.
 *
 * It is intentionally fire-and-forget and heavily throttled so it can never
 * make a bad situation worse (no error loops, no blocking the UI).
 */

export type ErrorContext = Record<string, string | number | boolean | undefined>;

const ENDPOINT = '/api/telemetry/error';
const MAX_PER_SESSION = 50;       // hard cap so a render-loop can't flood
const DEDUPE_WINDOW_MS = 10000;   // collapse identical errors within 10s

let sent = 0;
const recent = new Map<string, number>(); // signature -> last-sent ts
let installed = false;
// Extra context the app can attach (e.g. the open inspection id).
const ambient: ErrorContext = {};

export function setErrorContext(ctx: ErrorContext): void {
  Object.assign(ambient, ctx);
}

function shouldSend(signature: string): boolean {
  if (sent >= MAX_PER_SESSION) return false;
  const now = Date.now();
  const last = recent.get(signature);
  if (last && now - last < DEDUPE_WINDOW_MS) return false;
  recent.set(signature, now);
  return true;
}

/**
 * Non-actionable noise we must NOT report. These bury real field crashes in the
 * Admin Error Log and can never be acted on:
 *  - "Script error." — the opaque cross-origin window.onerror with no stack/detail.
 *  - GPU/WebView-internal terminations — Chromium recovers on its own; not our code.
 *  - the `_precache_shell_` sentinel — the SW cache-warmer's placeholder route,
 *    which by design has no inspection to load (see pages/_app.tsx warm()).
 */
function isNoise(message: string, context?: ErrorContext): boolean {
  if (/^\s*script error\.?\s*$/i.test(message)) return true;
  if (/GPU process (was )?(terminated|lost|crashed)|WebGL context/i.test(message)) return true;
  if (context && String((context as any).inspectionId || '') === '_precache_shell_') return true;
  return false;
}

/** Report a handled or unhandled error. Never throws. */
export function reportError(error: unknown, context?: ErrorContext): void {
  try {
    if (typeof window === 'undefined') return;
    const err = error as any;
    const message = String(err?.message || err || 'Unknown error');
    // Drop known non-actionable noise before it floods the Admin Error Log.
    if (isNoise(message, context)) return;
    const stack = typeof err?.stack === 'string' ? err.stack.slice(0, 4000) : undefined;
    const signature = `${message}::${(stack || '').split('\n')[1] || ''}`;
    if (!shouldSend(signature)) return;

    const payload = {
      message: message.slice(0, 1000),
      stack,
      name: err?.name ? String(err.name) : undefined,
      url: window.location?.href,
      online: typeof navigator !== 'undefined' ? navigator.onLine : undefined,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
      appVersion: process.env.NEXT_PUBLIC_APP_VERSION || undefined,
      ts: new Date().toISOString(),
      ...ambient,
      ...context,
    };

    const body = JSON.stringify(payload);
    // sendBeacon survives navigation/unload; fall back to a keepalive fetch.
    if (navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
    } else {
      void fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
    }
    sent++;
  } catch {
    /* reporting must never throw */
  }
}

/** Install global handlers for uncaught errors and unhandled promise rejections. */
export function initErrorReporting(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (e) => {
    // Ignore benign ResizeObserver noise that some browsers emit.
    if (/ResizeObserver loop/i.test(e?.message || '')) return;
    reportError(e?.error || e?.message, { kind: 'window.onerror' });
  });
  window.addEventListener('unhandledrejection', (e) => {
    reportError(e?.reason, { kind: 'unhandledrejection' });
  });
}
