/**
 * Pick the right <img src> for a stored photo URL.
 *
 * HEIC/HEIF (legacy iPhone uploads, before the always-JPEG fix) doesn't render
 * in <img> in most browsers, so route those through /api/photo-proxy, which
 * converts them to JPEG on the fly. Everything else (the new JPEGs) is shown
 * directly with no proxy overhead.
 */
export function displayImageSrc(url: string): string {
  if (!url) return url;
  // Video clips are stored as `posterUrl#v=<videoUrl>` (see lib/media.ts). For
  // an <img>, we want the poster only — drop the fragment so the src is clean.
  const v = url.indexOf('#v=');
  const clean = v === -1 ? url : url.slice(0, v);
  const path = clean.split('?')[0];
  if (/\.(heic|heif)$/i.test(path)) {
    return `/api/photo-proxy?url=${encodeURIComponent(clean)}`;
  }
  return clean;
}
