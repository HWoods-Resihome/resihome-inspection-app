/**
 * "Is the app armed for offline use?" — i.e. has the service worker finished
 * precaching this build's route + form chunks (see public/sw.js install →
 * PRECACHE_CHUNKS + the [id] route shell)?
 *
 * The recurring field pain was going offline BEFORE the precache finished (or
 * before the new SW even installed), then finding inspections won't open. The
 * home screen uses this to show a clear "Ready for offline" vs "Preparing
 * offline…" indicator so the inspector knows when it's safe to head into a dead
 * zone. We treat the cached [id] route shell as the proxy: it's written in the
 * SAME install step as the chunk precache, so its presence means the bundle is
 * cached too.
 */
export async function isOfflineReady(): Promise<boolean> {
  try {
    if (typeof caches === 'undefined') return false;
    const keys = await caches.keys();
    for (const k of keys) {
      const c = await caches.open(k);
      if (await c.match('/inspection/__id_shell__')) return true;
    }
    return false;
  } catch {
    return false;
  }
}
