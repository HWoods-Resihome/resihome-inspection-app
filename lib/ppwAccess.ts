/**
 * PPW / Recurring Services SERVER authorization gate.
 *
 * Separate from lib/featureFlags.ts (which is pure + client-safe) because this
 * imports the app-admin check, which pulls in server-only HubSpot code — that
 * must never land in the client bundle. Use this in /api/ppw/* handlers; use
 * PPW_FLAG_ON from featureFlags for cheap client-side UI gating.
 */

import { isAppAdmin } from '@/lib/adminAccess';
import { PPW_FLAG_ON } from '@/lib/featureFlags';

/**
 * Authorize a PPW request: the feature flag must be on AND the caller must be an
 * app admin. Call at the top of every PPW endpoint so a normal inspector can
 * never reach it even on a deploy where the flag is on.
 */
export async function ppwEnabled(email: string | null | undefined): Promise<boolean> {
  if (!PPW_FLAG_ON) return false;
  return isAppAdmin(email);
}
