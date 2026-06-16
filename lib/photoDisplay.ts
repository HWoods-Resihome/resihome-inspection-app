/**
 * Pick the right <img src> for a stored photo URL.
 *
 * HEIC/HEIF (legacy iPhone uploads, before the always-JPEG fix) doesn't render
 * in <img> in most browsers, so route those through /api/photo-proxy, which
 * converts them to JPEG on the fly. Everything else (the new JPEGs) is shown
 * directly with no proxy overhead.
 */

// In-session cache mapping a freshly-uploaded photo's REAL url to the local blob
// url it was just displayed with. We keep that blob ALIVE (instead of revoking it
// the instant the photo syncs) and serve it here, so the on-screen thumbnail
// keeps showing the SAME local image across the offline->online swap — no flash
// to blank/white and no broken "?" tile while the network image loads. A blob url
// holds only the compressed jpeg bytes (~150KB), NOT a decoded bitmap, so this is
// memory-light; it's capped, and the whole cache is gone on page unload (a fresh
// inspection load shows server urls directly).
const syncedBlobByRealUrl = new Map<string, string>();
const MAX_SYNCED_BLOBS = 150;
const stripVideoFragment = (u: string): string => { const i = u.indexOf('#v='); return i === -1 ? u : u.slice(0, i); };

/** Remember the local blob a just-synced photo was showing, keyed by its real url. */
export function registerSyncedBlob(realUrl: string, blobUrl: string): void {
  if (!realUrl || !blobUrl) return;
  const key = stripVideoFragment(realUrl);
  const val = stripVideoFragment(blobUrl);
  if (!val.startsWith('blob:')) return; // only cache genuine local blobs
  syncedBlobByRealUrl.delete(key); // re-insert so it counts as most-recent
  syncedBlobByRealUrl.set(key, val);
  // Bound memory: evict + revoke the oldest once we exceed the cap. The evicted
  // photo (long since scrolled past) falls back to its real url, which the
  // browser has cached by then.
  if (syncedBlobByRealUrl.size > MAX_SYNCED_BLOBS) {
    const oldestKey = syncedBlobByRealUrl.keys().next().value as string | undefined;
    if (oldestKey !== undefined) {
      const oldestBlob = syncedBlobByRealUrl.get(oldestKey);
      syncedBlobByRealUrl.delete(oldestKey);
      if (oldestBlob) { try { URL.revokeObjectURL(oldestBlob); } catch { /* harmless */ } }
    }
  }
}

export function displayImageSrc(url: string): string {
  if (!url) return url;
  // Video clips are stored as `posterUrl#v=<videoUrl>` (see lib/media.ts). For
  // an <img>, we want the poster only — drop the fragment so the src is clean.
  const v = url.indexOf('#v=');
  const clean = v === -1 ? url : url.slice(0, v);
  // Prefer the still-alive local blob for a just-synced photo, so the thumbnail
  // never flickers blank/broken on the offline->online swap.
  const cached = syncedBlobByRealUrl.get(clean);
  if (cached) return cached;
  const path = clean.split('?')[0];
  if (/\.(heic|heif)$/i.test(path)) {
    return `/api/photo-proxy?url=${encodeURIComponent(clean)}`;
  }
  return clean;
}
