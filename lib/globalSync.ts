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
 *  - Queued PHOTOS: foreground-uploads queued photo bytes for every (non-open)
 *    inspection AND attaches them to their records via the idempotent
 *    /attach-photo endpoint (durable attach outbox) — so photos land on the
 *    record from any page, without reopening. This foreground pass is the only
 *    background path on iOS (no SW Background Sync); on Android we ALSO nudge the
 *    SW so photos upload with the tab closed.
 *
 * Triggers: on install, on `online`, when the tab becomes visible, and on a
 * steady interval. Online-only and single-flight (parallel answer + photo drains
 * so neither blocks the other) so it never piles on or wedges.
 */
import { flushOutbox, reconcileNativeBackgroundAnswers } from '@/lib/offlineOutbox';
import { requestPhotoBackgroundSync, queuedInspectionIds, flushQueuedPhotos, getActiveFormInspectionIds, reconcileNativeBackgroundUploads } from '@/lib/offlinePhotoStore';
import { drainPhotoAttachOutbox } from '@/lib/photoAttachOutbox';

let installed = false;
let inFlight = false;
const INTERVAL_MS = 20000;

async function tick(): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return; // online only
  if (inFlight) return;                                                       // single-flight
  inFlight = true;
  try {
    // Answers and PHOTOS drain INDEPENDENTLY (in parallel) so a slow/hung answer
    // replay can never block photo uploads — the bug where photos didn't sync from
    // the home page until the inspection was reopened. Each side is best-effort.
    const answers = flushOutbox()
      // iOS-only: also drop outbox entries the native uploader replayed after a
      // force-quit (no-op elsewhere). Runs after the web flush so it only clears
      // what's genuinely native-done.
      .then(() => reconcileNativeBackgroundAnswers())
      .catch(() => { /* retries next tick */ });

    // Upload queued PHOTO bytes for EVERY inspection from any page — not just the
    // open form — then attach them server-side. This foreground pass is the ONLY
    // background-upload path on iOS (no SW Background Sync there). The open
    // inspection's form is the SOLE writer of its records, so it's skipped here
    // (else the form's next full-list save would overwrite a background-attached
    // photo); its queued attaches drain idempotently after the inspector leaves.
    const photos = (async () => {
      const activeIds = getActiveFormInspectionIds();
      const ids = await queuedInspectionIds().catch(() => [] as string[]);
      for (const inspId of ids) {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) break;
        if (activeIds.has(inspId)) continue;
        await flushQueuedPhotos(inspId, () => { /* attach handled durably via the outbox */ }).catch(() => {});
      }
      // Attach uploaded photos (section/line) server-side, from any page, so they
      // land on the record without reopening. Idempotent; skips the open inspection.
      await drainPhotoAttachOutbox({ skipInspectionIds: activeIds }).catch(() => {});
      // iOS-only: drop drafts the native background uploader already handled after
      // a force-quit (so the foreground flush doesn't re-upload them). No-op
      // elsewhere — the call returns 0 immediately off-iOS.
      await reconcileNativeBackgroundUploads().catch(() => {});
    })();

    await Promise.allSettled([answers, photos]);
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
