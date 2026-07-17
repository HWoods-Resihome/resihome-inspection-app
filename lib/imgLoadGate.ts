/**
 * Global concurrency limiter for remote thumbnail loads.
 *
 * A photo-heavy inspection — a Scope Rate Card can carry 100+ tiles across its
 * sections — otherwise fires a huge SIMULTANEOUS burst of /api/photo-proxy
 * requests as tiles scroll into view. That burst trips the proxy's per-IP rate
 * limit AND Vercel's automatic bot/DDoS challenge (which then serves a challenge
 * page instead of the image), and floods iOS WebKit with concurrent decodes —
 * leaving whole photo strips stuck on the grey placeholder even though the files
 * are perfectly fine (they open in the full-size viewer). Capping concurrent
 * loads to a handful spreads the requests over time so each one succeeds; the
 * rest queue and start the instant a slot frees. Combined with per-tile viewport
 * gating (PhotoThumb), only near-visible tiles ever compete for a slot.
 *
 * Client-only module state — a single browser tab shares one gate.
 */
let active = 0;
const MAX = 8;
const waiters: Array<() => void> = [];

/** Wait for a load slot. Resolves immediately if one is free, else queues. */
export function acquireImgSlot(): Promise<void> {
  if (active < MAX) { active++; return Promise.resolve(); }
  return new Promise((resolve) => { waiters.push(resolve); });
}

/** Return a slot. Hands it directly to the next waiter (active unchanged) so the
 *  queue drains without a decrement/increment race. */
export function releaseImgSlot(): void {
  const next = waiters.shift();
  if (next) next();
  else active = Math.max(0, active - 1);
}
