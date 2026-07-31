/**
 * resilientPost — retry a terminal write (submit / finalize) over weak signal.
 *
 * The field failure this fixes: at properties with poor reception (Covington,
 * Rex…) a SINGLE terminal POST often failed AFTER the server had already done the
 * work — the request landed and completed, but the response was lost on the flaky
 * link — so the inspector saw "Submit failed" even though it succeeded (and the
 * record then "vanished" into the Completed bucket). A manual retry then hit the
 * server's terminal-state guard (409) and also read as a failure.
 *
 * This retries the POST with backoff (network error / timeout / 5xx / 429, and an
 * optional 409 "in progress" lock), and hands the final Response back to the
 * caller so it can recognize a `409 { alreadyCompleted: true }` as SUCCESS. The
 * server-side in-flight + durable locks make these retries safe against duplicate
 * PDFs / emails / tickets.
 */

/** Thrown when the device is offline (so the caller can say "your work is saved"). */
export class OfflineError extends Error {
  constructor(message = 'offline') { super(message); this.name = 'OfflineError'; }
}

export interface ResilientPostOpts {
  /** Total attempts (default 3). */
  tries?: number;
  /** Per-attempt hard timeout in ms (default 90s) — a half-open connection can't hang the button forever. */
  timeoutMs?: number;
  /** Retry a 409 that is an "in progress" lock (NOT an already-completed 409, which is a success signal). Default false. */
  retry409?: boolean;
  /** Backoff before the next attempt (default 2.5s · (attempt+1)). */
  backoffMs?: (attempt: number) => number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

/**
 * POST JSON with retry. Returns the final Response for the caller to inspect
 * (a 2xx, or a non-retryable status like a 4xx / a `409 alreadyCompleted`).
 * Throws OfflineError if the device is offline, or the last network error if
 * every attempt failed to reach the server.
 */
export async function postJsonWithRetry(url: string, body: unknown, opts: ResilientPostOpts = {}): Promise<Response> {
  const tries = Math.max(1, opts.tries ?? 3);
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const backoff = opts.backoffMs ?? ((attempt: number) => 2_500 * (attempt + 1));
  const payload = JSON.stringify(body ?? {});
  let lastNetErr: unknown = null;

  for (let attempt = 0; attempt < tries; attempt++) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: ctrl.signal,
      });
    } catch (e) {
      // A genuine offline state won't recover by retrying now — surface it so the
      // caller can reassure the inspector their work is saved locally.
      if (isOffline()) throw new OfflineError();
      lastNetErr = e;
      if (attempt < tries - 1) { await sleep(backoff(attempt)); continue; }
      throw (lastNetErr instanceof Error ? lastNetErr : new Error(String(lastNetErr)));
    } finally {
      clearTimeout(to);
    }

    const s = res.status;
    if (s < 400) return res; // success

    if (s === 409 && opts.retry409) {
      // A terminal "already completed" 409 is a SUCCESS signal — hand it straight
      // back (never retry it). Only an "in progress" lock 409 is worth retrying.
      let alreadyCompleted = false;
      try { alreadyCompleted = !!((await res.clone().json())?.alreadyCompleted); } catch { /* non-JSON */ }
      if (alreadyCompleted) return res;
    } else if (!(s >= 500 || s === 429)) {
      // Non-retryable status (a 4xx incl. a 409 when retry409 is off) — the caller
      // decides what it means (e.g. an already-completed 409, a validation 400).
      return res;
    }

    // Transient (5xx / 429 / an in-progress 409): back off and retry, else hand
    // back the last response so the caller can surface the server's message.
    if (attempt < tries - 1) { await sleep(backoff(attempt)); continue; }
    return res;
  }
  // Unreachable (loop always returns or throws), but satisfies the type checker.
  throw new Error('postJsonWithRetry: exhausted without a response');
}
