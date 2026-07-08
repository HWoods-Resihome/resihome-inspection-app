/**
 * ResiWalk - Services SERVER authorization gate.
 *
 * Separate from lib/featureFlags.ts (which is pure + client-safe) because this
 * imports the app-admin check, which pulls in server-only HubSpot code — that
 * must never land in the client bundle. Use this in /api/services/* handlers; use
 * SERVICES_FLAG_ON from featureFlags for cheap client-side UI gating.
 *
 * ("PPW" is only shorthand for the vendor being replaced — never used in code.)
 */

import { isAppAdmin } from '@/lib/adminAccess';
import { SERVICES_FLAG_ON } from '@/lib/featureFlags';

/**
 * Authorize an internal Services request: the feature flag must be on AND the
 * caller must be an app admin. Call at the top of every internal Services
 * endpoint. (Vendor-facing endpoints use a separate vendor-session gate — see the
 * plan doc — not this.)
 */
export async function servicesEnabled(email: string | null | undefined): Promise<boolean> {
  if (!SERVICES_FLAG_ON) return false;
  return isAppAdmin(email);
}
