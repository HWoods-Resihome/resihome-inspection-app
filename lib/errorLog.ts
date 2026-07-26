/**
 * ResiWalk app error log.
 *
 * Field users hit failures we otherwise never see — a login that won't go
 * through, an inspection that "could not load", a write denied with "you can
 * only edit your own", a sync that silently drops. Those used to live only on
 * the device console (and, for client crashes, a single Vercel log line). This
 * gives them a durable, queryable home so the Admin ▸ ResiWalk Insights "Error
 * Log" can surface them in near real time with enough context to diagnose:
 * WHEN, WHO (email), WHAT (kind + message), the inspection TEMPLATE + id, and
 * the APP VERSION the user was on.
 *
 * Storage mirrors auditLog / ai-usage (no database): one append-only blob per
 * event under errorlog/<sortable-ts>-<rand>.json. The ms-prefixed name sorts
 * chronologically, so the reader can page newest-first by NAME without opening
 * every blob. The structured `[error-log]` console line is the authoritative
 * copy (greppable in Vercel). Best-effort: recording an error must NEVER throw
 * or block the request that produced it.
 */
import { put, list } from '@vercel/blob';

// Coarse buckets so the Admin log can filter/scan by failure area. Free-form
// strings are allowed too (forward-compatible), these are just the common ones.
export type ErrorKind =
  | 'login'            // sign-in failed (email not recognized, OAuth mismatch, verify failed)
  | 'inspection_load'  // opening an inspection failed (404 not found / 403 denied / load error)
  | 'inspection_start' // starting/creating a new inspection failed
  | 'write_denied'     // a write was rejected by the access guard (ownership / view-only / completed)
  | 'sync'             // a queued edit/photo failed to sync
  | 'client'           // uncaught client crash / unhandled rejection
  | 'server';          // an API route returned 5xx

export interface ErrorEvent {
  ts: string;               // ISO datetime
  kind: ErrorKind | string;
  message: string;          // human-readable issue
  email?: string;           // signed-in user (server-attributed when possible)
  inspectionId?: string;
  template?: string;        // inspection template type, when known
  status?: string;          // inspection status, when known
  appVersion?: string;      // NEXT_PUBLIC_APP_VERSION the client was running
  url?: string;             // route the user was on
  online?: boolean;
  userAgent?: string;
  source?: 'client' | 'server';
  meta?: Record<string, string | number | boolean | null | undefined>;
}

const PREFIX = 'errorlog/';

// Per-instance dedup for the BLOB write only. Field reality floods the log with
// identical events: a background sync retrying a write the guard denies (a
// completed/foreign inspection) re-fires a `write_denied` every tick; a burst of
// 429 backpressure surfaces the same "too many requests" over and over. Dozens of
// byte-identical rows bury the real crashes the triage is meant to surface. So we
// collapse an identical signature (kind + email + inspectionId + message) to at
// most one blob per window. The authoritative structured console line is STILL
// emitted every time (nothing is hidden from Vercel/grep) — only the Admin Error
// Log's durable copy is deduped. Per-instance (like every other limiter here); a
// flood hits a warm instance, which is exactly when dedup matters most.
const DEDUPE_WINDOW_MS = Math.max(60_000, Number(process.env.ERROR_LOG_DEDUPE_MS) || 10 * 60_000);
const lastLoggedAt = new Map<string, number>();

function shouldPersist(signature: string): boolean {
  const now = Date.now();
  const prev = lastLoggedAt.get(signature);
  if (prev != null && now - prev < DEDUPE_WINDOW_MS) return false;
  lastLoggedAt.set(signature, now);
  // Bound the map so a long-lived instance seeing many distinct signatures can't
  // grow it without limit — evict entries already past the window.
  if (lastLoggedAt.size > 5000) {
    for (const [k, t] of lastLoggedAt) if (now - t >= DEDUPE_WINDOW_MS) lastLoggedAt.delete(k);
  }
  return true;
}

function clip(s: unknown, n = 500): string | undefined {
  if (s == null || s === '') return undefined;
  return String(s).slice(0, n);
}

// Known NON-ACTIONABLE noise (browser-extension / Outlook-injected rejections,
// opaque cross-origin "Script error.", GPU resets, benign Next hard-nav). The
// client reporter drops these before sending, but entries recorded BEFORE that
// filter shipped still sit in the blob log — so we also drop them on READ, which
// keeps the Admin Error Log and triage clean without a purge. Message-based.
const NOISE_PATTERNS: RegExp[] = [
  /Object Not Found Matching Id.*MethodName/i,
  /^\s*script error\.?\s*$/i,
  /GPU process (was )?(terminated|lost|crashed)|WebGL context/i,
  /attempted to hard navigate to the same URL/i,
  /ResizeObserver loop/i,
];
export function isNoiseErrorMessage(message?: string | null): boolean {
  const m = String(message || '');
  return NOISE_PATTERNS.some((re) => re.test(m));
}

/**
 * Record one error event. Best-effort; never throws. Safe to call from any API
 * route or telemetry sink. No-op (log line only) when blob storage isn't
 * configured.
 */
export async function recordErrorEvent(e: Partial<ErrorEvent> & { kind: ErrorKind | string; message: string }): Promise<void> {
  const ev: ErrorEvent = {
    ts: new Date().toISOString(),
    kind: e.kind,
    message: clip(e.message, 1000) || 'Unknown error',
    email: clip(e.email, 200),
    inspectionId: clip(e.inspectionId, 100),
    template: clip(e.template, 100),
    status: clip(e.status, 60),
    appVersion: clip(e.appVersion, 40),
    url: clip(e.url, 500),
    online: typeof e.online === 'boolean' ? e.online : undefined,
    userAgent: clip(e.userAgent, 400),
    source: e.source,
    meta: e.meta,
  };

  // 1) Structured log — authoritative, greppable in Vercel logs. ALWAYS emitted,
  //    even for a deduped repeat, so nothing is ever hidden from the Vercel logs.
  try { console.error(`[error-log] ${JSON.stringify(ev)}`); } catch { /* noop */ }

  // 2) Best-effort blob (append-only; ms-prefixed name sorts chronologically).
  //    Deduped: an identical signature within the window is already on record, so
  //    skip the write instead of flooding the Admin Error Log with copies.
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;
  const signature = `${ev.kind}|${ev.email || ''}|${ev.inspectionId || ''}|${ev.message}`;
  if (!shouldPersist(signature)) return;
  const name = `${Date.now().toString().padStart(15, '0')}-${Math.random().toString(36).slice(2, 7)}`;
  try {
    await put(`${PREFIX}${name}.json`, JSON.stringify(ev),
      { access: 'public', contentType: 'application/json', allowOverwrite: true, addRandomSuffix: false });
  } catch (err: any) {
    console.warn('[error-log] write failed:', String(err?.message || err).slice(0, 120));
  }
}

/**
 * Read the most recent error events, newest first. Bounded by `limit` — we sort
 * blob NAMES (ms-prefixed, so name order == time order) BEFORE fetching, then
 * open only the newest `limit` blobs, so the admin read stays cheap even as the
 * log grows.
 */
export async function readErrorLog(limit = 200): Promise<ErrorEvent[]> {
  const out: ErrorEvent[] = [];
  if (!process.env.BLOB_READ_WRITE_TOKEN) return out;
  try {
    // Page the blob index (list returns up to 1000/page) and keep the newest by
    // name. For the volumes an app error log sees, one or two pages is plenty.
    const seen: { pathname: string; url: string }[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix: PREFIX, cursor, limit: 1000 });
      for (const b of page.blobs) seen.push({ pathname: b.pathname, url: b.url });
      cursor = page.hasMore ? page.cursor : undefined;
      // Guard against an unbounded scan — the newest events sort last by name, so
      // once we hold well more than `limit` we can stop paging.
    } while (cursor && seen.length < Math.max(limit * 5, 1000));

    seen.sort((a, b) => (a.pathname < b.pathname ? 1 : a.pathname > b.pathname ? -1 : 0)); // newest first
    const top = seen.slice(0, limit);
    const events = await Promise.all(top.map((b) => fetch(b.url).then((r) => r.json()).catch(() => null)));
    for (const ev of events) if (ev && !isNoiseErrorMessage((ev as ErrorEvent).message)) out.push(ev as ErrorEvent);
  } catch (e: any) {
    console.warn('[error-log] read failed:', String(e?.message || e).slice(0, 120));
  }
  out.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)); // newest first
  return out.slice(0, limit);
}
