// Server-side write guard for external (1099) users — SERVER-ONLY.
//
// Use in every inspection WRITE API route (save answers, submit, rate-card
// lines, finalize, QC finalize). For internal users it's a no-op with NO extra
// HubSpot read; for external users it loads the inspection's template + status
// and applies the single rule in lib/userAccess (1099 only, no editing once
// completed). Returns a 403 message, or null when allowed.

import { fetchInspectionById, externalUnlockedView, findVendorForAuth } from '@/lib/hubspot';
import { isExternalEmail, externalAccessDenial, externalCanEditTemplate, ownsInspection } from '@/lib/userAccess';
import { inspectionAccessLevel, type InspectionAccessLevel } from '@/lib/userManagement';
import { recordErrorEvent } from '@/lib/errorLog';

const NO_ACCESS_MSG = 'Your account does not have Inspections access.';

/** A vendor COMPANY's inspections level (null = this email isn't a vendor):
 *    'none'    — no Inspections app,
 *    'limited' — every template type, but ONLY inspections assigned to them,
 *    'full'    — unrestricted, like an internal user.
 *  Backed by the 60s-cached auth lookup, so per-request gating stays cheap. */
export async function vendorInspectionLevel(email: string | null | undefined): Promise<InspectionAccessLevel | null> {
  if (!isExternalEmail(email)) return null;   // internal users don't need it
  const v = await findVendorForAuth(email).catch(() => null);
  if (!v) return null;
  if (!v.inspectionAccess) return 'none';
  return v.inspectionFull ? 'full' : 'limited';
}

/** Back-compat: any vendor inspections access at all (limited or full). */
export async function vendorInspectionAccess(email: string | null | undefined): Promise<boolean> {
  const lvl = await vendorInspectionLevel(email);
  return lvl === 'limited' || lvl === 'full';
}

/** The effective inspections level for ANY email: vendor company level when
 *  it's a vendor, else the per-user level from User Management (internal
 *  defaults to full, external to limited — both overridable, so an internal or
 *  allowlisted user set to Limited genuinely gets the 1099-style rules). The
 *  override map is cached 60s, so the fast path (full) stays cheap. */
async function externalLevel(email: string | null | undefined): Promise<{ level: InspectionAccessLevel; vendor: boolean }> {
  const vLvl = await vendorInspectionLevel(email);
  if (vLvl !== null) return { level: vLvl, vendor: true };
  return { level: await inspectionAccessLevel(email).catch(() => isExternalEmail(email) ? 'limited' as const : 'full' as const), vendor: false };
}

export async function externalWriteDenial(
  email: string | null | undefined,
  inspectionId: string,
): Promise<string | null> {
  const { level, vendor } = await externalLevel(email);
  if (level === 'full') return null;   // FULL access = unrestricted, like internal
  if (level === 'none') return NO_ACCESS_MSG;
  const insp = await fetchInspectionById(inspectionId);
  if (!insp) return null; // not found → let the endpoint return its own 404
  // LIMITED vendor: every template type is editable, but ONLY their own
  // assigned work — fail closed on a blank inspector.
  if (vendor) {
    if (!(insp.inspectorEmail || '').trim() || !ownsInspection(email, insp.inspectorEmail)) {
      return 'You can only edit inspections assigned to you.';
    }
    return null;
  }
  // LIMITED 1099 user: the classic rule (own 1099 template only).
  const denial = externalAccessDenial(email, insp.templateType, { write: true, status: insp.status, ownerEmail: insp.inspectorEmail });
  if (denial) {
    // Capture the exact mismatch for the Admin Error Log — this is what turns an
    // "I can't edit my own inspection" report into a one-look diagnosis: the
    // signed-in email vs. the inspection's stored inspector_email.
    void recordErrorEvent({
      kind: 'write_denied',
      message: denial,
      email: email || undefined,
      inspectionId,
      template: insp.templateType,
      status: insp.status || undefined,
      source: 'server',
      meta: { storedInspectorEmail: insp.inspectorEmail || '(blank)' },
    });
  }
  return denial;
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
  const { level, vendor } = await externalLevel(email);
  if (level === 'full') return null;   // FULL access = unrestricted, like internal
  if (level === 'none') return NO_ACCESS_MSG;
  const insp = await fetchInspectionById(inspectionId);
  if (!insp) return null; // not found → let the endpoint return its own 404
  // LIMITED vendor: may view any template type of THEIR OWN work.
  if (vendor) {
    return ownsInspection(email, insp.inspectorEmail) ? null : 'You can only view inspections assigned to you.';
  }
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
  const { level, vendor } = await externalLevel(email);
  if (level === 'full') return null;   // FULL access = unrestricted, like internal
  if (level === 'none') return NO_ACCESS_MSG;
  const insp = await fetchInspectionById(inspectionId);
  if (!insp) return null; // not found → let the endpoint return its own 404
  // LIMITED vendor: all template types (ownership still applies below).
  if (!vendor && !externalCanEditTemplate(insp.templateType)) {
    return 'Your account has view-only access to this inspection type.';
  }
  if (!(insp.inspectorEmail || '').trim() || !ownsInspection(email, insp.inspectorEmail)) {
    return 'You can only generate PDFs for your own inspections.';
  }
  return null;
}
