/**
 * Optional cross-instance cache (L2), backed by Vercel KV / Upstash Redis.
 *
 * WHY: Vercel runs many serverless instances under load, and each has its OWN
 * in-memory cache. So a freshly-spun-up instance re-fetches expensive, GLOBAL,
 * rarely-changing data (the ~1,000-row rate-card catalog, the region rates) from
 * HubSpot — paying ~10 paginated calls — even though a sibling instance already
 * has it. This layer lets instances SHARE those results: whoever computes it
 * writes it to KV, and a cold instance reads it instead of re-hitting HubSpot.
 *
 * SAFETY: entirely OPTIONAL and OFF by default. With no KV env configured every
 * function is a no-op (get → null, set → nothing), so behavior is IDENTICAL to
 * today (in-memory only). All network/parse errors are swallowed and every call
 * is time-boxed — KV is a best-effort accelerator, never a dependency. Uses the
 * KV REST API's command format directly, so there's no new package to install;
 * just set KV_REST_API_URL + KV_REST_API_TOKEN (Vercel sets these automatically
 * when you link a KV store to the project).
 */

const KV_URL = (process.env.KV_REST_API_URL || '').replace(/\/$/, '');
const KV_TOKEN = process.env.KV_REST_API_TOKEN || '';

export function sharedCacheEnabled(): boolean {
  return !!(KV_URL && KV_TOKEN);
}

// Skip writing values bigger than this (Vercel KV / Upstash cap a single value
// at ~1 MB). Oversized values just stay in-memory-only — never an error.
const MAX_VALUE_BYTES = 900_000;
const KV_TIMEOUT_MS = 1500; // never let a slow KV add more latency than the HubSpot call it replaces

async function kvCommand(cmd: (string | number)[]): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KV_TIMEOUT_MS);
  try {
    const r = await fetch(KV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
      signal: controller.signal,
    });
    if (!r.ok) return null;
    return await r.json(); // { result: <value> | null } or { error }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Read a JSON value from the shared cache, or null (miss / disabled / error). */
export async function kvGetJSON<T>(key: string): Promise<T | null> {
  if (!sharedCacheEnabled()) return null;
  const body = await kvCommand(['GET', key]);
  const raw = body?.result;
  if (raw == null) return null;
  try {
    return JSON.parse(typeof raw === 'string' ? raw : String(raw)) as T;
  } catch {
    return null;
  }
}

/** Best-effort write of a JSON value with a TTL (seconds). Fire-and-forget safe. */
export async function kvSetJSON(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (!sharedCacheEnabled()) return;
  let payload: string;
  try { payload = JSON.stringify(value); } catch { return; }
  if (!payload || payload.length > MAX_VALUE_BYTES) return; // too big for KV — keep it in-memory only
  await kvCommand(['SET', key, payload, 'EX', Math.max(1, Math.floor(ttlSeconds))]);
}
