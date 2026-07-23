/**
 * Shared `/api/auth/me` loader — single-flight + short in-memory cache.
 *
 * The ImpersonationBanner is mounted on EVERY page (via _app) and fetches identity
 * on mount; most pages ALSO fetch `/api/auth/me` for their own admin/services
 * gating. That fired 2+ identical requests on the first paint of nearly every
 * screen. loadMe() collapses concurrent callers onto ONE in-flight request and
 * caches the result briefly, so the banner + the page share a single round-trip.
 *
 * Returns the parsed JSON body (never throws for a non-2xx — the endpoint returns
 * `{authenticated:false}` in that case). A cookie-changing action (impersonate /
 * view-as / logout) does a full reload, which resets this module state, so the
 * cache can't serve a stale identity across those transitions.
 */
export interface MeResponse {
  authenticated?: boolean;
  isAdmin?: boolean;
  isFinalizeAdmin?: boolean;
  impersonating?: boolean;
  isExternal?: boolean;
  user?: { email?: string; name?: string } & Record<string, any>;
  access?: { services?: boolean } & Record<string, any>;
  realName?: string; realEmail?: string;
  [k: string]: any;
}

const ME_TTL_MS = 10_000;
let _cache: MeResponse | null = null;
let _at = 0;
let _inflight: Promise<MeResponse> | null = null;

/** Fetch identity, deduped + cached. Pass force=true to bypass the cache. */
export function loadMe(force = false): Promise<MeResponse> {
  const now = Date.now();
  if (!force && _cache && now - _at < ME_TTL_MS) return Promise.resolve(_cache);
  if (!force && _inflight) return _inflight;
  _inflight = fetch('/api/auth/me', { cache: 'no-store' })
    .then((r) => r.json().catch(() => ({} as MeResponse)))
    .then((d: MeResponse) => { _cache = d; _at = Date.now(); return d; })
    .finally(() => { _inflight = null; });
  return _inflight;
}

/** Drop the cached identity (call after a change that alters the session). */
export function invalidateMe(): void { _cache = null; _at = 0; _inflight = null; }
