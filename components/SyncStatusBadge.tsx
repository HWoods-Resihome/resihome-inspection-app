/**
 * App-wide sync status pill (mounted once in _app). Makes the background sync
 * OBSERVABLE in the field: it shows how much work is still queued on the device
 * — answer/line/section edits (outbox), queued photo bytes, and pending photo
 * attaches — and flashes "Synced" when it drains to zero.
 *
 * Read-only: it just polls the durable queues every few seconds (and on
 * visibility/online). It never triggers sync itself — the global driver does
 * that. Hidden when there's nothing pending (after a brief "Synced ✓").
 *
 * Positioned bottom-center, ABOVE the inspection forms' fixed action bar, and
 * below modals (z-index), so it never blocks controls.
 */
import { useEffect, useRef, useState } from 'react';
import { countOutbox } from '@/lib/offlineOutbox';
import { countPhotoAttach } from '@/lib/photoAttachOutbox';
import { countAllQueuedPhotos } from '@/lib/offlinePhotoStore';

export function SyncStatusBadge() {
  const [pending, setPending] = useState(0);
  const [online, setOnline] = useState(true);
  const [justSynced, setJustSynced] = useState(false);
  const prevRef = useRef(0);
  const syncedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      let photos = 0;
      try { photos = await countAllQueuedPhotos(); } catch { /* IDB hiccup */ }
      if (cancelled) return;
      const total = countOutbox() + countPhotoAttach() + photos;
      setOnline(typeof navigator === 'undefined' || navigator.onLine !== false);
      // Flash "Synced ✓" when the queue drains from >0 to 0.
      if (prevRef.current > 0 && total === 0) {
        setJustSynced(true);
        if (syncedTimer.current) clearTimeout(syncedTimer.current);
        syncedTimer.current = setTimeout(() => { if (!cancelled) setJustSynced(false); }, 2500);
      }
      if (total > 0) setJustSynced(false);
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

  if (pending === 0 && !justSynced) return null;

  const synced = pending === 0 && justSynced;
  const tone = synced
    ? 'bg-emerald-600 text-white'
    : online
      ? 'bg-ink/85 text-white'
      : 'bg-amber-500 text-white';
  const label = synced
    ? 'Synced ✓'
    : online
      ? `Syncing ${pending} item${pending === 1 ? '' : 's'}…`
      : `${pending} item${pending === 1 ? '' : 's'} saved offline`;

  return (
    <div
      aria-live="polite"
      className="fixed left-1/2 -translate-x-1/2 z-[70] pointer-events-none"
      style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 76px)' }}
    >
      <div className={`flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-heading font-semibold shadow-lg ${tone}`}>
        {!synced && online && (
          <span className="inline-block w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" aria-hidden />
        )}
        {!synced && !online && (
          <span className="inline-block w-2 h-2 rounded-full bg-white" aria-hidden />
        )}
        <span>{label}</span>
      </div>
    </div>
  );
}
