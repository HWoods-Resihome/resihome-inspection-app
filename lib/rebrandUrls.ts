/**
 * Pure helpers to rewrite a RAW Vercel Blob URL
 *   https://<store>.public.blob.vercel-storage.com/<key>[?q][#f]
 * to the branded, absolute, same-origin form
 *   https://<origin>/m/<key>[?q][#f]
 * which next.config transparently proxies back to the blob store (so the address
 * bar + tab favicon are ours). Used by the one-time backfill that moves stored
 * URLs onto our domain.
 *
 * Idempotent: a branded /m/ URL no longer matches the blob host, so re-running is
 * a no-op. Non-blob URLs (HubSpot files, short links, app URLs) pass through
 * untouched. Video list entries (`<poster>#v=<encoded videoUrl>`) rebrand BOTH
 * the poster and the embedded video URL.
 */

const BLOB_RE = /^https?:\/\/[^/]*\.public\.blob\.vercel-storage\.com(\/[^?#]*)([?#].*)?$/i;
const VIDEO_MARK = '#v=';

/** True if a string contains a raw Vercel Blob host anywhere (cheap pre-check). */
export function hasBlobUrl(s: any): boolean {
  return /\.public\.blob\.vercel-storage\.com/i.test(String(s || ''));
}

/** Rebrand a single URL string. Returns it unchanged when it isn't a blob URL. */
export function rebrandUrl(url: any, origin: string): string {
  const s = String(url || '');
  const m = BLOB_RE.exec(s);
  if (!m) return s;
  const base = String(origin || '').replace(/\/+$/, '');
  return `${base}/m${m[1]}${m[2] || ''}`;
}

/** Rebrand one photo-list ENTRY, handling the `<poster>#v=<enc video>` video form. */
export function rebrandEntry(entry: any, origin: string): string {
  const s = String(entry || '');
  const i = s.indexOf(VIDEO_MARK);
  if (i === -1) return rebrandUrl(s, origin);
  const poster = s.slice(0, i);
  const rawVideo = s.slice(i + VIDEO_MARK.length);
  let decoded = rawVideo;
  try { decoded = decodeURIComponent(rawVideo); } catch { /* keep raw */ }
  return `${rebrandUrl(poster, origin)}${VIDEO_MARK}${encodeURIComponent(rebrandUrl(decoded, origin))}`;
}

/**
 * Rebrand a delimited photo-list property. `delim` is what we RE-JOIN with
 * (services use '\n', answers use ';'); the read split tolerates commas too.
 * Returns { value, changed } — changed is true only when a blob URL was actually
 * rewritten (so the caller can skip a no-op PATCH and preserve original formatting).
 */
export function rebrandDelimitedList(value: any, delim: '\n' | ';', origin: string): { value: string; changed: boolean } {
  const s = String(value || '');
  if (!hasBlobUrl(s)) return { value: s, changed: false };
  const parts = s.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
  const next = parts.map((p) => rebrandEntry(p, origin));
  return { value: next.join(delim), changed: true };
}

/**
 * Rebrand every blob URL found ANYWHERE inside a JSON string (object/array/
 * scalar), leaving all other data intact. Safe for answers_json (proof URL +
 * `<qid>__photos` arrays), pdf_vendor_urls_json (values), and the Final-Checklist
 * `note` blob. Returns the original string unchanged when it has no blob URL or
 * isn't valid JSON (never corrupts a plain-text note).
 */
export function rebrandJsonBlob(raw: any, origin: string): { value: string; changed: boolean } {
  const s = String(raw || '');
  if (!hasBlobUrl(s)) return { value: s, changed: false };
  let parsed: any;
  try { parsed = JSON.parse(s); } catch { return { value: s, changed: false }; }
  let changed = false;
  const walk = (v: any): any => {
    if (typeof v === 'string') {
      const nv = v.includes(VIDEO_MARK) ? rebrandEntry(v, origin) : rebrandUrl(v, origin);
      if (nv !== v) changed = true;
      return nv;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') { const o: Record<string, any> = {}; for (const k of Object.keys(v)) o[k] = walk(v[k]); return o; }
    return v;
  };
  const next = walk(parsed);
  return changed ? { value: JSON.stringify(next), changed: true } : { value: s, changed: false };
}
