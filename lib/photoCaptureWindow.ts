/**
 * Per-inspection photo capture window: the FIRST and LAST photo capture times for
 * an inspection, kept durably in localStorage. Recorded at capture time (see
 * offlinePhotoStore.uploadPhotoOrQueue) so it survives sync/reload, and read at
 * submit to stamp the inspection's first_photo_at / last_photo_at. Powers the
 * "completion time = first photo → last photo" Insights metric for inspections
 * done going forward.
 *
 * Best-effort and SSR-safe: every function no-ops when there's no localStorage or
 * on any storage error — it must never affect capture or submit.
 */
const KEY = 'resiwalk_photo_window_v1';

type Window = { first: number; last: number };
type Windows = Record<string, Window>;

function read(): Windows {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed as Windows : {};
  } catch { return {}; }
}

function write(w: Windows): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(KEY, JSON.stringify(w)); } catch { /* quota/denied — best-effort */ }
}

/** Fold one photo's capture time into the inspection's min/max window. */
export function recordPhotoCapture(inspectionId: string, atMs: number): void {
  if (!inspectionId || !Number.isFinite(atMs)) return;
  const w = read();
  const cur = w[inspectionId];
  w[inspectionId] = cur
    ? { first: Math.min(cur.first, atMs), last: Math.max(cur.last, atMs) }
    : { first: atMs, last: atMs };
  write(w);
}

/** The inspection's capture window, or null if no photos were captured here. */
export function getPhotoWindow(inspectionId: string): Window | null {
  if (!inspectionId) return null;
  const w = read()[inspectionId];
  return w && Number.isFinite(w.first) && Number.isFinite(w.last) ? w : null;
}

/** Drop an inspection's window (call after a successful submit). */
export function clearPhotoWindow(inspectionId: string): void {
  if (!inspectionId) return;
  const w = read();
  if (w[inspectionId]) { delete w[inspectionId]; write(w); }
}
