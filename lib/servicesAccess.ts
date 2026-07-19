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
import { getUserOverride } from '@/lib/userManagement';

/**
 * Authorize an internal Services request. An explicit per-user Services override
 * (from User Management) wins; otherwise it falls back to the legacy behavior —
 * Services access == admin access — so every current admin keeps Services until
 * an admin toggles it off. Call at the top of every internal Services endpoint.
 */
export async function servicesEnabled(email: string | null | undefined): Promise<boolean> {
  const ov = await getUserOverride(email).catch(() => undefined);
  if (ov && typeof ov.services === 'boolean') return ov.services;
  return isAppAdmin(email);
}
