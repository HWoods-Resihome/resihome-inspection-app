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
  const path = url.split('?')[0];
  if (/\.(heic|heif)$/i.test(path)) {
    return `/api/photo-proxy?url=${encodeURIComponent(url)}`;
  }
  return url;
}
