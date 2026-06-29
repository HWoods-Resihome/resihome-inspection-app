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
 * DRAGGABLE: the inspector can drag it anywhere and the spot is remembered
 * (localStorage) — so it can be parked out of the way. Defaults to bottom-center,
 * just above the forms' action bar. A small grip handle signals it's movable.
 */
import { useEffect, useRef, useState } from 'react';
import { countOutbox } from '@/lib/offlineOutbox';
import { countPhotoAttach } from '@/lib/photoAttachOutbox';
import { countAllQueuedPhotos } from '@/lib/offlinePhotoStore';

const POS_KEY = 'resiwalk_syncbadge_pos_v1';

export function SyncStatusBadge() {
  const [pending, setPending] = useState(0);
  const [online, setOnline] = useState(true);
  const [justSynced, setJustSynced] = useState(false);
  const prevRef = useRef(0);
  const syncedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Dragging: pos === null → default (CSS bottom-center). Once dragged it's a
  // fixed {x,y} (viewport px), persisted so it stays put across reloads.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const elRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ dx: number; dy: number; moved: boolean } | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (raw) { const p = JSON.parse(raw); if (p && typeof p.x === 'number' && typeof p.y === 'number') setPos(p); }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      let photos = 0;
      try { photos = await countAllQueuedPhotos(); } catch { /* IDB hiccup */ }
      if (cancelled) return;
      const total = countOutbox() + countPhotoAttach() + photos;
      setOnline(typeof navigator === 'undefined' || navigator.onLine !== false);
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

  function clamp(p: { x: number; y: number }) {
    const w = elRef.current?.offsetWidth || 160;
    const h = elRef.current?.offsetHeight || 36;
    const vw = typeof window !== 'undefined' ? window.innerWidth : 360;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 640;
    return { x: Math.max(6, Math.min(p.x, vw - w - 6)), y: Math.max(6, Math.min(p.y, vh - h - 6)) };
  }

  const onPointerDown = (e: React.PointerEvent) => {
    const el = elRef.current; if (!el) return;
    const rect = el.getBoundingClientRect();
    dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, moved: false };
    setPos({ x: rect.left, y: rect.top }); // switch from CSS-centered to fixed at current spot
    try { el.setPointerCapture(e.pointerId); } catch { /* noop */ }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current.moved = true;
    setPos(clamp({ x: e.clientX - dragRef.current.dx, y: e.clientY - dragRef.current.dy }));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const moved = dragRef.current.moved;
    dragRef.current = null;
    try { elRef.current?.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    if (moved) { setPos((p) => { const c = p ? clamp(p) : p; try { if (c) localStorage.setItem(POS_KEY, JSON.stringify(c)); } catch { /* ignore */ } return c; }); }
  };

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

  const positioned: React.CSSProperties = pos
    ? { left: pos.x, top: pos.y }
    : { left: '50%', transform: 'translateX(-50%)', bottom: 'calc(env(safe-area-inset-bottom, 0px) + 72px)' };

  return (
    <div
      ref={elRef}
      aria-live="polite"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className={`fixed z-[70] flex items-center gap-1.5 rounded-full pl-1.5 pr-3 py-1 text-[11px] font-heading font-semibold shadow-lg select-none cursor-grab active:cursor-grabbing ${tone}`}
      style={{ ...positioned, touchAction: 'none' }}
      title="Drag to move"
    >
      {/* Grip handle — signals the pill is draggable. */}
      <span className="flex flex-col gap-[2px] px-1 opacity-60" aria-hidden>
        <span className="flex gap-[2px]"><i className="w-[3px] h-[3px] rounded-full bg-current" /><i className="w-[3px] h-[3px] rounded-full bg-current" /></span>
        <span className="flex gap-[2px]"><i className="w-[3px] h-[3px] rounded-full bg-current" /><i className="w-[3px] h-[3px] rounded-full bg-current" /></span>
        <span className="flex gap-[2px]"><i className="w-[3px] h-[3px] rounded-full bg-current" /><i className="w-[3px] h-[3px] rounded-full bg-current" /></span>
      </span>
      {!synced && online && (
        <span className="inline-block w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" aria-hidden />
      )}
      {!synced && !online && (
        <span className="inline-block w-2 h-2 rounded-full bg-white" aria-hidden />
      )}
      <span>{label}</span>
    </div>
  );
}
