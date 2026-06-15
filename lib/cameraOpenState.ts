/**
 * Global "is an in-app camera open" signal.
 *
 * When the full-screen camera overlay is open, the inspection form beneath it is
 * invisible — but the browser still keeps every photo thumbnail in that form
 * DECODED in memory. On iOS the standalone PWA has a tight memory ceiling, and
 * those decoded photos + the live camera + each new capture push it over,
 * jettisoning the WebKit content process (the black "A problem repeatedly
 * occurred" crash, reliably after a shot or two on a photo-heavy inspection).
 *
 * So every form subscribes to this and STOPS rendering its photo grids while a
 * camera is open (they re-render instantly on close). The camera lives inside
 * the forms, so a counter handles overlapping/nested instances safely.
 */
import { useEffect, useState } from 'react';

let openCount = 0;
const listeners = new Set<(open: boolean) => void>();

function emit(open: boolean) {
  for (const l of listeners) { try { l(open); } catch { /* noop */ } }
}

export function pushCameraOpen(): void {
  openCount += 1;
  if (openCount === 1) emit(true);
}

export function popCameraOpen(): void {
  openCount = Math.max(0, openCount - 1);
  if (openCount === 0) emit(false);
}

export function isAnyCameraOpen(): boolean {
  return openCount > 0;
}

/** Re-renders the caller whenever a camera opens/closes anywhere in the app. */
export function useAnyCameraOpen(): boolean {
  const [open, setOpen] = useState<boolean>(openCount > 0);
  useEffect(() => {
    const l = (o: boolean) => setOpen(o);
    listeners.add(l);
    setOpen(openCount > 0); // sync in case it changed between render and effect
    return () => { listeners.delete(l); };
  }, []);
  return open;
}
