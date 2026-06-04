/**
 * Canonical public links for the app (e.g. the `resiwalk_inspection_url` stamped
 * on every inspection so HubSpot has a one-tap deep link to open it).
 *
 * Origin resolution order:
 *   1. PUBLIC_APP_ORIGIN env (set this to the canonical domain, e.g.
 *      https://resiwalk.com, so links are stable no matter where they're minted),
 *   2. the request origin (whatever domain the inspector is actually on),
 *   3. the production domain as a final fallback.
 */
const PROD_ORIGIN = 'https://resiwalk.com';

export function appOrigin(reqOrigin?: string | null): string {
  const env = (process.env.PUBLIC_APP_ORIGIN || process.env.NEXT_PUBLIC_APP_ORIGIN || '').trim().replace(/\/+$/, '');
  if (env) return env;
  const ro = (reqOrigin || '').trim().replace(/\/+$/, '');
  if (ro) return ro;
  return PROD_ORIGIN;
}

/** Public deep link that opens a specific inspection. */
export function inspectionUrl(recordId: string, reqOrigin?: string | null): string {
  return `${appOrigin(reqOrigin)}/inspection/${recordId}`;
}

/** Build the request's own origin (proto + host) from Next API headers. */
export function reqOriginOf(req: { headers: Record<string, unknown> }): string {
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString();
  const proto = (req.headers['x-forwarded-proto'] || 'https').toString();
  return host ? `${proto}://${host}` : '';
}
