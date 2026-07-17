/**
 * SSRF-safe fetch for the media proxies (photo-proxy / video-proxy /
 * video-transcode).
 *
 * The proxies must FOLLOW redirects — a HubSpot Files URL routinely 302s to a
 * signed CDN/S3 URL on a host that ISN'T in the allowlist — so we can't defend
 * by host allowlist alone on the redirect target. Instead we follow redirects
 * MANUALLY and, on EVERY hop (including the initial URL), resolve the hostname
 * and refuse to connect to a private / loopback / link-local / CGNAT / ULA
 * address. That blocks the real SSRF vector (an allowlisted open-redirect aimed
 * at cloud metadata `169.254.169.254`, `localhost`, or an internal service)
 * while still allowing a legitimate public CDN redirect.
 *
 * Residual caveat: this checks the resolved IP at validation time, not at
 * connect time, so a determined DNS-rebinding attacker could still race it. That
 * is a far more exotic attack than the open-redirect case this closes; pinning
 * the connect IP would require a custom agent and is out of scope here.
 */
import { lookup } from 'dns/promises';
import { isIP } from 'net';

export class ProxyFetchError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = 'ProxyFetchError';
    this.status = status;
  }
}

/** True for any address we must NEVER connect a proxied fetch to. Errs closed:
 *  a malformed / non-literal input returns true (block). */
export function isPrivateIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const parts = ip.split('.').map((n) => Number(n));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 0) return true;                       // 0.0.0.0/8 (this host)
    if (a === 10) return true;                      // 10.0.0.0/8
    if (a === 127) return true;                     // loopback
    if (a === 169 && b === 254) return true;        // link-local (incl. 169.254.169.254 metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;        // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a >= 224) return true;                      // 224.0.0.0/3 multicast + reserved
    return false;
  }
  if (kind === 6) {
    const lc = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (lc === '::' || lc === '::1') return true;   // unspecified / loopback
    if (/^fe[89ab]/.test(lc)) return true;          // fe80::/10 link-local
    if (/^f[cd]/.test(lc)) return true;             // fc00::/7 unique-local
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lc); // IPv4-mapped
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return true; // not a literal IP (shouldn't happen — callers pass resolved IPs)
}

/** Resolve a hostname and throw unless EVERY resolved address is public. */
async function assertPublicHost(hostname: string): Promise<void> {
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(hostname, { all: true });
  } catch {
    throw new ProxyFetchError(`Could not resolve host ${hostname}`, 502);
  }
  if (!addrs.length) throw new ProxyFetchError(`No address for ${hostname}`, 502);
  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      throw new ProxyFetchError(`Refusing to fetch a private/internal address (${hostname})`, 403);
    }
  }
}

/**
 * fetch() that follows redirects manually, validating the host of every hop
 * (protocol http/https + non-private resolved IP). Returns the first non-3xx
 * response. Upstream status codes (404/403/5xx) are RETURNED (so caller retry
 * logic still works); only SSRF/DNS/protocol/too-many-redirects throw
 * ProxyFetchError.
 */
export async function safeProxyFetch(
  initialUrl: string,
  opts: { signal?: AbortSignal; maxHops?: number } = {},
): Promise<Response> {
  const maxHops = opts.maxHops ?? 5;
  let current = initialUrl;
  for (let hop = 0; hop <= maxHops; hop++) {
    let u: URL;
    try { u = new URL(current); } catch { throw new ProxyFetchError('Invalid URL in redirect chain', 502); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      throw new ProxyFetchError(`Blocked non-http(s) protocol ${u.protocol}`, 403);
    }
    await assertPublicHost(u.hostname);
    const resp = await fetch(current, { redirect: 'manual', signal: opts.signal });
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      if (!loc) return resp; // 3xx with no Location — hand back as-is
      try { current = new URL(loc, current).toString(); }
      catch { throw new ProxyFetchError('Invalid redirect Location', 502); }
      continue;
    }
    return resp;
  }
  throw new ProxyFetchError('Too many redirects', 502);
}

/** Read a response body into a Buffer, refusing anything over maxBytes (both via
 *  the Content-Length header and while streaming, so a lying/absent length can't
 *  OOM the function). */
export async function readBodyCapped(resp: Response, maxBytes: number): Promise<Buffer> {
  const len = Number(resp.headers.get('content-length') || 0);
  if (len && len > maxBytes) throw new ProxyFetchError('Upstream response too large', 413);
  const reader = resp.body?.getReader();
  if (!reader) {
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > maxBytes) throw new ProxyFetchError('Upstream response too large', 413);
    return buf;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => { /* noop */ });
        throw new ProxyFetchError('Upstream response too large', 413);
      }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks);
}

// Host allowlist for USER-SUPPLIED photo URLs (Vercel Blob + the HubSpot file
// host family + our own domains). Shared by /api/photo-proxy, write-time
// validation (service submit/autosave), and the server-side photo fetchers (PDF
// render, AI review). SECURITY: keep this pinned — do NOT loosen the hubspot
// pattern to `hubspot[a-z0-9-]*`, which also matches attacker-registerable
// domains (hubspotx.com / hubspot-evil.com).
export const ALLOWED_PHOTO_HOST_RE = /(^|\.)(hubspotusercontent([0-9]+|-[a-z0-9-]+)?\.(net|com)|hubspot\.(com|net)|hubfs\.com|hs-sites\.com|hubapi\.com|vercel-storage\.com|resihome\.com|resiwalk\.com)$/i;

/** True if `urlString` is an https URL on an allowed photo host (fragment ignored). */
export function isAllowedPhotoHost(urlString: string): boolean {
  try {
    const u = new URL(String(urlString || '').split('#')[0]);
    return u.protocol === 'https:' && ALLOWED_PHOTO_HOST_RE.test(u.hostname);
  } catch { return false; }
}
