/**
 * lib/services/scopeServer.ts — SERVER-ONLY viewer resolution against the live
 * approved-vendor Companies list (pulls in HubSpot; never import into a client
 * bundle — use only in getServerSideProps / API handlers). The pure, client-safe
 * helpers (serviceVisibleTo / scopeServices / ServiceViewer) stay in scope.ts.
 */
import { isInternalEmail } from '@/lib/userAccess';
import { isViewingAsVendor, viewAsVendorEmail } from '@/lib/services/viewAs';
import { isAppAdmin } from '@/lib/adminAccess';
import { findVendorForAuth, fetchApprovedVendorCompanies } from '@/lib/hubspot';
import type { ServiceViewer } from '@/lib/services/scope';

/** May this user load the vendor-facing Services pages? App admins (everything)
 *  or an approved vendor company (their own work orders). */
export async function servicesViewerAllowed(email: string | null | undefined): Promise<boolean> {
  if (await isAppAdmin(email).catch(() => false)) return true;
  return !!(await findVendorForAuth(email).catch(() => null));
}

/** Resolve the viewer's service scope, consulting the live approved-vendor list
 *  (so a real vendor login is scoped to their own work orders). Async companion
 *  to the sync resolveServiceViewer (which only knew the interim registry).
 *
 *  Takes the SESSION (not just the email): a vendor login carries `vendor: true`
 *  and must NEVER be treated as internal/canSeeAll — even when the company's
 *  email happens to be on an internal domain (e.g. a +test@resihome.com vendor).
 *  The session flag is authoritative over the email-domain heuristic. */
export async function resolveServiceViewerAsync(session: { email?: string | null; vendor?: boolean } | null | undefined, req: any): Promise<ServiceViewer> {
  const email = session?.email;
  const isVendorSession = !!session?.vendor;
  const internal = isInternalEmail(email) && !isVendorSession;
  const previewing = isViewingAsVendor(req);
  if (internal && !previewing) return { canSeeAll: true, vendorEmail: null, vendorName: null };
  const vendor = await findVendorForAuth(email).catch(() => null);
  if (vendor) return { canSeeAll: false, vendorEmail: vendor.email, vendorName: vendor.name };
  // Internal user previewing "as vendor": scope to the vendor they PICKED in the
  // View As picker (cookie carries the email); fall back to the first approved
  // company only when no specific pick exists (legacy boolean-only cookie).
  if (previewing) {
    const picked = viewAsVendorEmail(req);
    if (picked) {
      const pv = await findVendorForAuth(picked).catch(() => null);
      if (pv) return { canSeeAll: false, vendorEmail: pv.email, vendorName: pv.name };
    }
    const list = await fetchApprovedVendorCompanies().catch(() => []);
    const v = list[0];
    return { canSeeAll: false, vendorEmail: v?.email || null, vendorName: v?.name || null };
  }
  return { canSeeAll: false, vendorEmail: null, vendorName: null };
}
