/**
 * Save a photo to the device — a manual backup for inspectors in weak-signal
 * areas (so a capture is never lost if the sync silently fails). Prefers the
 * native share sheet (navigator.share with a file → "Save to Photos" on iOS,
 * "Save image"/gallery on Android); falls back to a download when Web Share with
 * files isn't available. Works for a local in-camera capture (blob:/data: URL,
 * available offline) and for an already-uploaded photo (fetched, ideally through
 * the same-origin /api/photo-proxy to avoid cross-origin read blocks).
 */
export type SavePhotoResult = 'shared' | 'downloaded' | 'cancelled' | 'failed';

export async function savePhotoToDevice(fetchUrl: string, filename: string): Promise<SavePhotoResult> {
  try {
    const res = await fetch(fetchUrl);
    if (!res.ok) return 'failed';
    const blob = await res.blob();
    if (!blob.size) return 'failed';
    const type = blob.type || 'image/jpeg';
    const name = /\.[a-z0-9]{2,5}$/i.test(filename) ? filename : `${filename}.jpg`;
    const file = new File([blob], name, { type });

    const nav: any = typeof navigator !== 'undefined' ? navigator : null;
    if (nav && typeof nav.canShare === 'function' && nav.canShare({ files: [file] }) && typeof nav.share === 'function') {
      try { await nav.share({ files: [file] }); return 'shared'; }
      catch (e: any) { if (e?.name === 'AbortError') return 'cancelled'; /* else fall through to download */ }
    }

    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objUrl; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => { try { URL.revokeObjectURL(objUrl); } catch { /* noop */ } }, 15000);
    return 'downloaded';
  } catch { return 'failed'; }
}
