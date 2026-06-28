/**
 * Server-side error reporting — SERVER-ONLY.
 *
 * Server exceptions (finalize, PDF render, HubSpot calls, uploads) were only
 * `console.error`'d, so they were invisible unless someone read the Vercel logs.
 * This funnels them into ONE structured channel:
 *   • always a greppable structured log line ([server-error] {json}), and
 *   • if ERROR_WEBHOOK_URL is set, a fire-and-forget POST to that collector
 *     (Slack incoming-webhook, a Sentry tunnel, Datadog, any HTTP sink) — the
 *     SAME env var the client telemetry endpoint already uses, so wiring a
 *     collector lights up both client and server reporting at once.
 *
 * Design rules (telemetry must never break the app):
 *   • never throws — every path is wrapped/swallowed,
 *   • fire-and-forget — never holds the request on a slow collector,
 *   • deduped + rate-limited per-instance so a hot error loop can't spam the
 *     webhook (the structured log still records every occurrence).
 */

interface ServerErrorContext {
  route?: string;          // e.g. "POST /api/inspections/[id]/finalize"
  method?: string;
  userEmail?: string;
  inspectionId?: string;
  phase?: string;          // pipeline stage, when known (e.g. "persisting-status")
  extra?: Record<string, unknown>;
}

// Per-instance dedupe: collapse a repeating error (same route+message) to at
// most one webhook post per window. The structured console line is ALWAYS
// emitted (so nothing is hidden); only the outbound alert is throttled.
const ALERT_WINDOW_MS = 60_000;
const lastAlertAt = new Map<string, number>();

function shouldAlert(key: string): boolean {
  const now = Date.now();
  const prev = lastAlertAt.get(key) || 0;
  if (now - prev < ALERT_WINDOW_MS) return false;
  lastAlertAt.set(key, now);
  // Bound the map so it can't grow unbounded across many distinct errors.
  if (lastAlertAt.size > 2000) {
    for (const [k, t] of lastAlertAt) if (now - t >= ALERT_WINDOW_MS) lastAlertAt.delete(k);
  }
  return true;
}

/**
 * Report a server-side error. Best-effort and synchronous-safe — call it from a
 * catch block and keep going (it never throws and never awaits the collector).
 */
export function reportServerError(error: unknown, context: ServerErrorContext = {}): void {
  try {
    const err = error as any;
    const message = String(err?.message || err || 'Unknown error').slice(0, 500);
    const record = {
      level: 'error',
      source: 'server',
      message,
      stack: typeof err?.stack === 'string' ? err.stack.slice(0, 2000) : undefined,
      status: typeof err?.status === 'number' ? err.status : undefined,
      route: context.route,
      method: context.method,
      userEmail: context.userEmail,
      inspectionId: context.inspectionId,
      phase: context.phase,
      extra: context.extra,
      at: new Date().toISOString(),
    };

    // Always emit the structured line — greppable in Vercel/CloudWatch.
    try { console.error('[server-error]', JSON.stringify(record)); } catch { /* noop */ }

    const webhook = process.env.ERROR_WEBHOOK_URL;
    if (!webhook) return;
    const dedupeKey = `${record.route || ''}|${message}`;
    if (!shouldAlert(dedupeKey)) return;

    void fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `text` is what a Slack incoming-webhook renders; the full record rides
      // alongside for richer collectors that read JSON.
      body: JSON.stringify({
        text: `🚨 ResiWALK server error: ${record.route || 'unknown route'} — ${message}`,
        ...record,
      }),
    }).catch(() => { /* collector down — the structured log still has it */ });
  } catch {
    /* telemetry must never throw */
  }
}
