// Server-side write guard for external (1099) users — SERVER-ONLY.
//
// Use in every inspection WRITE API route (save answers, submit, rate-card
// lines, finalize, QC finalize). For internal users it's a no-op with NO extra
// HubSpot read; for external users it loads the inspection's template + status
// and applies the single rule in lib/userAccess (1099 only, no editing once
// completed). Returns a 403 message, or null when allowed.

import { fetchInspectionById, externalUnlockedView } from '@/lib/hubspot';
import { isExternalEmail, externalAccessDenial, externalCanEditTemplate, ownsInspection } from '@/lib/userAccess';

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

/**
 * OWNERSHIP write guard for routes that MUTATE a record while only nominally
 * "viewing" it — specifically /api/pdf, which generates+stores a report PDF
 * (pdf_attachment_url, link_report, an attached note) on the given inspection.
 * The READ guard (externalViewDenial) allows viewing ANY 1099, so using it there
 * let an external user overwrite ANOTHER user's report. This requires the
 * external user to OWN the 1099 (fail-closed on a blank owner) — but, unlike the
 * generic write guard, does NOT block a completed status, because generating your
 * OWN completed 1099's report is legitimate. Internal users: no-op, no fetch.
 */
export async function externalOwnedWriteDenial(
  email: string | null | undefined,
  inspectionId: string,
): Promise<string | null> {
  if (!isExternalEmail(email)) return null;
  const insp = await fetchInspectionById(inspectionId);
  if (!insp) return null; // not found → let the endpoint return its own 404
  if (!externalCanEditTemplate(insp.templateType)) {
    return 'Your account has view-only access to this inspection type.';
  }
  if (!(insp.inspectorEmail || '').trim() || !ownsInspection(email, insp.inspectorEmail)) {
    return 'You can only generate PDFs for your own inspections.';
  }
  return null;
}
