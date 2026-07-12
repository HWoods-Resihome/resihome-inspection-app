/**
 * ResiWalk - Services — "View as Vendor" persistence.
 *
 * An internal user can preview the external vendor experience. This used to be a
 * `?as=vendor` query param on the home page only, so it evaporated the moment you
 * opened a service. It's now a short-lived cookie read server-side on every
 * services page (getServerSideProps), so the vendor view persists across the
 * whole app until you exit. Set/cleared client-side (see setViewAsVendor).
 */
export const VIEW_AS_COOKIE = 'svc_view_as';

/** Read the cookie from a getServerSideProps `ctx.req` (pages router). */
export function isViewingAsVendor(req: any): boolean {
  try {
    const c = req?.cookies;
    if (c && typeof c === 'object' && c[VIEW_AS_COOKIE] != null) return c[VIEW_AS_COOKIE] === 'vendor';
    const raw = String(req?.headers?.cookie || '');
    return new RegExp(`(?:^|;\\s*)${VIEW_AS_COOKIE}=vendor(?:;|$)`).test(raw);
  } catch { return false; }
}

/** Client-side: enter/exit the vendor preview (24h cookie), then reload the app. */
export function setViewAsVendor(on: boolean): void {
  if (typeof document === 'undefined') return;
  document.cookie = on
    ? `${VIEW_AS_COOKIE}=vendor; path=/; max-age=86400; samesite=lax`
    : `${VIEW_AS_COOKIE}=; path=/; max-age=0; samesite=lax`;
}
