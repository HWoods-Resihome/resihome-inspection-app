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

// Maps a DRAFT's small thumbnail blob url -> its FULL-RES local blob url. Grids
// show the small thumb (thumbImageSrc, OOM-safe), but the full-size VIEWER must
// show the sharp original (displayImageSrc) — otherwise an unsynced draft showed
// its 400px thumb blown up full-screen: blurry, with an unreadable burned-in
// stamp. Registered at capture, cleared on sync (the viewer then uses the real
// HubSpot url).
const fullResByDraftThumb = new Map<string, string>();
export function registerDraftFullRes(thumbUrl: string, fullResUrl: string): void {
  if (thumbUrl && fullResUrl) fullResByDraftThumb.set(thumbUrl, fullResUrl);
}
export function clearDraftFullRes(thumbUrl: string): void {
  if (thumbUrl) fullResByDraftThumb.delete(thumbUrl);
}

export function displayImageSrc(url: string): string {
  if (!url) return url;
  // Video clips are stored as `posterUrl#v=<videoUrl>` (see lib/media.ts). For
  // an <img>, we want the poster only — drop the fragment so the src is clean.
  const v = url.indexOf('#v=');
  const clean = v === -1 ? url : url.slice(0, v);
  // Unsynced draft → show its FULL-RES local original (not the small thumb).
  const full = fullResByDraftThumb.get(clean);
  if (full) return full;
  // Synced photo: the real HubSpot url IS full-res. (Do NOT use the synced-thumb
  // cache here — those are 400px thumbnails meant only for grids.)
  const path = clean.split('?')[0];
  if (/\.(heic|heif)$/i.test(path)) {
    return `/api/photo-proxy?url=${encodeURIComponent(clean)}`;
  }
  return clean;
}

/**
 * <img src> for a SMALL thumbnail (grids / strips). Routes remote (HubSpot)
 * photos through the resizing proxy so the browser decodes a ~`w`px bitmap
 * instead of the full 2048px image — the fix for the iOS WebKit OOM crash on
 * photo-heavy inspections (dozens of full-res decodes jettison the content
 * process). Local blob:/data: drafts and a just-synced cached blob are returned
 * as-is (can't be proxied; they're few and transient). Use this everywhere a
 * photo is shown as a small tile; use displayImageSrc for the full-size viewer.
 */
export function thumbImageSrc(url: string, w = 400): string {
  if (!url) return url;
  const v = url.indexOf('#v=');
  const clean = v === -1 ? url : url.slice(0, v);
  // Local draft (offline) or data: thumb — show directly; can't be proxied, and
  // it's a single transient image, not the dozens-of-remote-tiles memory hog.
  if (clean.startsWith('blob:') || clean.startsWith('data:')) return clean;
  // A just-synced photo keeps its SMALL local thumbnail blob alive (registered on
  // sync). Prefer it: it's already ~400px (perfect for a tile), it's local, and
  // it never depends on the /api/photo-proxy network call — which is what was
  // leaving broken/disappearing tiles when the proxy hiccuped after the
  // offline->online swap. Falls through to the proxy only when there's no local
  // thumb (e.g. a photo synced in a previous session / after reload).
  const cached = syncedBlobByRealUrl.get(clean);
  if (cached) return cached;
  // Remote photo → small re-encoded thumbnail through our origin.
  return `/api/photo-proxy?url=${encodeURIComponent(clean)}&w=${w}`;
}

