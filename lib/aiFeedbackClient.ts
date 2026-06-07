/**
 * Client side of the AI feedback flywheel — fire-and-forget reporting of how a
 * human responded to an AI suggestion (approve / decline / edit / move / …).
 *
 * Mirrors clientErrorReporter: heavily defensive, never throws, never blocks the
 * UI, and prefers sendBeacon so a signal survives the inspector navigating away
 * right after tapping "Apply". The server (recordAiFeedback) persists it.
 */
import type { AiFeedbackEvent } from './aiFeedback';

export type { AiFeedbackEvent };

const ENDPOINT = '/api/ai/feedback';

function appVersion(): string | undefined {
  return process.env.NEXT_PUBLIC_APP_VERSION || undefined;
}

/** Report one or more AI feedback events. Best-effort; never throws. */
export function sendAiFeedback(events: AiFeedbackEvent | AiFeedbackEvent[]): void {
  try {
    if (typeof window === 'undefined') return;
    const list = (Array.isArray(events) ? events : [events])
      .filter(Boolean)
      .slice(0, 100) // hard cap so a loop can't flood
      .map((e) => ({ appVersion: appVersion(), ts: new Date().toISOString(), ...e }));
    if (!list.length) return;

    const body = JSON.stringify({ events: list });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
    } else {
      void fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {});
    }
  } catch {
    /* feedback must never break the app */
  }
}
