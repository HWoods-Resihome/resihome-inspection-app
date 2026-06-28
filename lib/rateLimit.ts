/**
 * Lightweight per-instance rate limiter — SERVER-ONLY.
 *
 * Generalizes the token-bucket already used by pages/api/photo-proxy.ts so the
 * authenticated mutation routes (save answers, rate-card lines, upload, submit,
 * finalize, create) can blunt a runaway/abusive client before it hammers the
 * HubSpot API into 429s.
 *
 * SCOPE / HONEST LIMITATION: this is PER serverless instance, not global. Vercel
 * spreads requests across ephemeral instances, so the effective cap is roughly
 * (configured max × instance count). That's deliberate: it needs no external
 * store (Vercel KV / Upstash / Redis) or new secret, and it still stops a single
 * client looping against one instance — the realistic abuse/runaway case. For a
 * hard global cap, back this with KV (the call sites wouldn't change).
 *
 * Keyed by caller identity (session email) + a route tag, so one noisy user/route
 * can't starve others.
 */

interface Bucket { count: number; windowStart: number }

const buckets = new Map<string, Bucket>();

export interface RateLimitOptions {
  /** Stable identity for the caller — typically the session email. */
  key: string;
  /** Route tag so different routes have independent budgets. */
  route: string;
  /** Max requests allowed per window. */
  max: number;
  /** Window length in ms (default 60s). */
  windowMs?: number;
}

export interface RateLimitResult {
  limited: boolean;
  retryAfterSec: number;
}

/**
 * Record one hit and report whether the caller is over the limit. Pure counter —
 * does not touch req/res (so it's trivially testable). Never throws.
 */
export function checkRateLimit(opts: RateLimitOptions): RateLimitResult {
  const windowMs = opts.windowMs ?? 60_000;
  const k = `${opts.route}|${opts.key}`;
  const now = Date.now();
  const cur = buckets.get(k);
  if (!cur || now - cur.windowStart >= windowMs) {
    buckets.set(k, { count: 1, windowStart: now });
  } else if (cur.count >= opts.max) {
    const retryAfterSec = Math.max(1, Math.ceil((cur.windowStart + windowMs - now) / 1000));
    return { limited: true, retryAfterSec };
  } else {
    cur.count++;
  }
  // Bound the map so it can't grow unbounded across many keys.
  if (buckets.size > 10_000) {
    for (const [key, b] of buckets) if (now - b.windowStart >= windowMs) buckets.delete(key);
  }
  return { limited: false, retryAfterSec: 0 };
}

/**
 * Convenience wrapper for API routes: if the caller is over the limit, sets
 * Retry-After + sends a 429 and returns true (the handler should `return`).
 * Otherwise returns false and the handler proceeds. Never throws — on any
 * internal error it fails OPEN (allows the request) so the limiter can't take
 * the route down.
 */
export function enforceRateLimit(
  res: { setHeader: (k: string, v: string) => void; status: (c: number) => { json: (b: any) => any } },
  opts: RateLimitOptions,
): boolean {
  try {
    const r = checkRateLimit(opts);
    if (!r.limited) return false;
    res.setHeader('Retry-After', String(r.retryAfterSec));
    res.status(429).json({ error: 'Too many requests — slow down and try again in a moment.' });
    return true;
  } catch {
    return false; // fail open — never let the limiter break the route
  }
}
