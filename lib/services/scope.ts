/**
 * lib/services/scope.ts — who sees which service work orders.
 *
 * Internal app-admins see EVERYTHING (canSeeAll). A vendor — a real vendor login,
 * or an internal user in "View as Vendor" preview — must only ever see the
 * services assigned to THEM. This is enforced server-side (in getServerSideProps)
 * so a vendor's browser never even receives another vendor's work orders.
 */
import type { ServiceRecord } from '@/lib/services/model';

export interface ServiceViewer {
  canSeeAll: boolean;          // internal (and not previewing as a vendor)
  vendorEmail: string | null;  // the vendor whose services to show (else null)
  vendorName: string | null;
}

// Viewer resolution lives in scopeServer.ts (resolveServiceViewerAsync) — it
// consults the live approved-vendor Companies list. The pure, client-safe helpers
// below (serviceVisibleTo / scopeServices) operate on an already-resolved viewer.

/** True if this service is visible to the viewer. */
export function serviceVisibleTo(s: ServiceRecord, viewer: ServiceViewer): boolean {
  if (viewer.canSeeAll) return true;
  const e = (viewer.vendorEmail || '').toLowerCase();
  const se = (s.vendorEmail || '').toLowerCase();
  if (e && se && se === e) return true;
  // Fall back to the display name for legacy rows that carry no vendor_email.
  if (viewer.vendorName && s.vendor === viewer.vendorName) return true;
  return false;
}

/** Restrict a service list to what the viewer may see. */
export function scopeServices(services: ServiceRecord[], viewer: ServiceViewer): ServiceRecord[] {
  if (viewer.canSeeAll) return services;
  return services.filter((s) => serviceVisibleTo(s, viewer));
}
