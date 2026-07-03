/**
 * App-wide sync status FOOTER (mounted once in _app). Makes the background sync
 * OBSERVABLE in the field: it shows how much work is still queued on the device
 * — answer/line/section edits (outbox), queued photo bytes, and pending photo
 * attaches — and flashes "Synced ✓" when it drains to zero.
 *
 * Presentation: a slim bar pinned to the VERY BOTTOM of the viewport — never an
 * overlay. (It used to be a draggable pill that floated over form values, e.g. the
 * rate-card Client $ figure.) While visible it publishes its own height as the CSS
 * variable `--sync-footer-h`; the forms' action bars read that var to slide UP by
 * exactly that much, and their content spacers grow by it so nothing hides behind
 * the raised bar. When sync resolves, the footer slides away, the var returns to
 * 0, and the action bars slide back down to their normal height.
 *
 * Read-only: it just polls the durable queues every few seconds (and on
 * visibility/online). It never triggers sync itself — the global driver does that.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { countOutbox } from '@/lib/offlineOutbox';
import { countPhotoAttach } from '@/lib/photoAttachOutbox';
import { countAllQueuedPhotos } from '@/lib/offlinePhotoStore';
import { kickGlobalSync } from '@/lib/globalSync';
import { useAnyCameraOpen } from '@/lib/cameraOpenState';
import { useRouter } from 'next/router';

// Only surface the footer on the two screens where sync context matters: the home
// list and an open inspection. Everywhere else (and inside the full-screen camera /
// photo editor / gallery, which open on top of an inspection) it just gets in the
// way, so it stays hidden.
const FOOTER_ROUTES = new Set(['/', '/inspection/[id]']);

// The height the footer publishes for the action bars to offset by. Kept in sync
// with the forms (they read `var(--sync-footer-h, 0px)`).
const FOOTER_VAR = '--sync-footer-h';
// If the queue makes NO progress for this long while online, treat it as stalled
// and surface Retry. The global driver retries every ~20s on its own, so this is
// > one driver cycle — a queue that isn't draining across cycles, not a slow tick.
const STALL_MS = 30000;

export function SyncStatusBadge() {
  const [pending, setPending] = useState(0);
  const [online, setOnline] = useState(true);
  const [justSynced, setJustSynced] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const prevRef = useRef(0);
  const lastProgressRef = useRef(Date.now()); // last time the queue shrank or was empty
  const syncedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const router = useRouter();
  const cameraOpen = useAnyCameraOpen(); // in-app camera / gallery is full-screen — step aside

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      let photos = 0;
      try { photos = await countAllQueuedPhotos(); } catch { /* IDB hiccup */ }
      if (cancelled) return;
      const total = countOutbox() + countPhotoAttach() + photos;
      const isOnline = typeof navigator === 'undefined' || navigator.onLine !== false;
      setOnline(isOnline);
      if (prevRef.current > 0 && total === 0) {
        setJustSynced(true);
        if (syncedTimer.current) clearTimeout(syncedTimer.current);
        syncedTimer.current = setTimeout(() => { if (!cancelled) setJustSynced(false); }, 2500);
      }
      if (total > 0) setJustSynced(false);
      // Stall tracking: any shrink (progress) or an empty queue resets the clock;
      // otherwise a queue that sits unchanged for STALL_MS while online is stalled.
      if (total === 0 || total < prevRef.current) { lastProgressRef.current = Date.now(); setStalled(false); }
      else if (total > 0 && isOnline && Date.now() - lastProgressRef.current > STALL_MS) { setStalled(true); }
      prevRef.current = total;
      setPending(total);
    };
    void tick();
    const iv = setInterval(() => { void tick(); }, 3000);
    const onVis = () => { if (document.visibilityState === 'visible') void tick(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', () => void tick());
    window.addEventListener('offline', () => void tick());
    return () => { cancelled = true; clearInterval(iv); if (syncedTimer.current) clearTimeout(syncedTimer.current); document.removeEventListener('visibilitychange', onVis); };
  }, []);

  // Manual retry: signal the open form (which owns its records' photos) AND kick
  // the global driver, then give it a fresh STALL_MS window before offering Retry
  // again. Best-effort — the poll above reflects whether it actually drained.
  const onRetry = async () => {
    if (retrying) return;
    setRetrying(true);
    setStalled(false);
    lastProgressRef.current = Date.now();
    try { window.dispatchEvent(new Event('resiwalk:sync-retry')); } catch { /* noop */ }
    try { await kickGlobalSync(); } catch { /* driver is best-effort */ }
    setTimeout(() => setRetrying(false), 2000);
  };

  // Step aside while a modal SHEET is open. Sheets across the app mark their
  // scroll container with `data-modal-scroll`; a fixed footer at the bottom would
  // otherwise paint over a sheet's own bottom action row (e.g. the Add Line Item
  // "Save Line" button, whose footer is `sticky` with no z-index). Generic — no
  // per-modal wiring — via a debounced MutationObserver for that marker.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    let raf = 0;
    const check = () => { setOverlayOpen(!!document.querySelector('[data-modal-scroll]')); };
    const schedule = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; check(); }); };
    check();
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => { mo.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, []);

  const show = (pending > 0 || justSynced) && !overlayOpen && !cameraOpen && FOOTER_ROUTES.has(router.pathname);
  const synced = pending === 0 && justSynced;
  const showRetry = show && online && !synced && stalled;

  // Publish the bar's measured height while visible so the forms' fixed action
  // bars can offset up by exactly that much; 0 while hidden so they slide back
  // down. The CSS transitions on both sides animate the two together. Always
  // cleared on unmount so a stray var can't strand the action bars raised.
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (show && barRef.current) root.style.setProperty(FOOTER_VAR, `${barRef.current.offsetHeight}px`);
    else root.style.setProperty(FOOTER_VAR, '0px');
    return () => { root.style.setProperty(FOOTER_VAR, '0px'); };
  }, [show, synced, online, pending, stalled, retrying, showRetry]);

  const tone = synced
    ? 'bg-emerald-600 text-white'
    : !online
      ? 'bg-amber-500 text-white'
      : (stalled && !retrying)
        ? 'bg-red-600 text-white'   // stuck: not draining — offer Retry
        : 'bg-ink/90 text-white';
  const label = synced
    ? 'Synced ✓'
    : !online
      ? `${pending} item${pending === 1 ? '' : 's'} saved offline`
      : retrying
        ? 'Retrying…'
        : stalled
          ? `${pending} item${pending === 1 ? '' : 's'} haven’t synced`
          : `Syncing ${pending} item${pending === 1 ? '' : 's'}…`;

  // Always mounted so it can animate in/out; translated fully off-screen (and
  // publishing height 0) when there's nothing to show.
  return (
    <div
      ref={barRef}
      aria-live="polite"
      className={`fixed inset-x-0 bottom-0 z-20 flex items-center justify-center gap-2 px-3 py-1.5 text-[11px] font-heading font-semibold shadow-[0_-2px_8px_rgba(0,0,0,0.12)] ${tone}`}
      style={{
        paddingBottom: 'calc(0.375rem + env(safe-area-inset-bottom))',
        transform: show ? 'translateY(0)' : 'translateY(100%)',
        transition: 'transform .25s ease',
        pointerEvents: show ? 'auto' : 'none',
      }}
    >
      {!synced && online && (retrying || !stalled) && (
        <span className="inline-block w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" aria-hidden />
      )}
      {!synced && online && stalled && !retrying && (
        <span className="inline-block w-2 h-2 rounded-full bg-white" aria-hidden />
      )}
      {!synced && !online && (
        <span className="inline-block w-2 h-2 rounded-full bg-white" aria-hidden />
      )}
      <span>{label}</span>
      {showRetry && (
        <button
          type="button"
          onClick={() => void onRetry()}
          className="ml-1 inline-flex items-center rounded-full bg-white/20 px-2.5 py-0.5 font-heading font-semibold hover:bg-white/30 active:bg-white/40"
        >
          Retry
        </button>
      )}
    </div>
  );
}
