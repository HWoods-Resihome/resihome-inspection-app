// Server-side write guard for external (1099) users — SERVER-ONLY.
//
// Use in every inspection WRITE API route (save answers, submit, rate-card
// lines, finalize, QC finalize). For internal users it's a no-op with NO extra
// HubSpot read; for external users it loads the inspection's template + status
// and applies the single rule in lib/userAccess (1099 only, no editing once
// completed). Returns a 403 message, or null when allowed.

import { fetchInspectionById } from '@/lib/hubspot';
import { isExternalEmail, externalAccessDenial } from '@/lib/userAccess';

export async function externalWriteDenial(
  email: string | null | undefined,
  inspectionId: string,
): Promise<string | null> {
  if (!isExternalEmail(email)) return null; // internal users: unrestricted, no fetch
  const insp = await fetchInspectionById(inspectionId);
  if (!insp) return null; // not found → let the endpoint return its own 404
  return externalAccessDenial(email, insp.templateType, { write: true, status: insp.status });
}
