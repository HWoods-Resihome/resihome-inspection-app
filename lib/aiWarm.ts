// Shared, session-level AI warm-up state.
//
// The voice assistant and the AI camera both need the server's cold-start work
// done before they feel instant: catalog embeddings loaded, the Voyage query
// path primed, and Anthropic's TLS + server-side prompt cache warmed. That work
// is kicked off by GET-ing the two warm-up endpoints.
//
// Previously each component fired its own warm-up on mount and gated its button
// until that round-trip returned — so even after the home screen warmed the
// server, opening an inspection still showed "getting ready…" while a redundant
// GET completed. This module hoists the warm state to a module-level singleton
// (which survives client-side route changes in the SPA) plus sessionStorage (so
// it survives a full reload within the tab). Components read `isAiWarm()` to
// enable their buttons immediately, and call `warmAi()` which de-dupes and only
// actually hits the network when cold or stale.

let warmedAt = 0;
let inflight: Promise<void> | null = null;

// Anthropic's prompt cache is short-lived (~5 min). Re-warm in the background if
// our last warm-up is older than this so a long dwell on the home screen doesn't
// leave the first real call paying a cold prefix — without ever blocking the UI.
const STALE_MS = 4 * 60 * 1000;

// Restore the timestamp across a full page reload in the same tab.
if (typeof window !== 'undefined') {
  try {
    const v = Number(window.sessionStorage.getItem('ai_warmed_at'));
    if (isFinite(v) && v > 0) warmedAt = v;
  } catch { /* sessionStorage blocked — fall back to in-memory only */ }
}

/** True once the AI endpoints have been warmed at least once this session. */
export function isAiWarm(): boolean {
  return warmedAt > 0;
}

/**
 * Warm the AI assistants. De-duped: concurrent callers share one in-flight
 * request, and a fresh warm-up (younger than STALE_MS) resolves immediately
 * without touching the network. Pass `force` to re-warm regardless of age.
 * Fire-and-forget safe — never throws.
 */
export function warmAi(force = false): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return Promise.resolve();
  }
  if (inflight) return inflight;
  if (!force && warmedAt && Date.now() - warmedAt < STALE_MS) return Promise.resolve();

  inflight = (async () => {
    await Promise.allSettled([
      fetch('/api/rate-card/voice-assist', { method: 'GET' }).catch(() => {}),
      fetch('/api/rate-card/room-scan-live', { method: 'GET' }).catch(() => {}),
    ]);
    warmedAt = Date.now();
    try { window.sessionStorage.setItem('ai_warmed_at', String(warmedAt)); } catch { /* noop */ }
  })().finally(() => { inflight = null; });

  return inflight;
}
