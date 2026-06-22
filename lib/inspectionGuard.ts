// Server-side write guard for external (1099) users — SERVER-ONLY.
//
// Use in every inspection WRITE API route (save answers, submit, rate-card
// lines, finalize, QC finalize). For internal users it's a no-op with NO extra
// HubSpot read; for external users it loads the inspection's template + status
// and applies the single rule in lib/userAccess (1099 only, no editing once
// completed). Returns a 403 message, or null when allowed.

import { fetchInspectionById, externalUnlockedView } from '@/lib/hubspot';
import { isExternalEmail, externalAccessDenial } from '@/lib/userAccess';

export async function externalWriteDenial(
  email: string | null | undefined,
  inspectionId: string,
): Promise<string | null> {
  if (!isExternalEmail(email)) return null; // internal users: unrestricted, no fetch
  const insp = await fetchInspectionById(inspectionId);
  if (!insp) return null; // not found → let the endpoint return its own 404
  return externalAccessDenial(email, insp.templateType, { write: true, status: insp.status, ownerEmail: insp.inspectorEmail });
}

/**
 * READ guard for external users — use on routes that surface an inspection's
 * content (e.g. PDF generation). No-op (no HubSpot read) for internal users; for
 * external users it loads the template + status and applies the read rule: any
 * 1099, plus COMPLETED Scope Rate Card / Re-Inspect (view-only) — and the latter
 * only in states the user has unlocked. Returns a 403 message, or null when
 * allowed.
 */
export async function externalViewDenial(
  email: string | null | undefined,
  inspectionId: string,
): Promise<string | null> {
  if (!isExternalEmail(email)) return null; // internal users: unrestricted, no fetch
  const insp = await fetchInspectionById(inspectionId);
  if (!insp) return null; // not found → let the endpoint return its own 404
  const { states } = await externalUnlockedView(email);
  return externalAccessDenial(email, insp.templateType, {
    status: insp.status,
    region: insp.regionSnapshot,
    unlockedStates: states,
  });
}
