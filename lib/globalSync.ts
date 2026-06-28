/**
 * Global background sync — runs on EVERY page (installed once from _app), not
 * just inside an open inspection form.
 *
 * What it drains:
 *  - The offline OUTBOX (answer selections + text, rate-card line edits, section
 *    layout) via flushOutbox(). These are self-describing, idempotent HTTP
 *    replays keyed by a stable answer_id_external, so they sync correctly from
 *    anywhere — the moment signal returns, on the home list, mid-navigation, etc.
 *    Previously they only drained while the relevant form was mounted, so edits
 *    made then "Save & Close"d sat unsynced until that inspection was reopened.
 *  - Queued PHOTO bytes: we ask the service worker to run its Background Sync,
 *    which uploads queued photos even with the tab closed (Chromium). We do NOT
 *    foreground-flush photos here: that path deletes the queue record on upload
 *    and relies on the open form to ATTACH the URL to its section/line, so
 *    running it without a form would orphan the photo. Attach still completes
 *    when the inspection is next opened (cheap, via the record's uploadedUrl).
 *
 * Triggers: on install, on `online`, when the tab becomes visible, and on a
 * steady interval. Online-only and single-flight so it never piles on.
 */
import { flushOutbox } from '@/lib/offlineOutbox';
import { requestPhotoBackgroundSync, queuedInspectionIds, flushQueuedPhotos, getActiveFormInspectionIds } from '@/lib/offlinePhotoStore';
import { drainPhotoAttachOutbox } from '@/lib/photoAttachOutbox';

let installed = false;
let inFlight = false;
const INTERVAL_MS = 20000;

async function tick(): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return; // online only
  if (inFlight) return;                                                       // single-flight
  inFlight = true;
  try {
    // Drain queued answer/line/section saves (all inspections, idempotent).
    await flushOutbox().catch(() => { /* best-effort; retries next tick */ });

    // Upload queued PHOTO bytes for EVERY inspection from any page — not just the
    // open form. This is the only background-upload path on iOS (no SW Background
    // Sync there). Safe now because the upload records a DURABLE attach instruction
    // (finishSynced → photo-attach outbox) before deleting the queue record, so a
    // no-op onSynced here can't orphan the photo; the open form (if any) coalesces
    // on the same per-inspection flush and self-heals its grid via notifyPhotoSynced.
    // The open inspection's form is the SOLE writer of its records — never flush
    // or attach it from here, or the form's next full-list save would overwrite
    // (and erase) a background-attached photo.
    const activeIds = getActiveFormInspectionIds();
    try {
      const ids = await queuedInspectionIds();
      for (const inspId of ids) {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) break;
        if (activeIds.has(inspId)) continue;
        await flushQueuedPhotos(inspId, () => { /* attach handled durably via the outbox */ }).catch(() => {});
      }
    } catch { /* best-effort */ }

    // Attach uploaded photos to their records server-side (section/line), from any
    // page — so photos land on the record even after leaving the form. Idempotent.
    // Skip the open inspection (its form writes those records) to avoid a
    // read-modify-write clobber; its entries attach after the inspector leaves.
    await drainPhotoAttachOutbox({ skipInspectionIds: activeIds }).catch(() => { /* best-effort */ });
    // Also nudge the SW to upload with the tab CLOSED (Chromium only; no-op on iOS,
    // where the foreground pass above is the background-upload path).
    void requestPhotoBackgroundSync();
  } finally {
    inFlight = false;
  }
}

/** Install the global sync loop once. Safe to call on every mount. */
export function installGlobalSync(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const kick = () => { void tick(); };
  window.addEventListener('online', kick);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') kick(); });
  setInterval(kick, INTERVAL_MS);
  // First pass shortly after load so the page's own initial fetches settle first.
  setTimeout(kick, 4000);
}
