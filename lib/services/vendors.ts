/**
 * ResiWalk - Services — interim vendor registry.
 *
 * Until the real vendor database is synced (a later phase), the Services feature
 * has exactly ONE selectable/assignable vendor: the test vendor below. Every
 * vendor picker (rule assignment, new-service form) and every generated work
 * order draws from this list, so nothing can be assigned to a company we can't
 * yet dispatch to. When the real vendor sync lands, replace this list (or feed
 * it from HubSpot) and the pickers update automatically.
 */
export interface ServiceVendor {
  name: string;
  email: string;
}

export const SERVICE_VENDORS: ServiceVendor[] = [
  { name: 'Wayden Hoods', email: 'hwoods+test@resihome.com' },
];

export const SERVICE_VENDOR_NAMES: string[] = SERVICE_VENDORS.map((v) => v.name);

/** The default/only vendor to assign while the registry holds a single entry. */
export const DEFAULT_SERVICE_VENDOR: ServiceVendor = SERVICE_VENDORS[0];

/** Email for an assigned vendor name, or null when unknown (e.g. legacy data). */
export const vendorEmail = (name: string | null | undefined): string | null =>
  SERVICE_VENDORS.find((v) => v.name === name)?.email ?? null;
