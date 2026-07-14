/**
 * lib/services/scope.ts — who sees which service work orders.
 *
 * Internal app-admins see EVERYTHING (canSeeAll). A vendor — a real vendor login,
 * or an internal user in "View as Vendor" preview — must only ever see the
 * services assigned to THEM. This is enforced server-side (in getServerSideProps)
 * so a vendor's browser never even receives another vendor's work orders.
 */
import { isInternalEmail } from '@/lib/userAccess';
import { isViewingAsVendor } from '@/lib/services/viewAs';
import { SERVICE_VENDORS, DEFAULT_SERVICE_VENDOR } from '@/lib/services/vendors';
import type { SampleService } from '@/lib/services/sampleData';

export interface ServiceViewer {
  canSeeAll: boolean;          // internal (and not previewing as a vendor)
  vendorEmail: string | null;  // the vendor whose services to show (else null)
  vendorName: string | null;
}

/** Resolve the viewer's service scope from their session email + the request
 *  (which carries the "View as Vendor" cookie). */
export function resolveServiceViewer(email: string | null | undefined, req: any): ServiceViewer {
  const internal = isInternalEmail(email);
  const previewing = isViewingAsVendor(req);
  if (internal && !previewing) return { canSeeAll: true, vendorEmail: null, vendorName: null };
  // A vendor view: use the logged-in vendor when their email is in the registry;
  // for an internal user previewing (no vendor identity), fall back to the default
  // vendor so the preview shows a concrete, correctly-scoped vendor experience.
  const e = String(email || '').trim().toLowerCase();
  const match = SERVICE_VENDORS.find((v) => v.email.toLowerCase() === e);
  const v = match || (previewing ? DEFAULT_SERVICE_VENDOR : null);
  return { canSeeAll: false, vendorEmail: v?.email || null, vendorName: v?.name || null };
}

/** True if this service is visible to the viewer. */
export function serviceVisibleTo(s: SampleService, viewer: ServiceViewer): boolean {
  if (viewer.canSeeAll) return true;
  const e = (viewer.vendorEmail || '').toLowerCase();
  const se = (s.vendorEmail || '').toLowerCase();
  if (e && se && se === e) return true;
  // Fall back to the display name for legacy rows that carry no vendor_email.
  if (viewer.vendorName && s.vendor === viewer.vendorName) return true;
  return false;
}

/** Restrict a service list to what the viewer may see. */
export function scopeServices(services: SampleService[], viewer: ServiceViewer): SampleService[] {
  if (viewer.canSeeAll) return services;
  return services.filter((s) => serviceVisibleTo(s, viewer));
}
