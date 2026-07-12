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

/**
 * Authorize an internal Services request: the caller must be an app admin.
 * Services is live on production for admins only — access is gated purely on the
 * app-admin check (no build flag), so no other users can reach it. Call at the
 * top of every internal Services endpoint.
 */
export async function servicesEnabled(email: string | null | undefined): Promise<boolean> {
  return isAppAdmin(email);
}
