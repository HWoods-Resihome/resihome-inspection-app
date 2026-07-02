/**
 * Optional CROSS-INSTANCE cache backed by Vercel KV / Upstash Redis (REST API).
 *
 * WHY: /api/inspections caches its list/counts in a per-serverless-instance Map.
 * Under real field load Vercel runs many lambda instances, each with its own cold
 * cache, so a burst of cold instances each re-runs the same ~6 HubSpot searches
 * and trips HubSpot's per-second Search limit (429). A shared cache lets a cold
 * instance serve another instance's recent result instead of re-hitting HubSpot.
 *
 * FAIL-OPEN by design:
 *   - The whole module NO-OPS when the KV env vars are absent, so the endpoint
 *     behaves exactly as today (per-instance cache only) until a store is
 *     connected in Vercel — then it lights up automatically with no code change.
 *   - Every Redis op is time-boxed and swallows all errors → a slow/down KV can
 *     never add meaningful latency or fail a request; it just degrades to the
 *     per-instance path.
 *
 * Invalidation uses a shared GENERATION counter (`insp:gen`): mutations bump it,
 * and cache keys embed it, so a bump makes every prior entry unreachable at once
 * across all instances (no key enumeration needed). The generation is cached
 * locally for a few seconds so hot reads don't pay a round-trip; cross-instance
 * mutation visibility is therefore bounded by that short window (not the TTL).
 *
 * Reads whichever env-var pair the store provides — the Vercel KV integration
 * sets KV_REST_API_URL/TOKEN; a direct Upstash store sets UPSTASH_REDIS_REST_*.
 */

const REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

/** True when a KV/Redis store is connected (env vars present). */
export const sharedCacheEnabled = !!(REST_URL && REST_TOKEN);

const OP_TIMEOUT_MS = 500;          // hard cap per Redis op — never slow the endpoint
const GEN_KEY = 'insp:gen';
const GEN_LOCAL_TTL_MS = 5000;      // how long a fetched generation is trusted locally
const MAX_PAYLOAD_BYTES = 1_000_000; // don't push pathologically large values

/** Run one Redis command via the Upstash REST API. Returns `result` or null. */
async function redis(cmd: (string | number)[]): Promise<any> {
  if (!sharedCacheEnabled) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), OP_TIMEOUT_MS);
  try {
    const r = await fetch(REST_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REST_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const data = await r.json().catch(() => null);
    return data && typeof data === 'object' && 'result' in data ? (data as any).result : null;
  } catch {
    return null; // timeout / network / abort → treat as a miss (fail-open)
  } finally {
    clearTimeout(t);
  }
}

let genCache: { val: number; at: number } | null = null;

/** Current shared generation (0 when disabled). Locally cached for a few seconds. */
export async function getSharedGen(): Promise<number> {
  if (!sharedCacheEnabled) return 0;
  if (genCache && Date.now() - genCache.at < GEN_LOCAL_TTL_MS) return genCache.val;
  const res = await redis(['GET', GEN_KEY]);
  const val = Number(res) || 0;
  genCache = { val, at: Date.now() };
  return val;
}

/** Bump the shared generation — call on any mutation that invalidates the lists. */
export async function bumpSharedGen(): Promise<void> {
  if (!sharedCacheEnabled) return;
  const res = await redis(['INCR', GEN_KEY]);
  const val = Number(res);
  if (Number.isFinite(val)) genCache = { val, at: Date.now() };
  else genCache = null; // couldn't confirm — force a refresh on the next read
}

function fullKey(gen: number, key: string): string {
  return `insp:v${gen}:${key}`;
}

/** Which backend the env vars point at (for the admin health check). */
export function sharedCacheBackend(): 'disabled' | 'vercel-kv' | 'upstash' {
  if (!sharedCacheEnabled) return 'disabled';
  if (process.env.KV_REST_API_URL) return 'vercel-kv';
  return 'upstash';
}

/**
 * Live end-to-end probe: SET a short-lived key and read it back, proving the
 * running function can actually reach the store. For the admin health check.
 */
export async function sharedCachePing(): Promise<{ ok: boolean; latencyMs: number | null }> {
  if (!sharedCacheEnabled) return { ok: false, latencyMs: null };
  const started = Date.now();
  const set = await redis(['SET', 'insp:__ping__', 'ok', 'EX', '30']);
  if (set !== 'OK') return { ok: false, latencyMs: Date.now() - started };
  const got = await redis(['GET', 'insp:__ping__']);
  return { ok: got === 'ok', latencyMs: Date.now() - started };
}

/** Read a JSON value from the shared cache for a captured generation. */
export async function sharedGet<T>(key: string, gen: number): Promise<T | null> {
  if (!sharedCacheEnabled) return null;
  const raw = await redis(['GET', fullKey(gen, key)]);
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

/**
 * Write a JSON value to the shared cache with a TTL (seconds). Skips the write if
 * the generation has advanced since `gen` was captured (a mutation raced this
 * fetch → the data is now stale, so don't cache it under the new generation).
 */
export async function sharedSet<T>(key: string, gen: number, value: T, ttlSec: number): Promise<void> {
  if (!sharedCacheEnabled) return;
  const current = await getSharedGen();
  if (current !== gen) return;
  let payload: string;
  try { payload = JSON.stringify(value); } catch { return; }
  if (payload.length > MAX_PAYLOAD_BYTES) return;
  await redis(['SET', fullKey(gen, key), payload, 'EX', String(Math.max(1, Math.round(ttlSec)))]);
}
