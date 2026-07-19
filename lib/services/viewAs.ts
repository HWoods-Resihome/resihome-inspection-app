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
// Which vendor the admin chose in the View As picker — the preview scopes to
// THIS company's work orders (previously only a boolean was kept, so the preview
// always showed the alphabetically-first vendor, usually one with no services).
export const VIEW_AS_EMAIL_COOKIE = 'svc_view_as_email';

/** Read the cookie from a getServerSideProps `ctx.req` (pages router). */
export function isViewingAsVendor(req: any): boolean {
  try {
    const c = req?.cookies;
    if (c && typeof c === 'object' && c[VIEW_AS_COOKIE] != null) return c[VIEW_AS_COOKIE] === 'vendor';
    const raw = String(req?.headers?.cookie || '');
    return new RegExp(`(?:^|;\\s*)${VIEW_AS_COOKIE}=vendor(?:;|$)`).test(raw);
  } catch { return false; }
}

/** The specific vendor email the preview should scope to ('' when none chosen). */
export function viewAsVendorEmail(req: any): string {
  try {
    const c = req?.cookies;
    let raw = '';
    if (c && typeof c === 'object' && c[VIEW_AS_EMAIL_COOKIE] != null) raw = String(c[VIEW_AS_EMAIL_COOKIE]);
    else {
      const m = new RegExp(`(?:^|;\\s*)${VIEW_AS_EMAIL_COOKIE}=([^;]*)`).exec(String(req?.headers?.cookie || ''));
      raw = m ? m[1] : '';
    }
    const email = decodeURIComponent(raw).trim().toLowerCase();
    return email.includes('@') ? email : '';
  } catch { return ''; }
}

/** Client-side: enter/exit the vendor preview (24h cookie), then reload the app.
 *  Pass the picked vendor's email so the preview shows THAT company's services. */
export function setViewAsVendor(on: boolean, vendorEmail?: string): void {
  if (typeof document === 'undefined') return;
  document.cookie = on
    ? `${VIEW_AS_COOKIE}=vendor; path=/; max-age=86400; samesite=lax`
    : `${VIEW_AS_COOKIE}=; path=/; max-age=0; samesite=lax`;
  document.cookie = on && vendorEmail
    ? `${VIEW_AS_EMAIL_COOKIE}=${encodeURIComponent(vendorEmail.trim().toLowerCase())}; path=/; max-age=86400; samesite=lax`
    : `${VIEW_AS_EMAIL_COOKIE}=; path=/; max-age=0; samesite=lax`;
}
