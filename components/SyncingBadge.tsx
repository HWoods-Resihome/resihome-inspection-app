import { useEffect, useState } from 'react';

/**
 * Overlay badge on a photo thumbnail that hasn't finished uploading yet.
 *
 * The old badge just said "Saved Offline", which read as stuck — the inspector
 * couldn't tell anything was happening. Now it reflects what's ACTUALLY going on:
 *   • online  → "Syncing…" (blue, with a soft pulsing dot) — the background flush
 *     is actively uploading it, so the inspector knows it's saving.
 *   • offline → "Saved Offline" (amber) — held safely on the device, will upload
 *     when the connection returns.
 * The dot is the only motion (a gentle pulse, not a spinner) so it reassures
 * without being distracting.
 */
export function SyncingBadge() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(typeof navigator === 'undefined' || navigator.onLine !== false);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return (
    <span
      className={`absolute bottom-0 inset-x-0 ${online ? 'bg-sky-600/95' : 'bg-amber-500/95'} text-white text-[8px] font-heading font-bold text-center leading-tight py-0.5 rounded-b pointer-events-none flex items-center justify-center gap-1`}
      title={online ? 'Syncing — saving to the cloud…' : 'Saved offline · will sync when back online'}
    >
      {online && <span className="w-1 h-1 rounded-full bg-white/90 animate-pulse" aria-hidden="true" />}
      {online ? 'Syncing…' : 'Saved Offline'}
    </span>
  );
}
