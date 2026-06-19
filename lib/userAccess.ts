/**
 * Access control: internal staff vs. external (1099 leasing-agent) users.
 *
 * Internal users (the company's own domains) keep full access. External users —
 * any other email that's a valid HubSpot CONTACT — get:
 *   - FULL access to the 1099 Leasing Agent Property Inspection: create one,
 *     view any 1099, edit/cancel the ones they OWN (never once completed).
 *   - VIEW-ONLY access to COMPLETED Scope Rate Card and Re-Inspect inspections:
 *     they can open them and view the completed PDFs, but cannot create, edit,
 *     re-open, or cancel them, and never see non-completed ones.
 *   - No access to any other template.
 *
 * Role is derived from the email domain on every request (no session migration
 * needed). Enforced SERVER-SIDE in the API routes; the UI mirrors it for clarity.
 */
import type { TemplateType } from './types';

// Company domains that get full internal access. Extend here if a new internal
// domain is added.
export const INTERNAL_DOMAINS = ['resihome.com', 'resicap.com', 'resipro.com'];

// Templates an external user can CREATE and EDIT (own, until completed).
export const EXTERNAL_EDIT_TEMPLATES: TemplateType[] = ['leasing_agent_1099_property_inspection'];
// Templates an external user can VIEW (read + completed PDF) but never edit —
// and only when COMPLETED. They never see non-completed records of these types.
export const EXTERNAL_VIEW_TEMPLATES: TemplateType[] = ['pm_scope_rate_card', 'pm_turn_reinspect_qc'];
// The single template an external user may create/open for editing. Kept for
// back-compat (login hint, the new-inspection picker, /api/auth/me).
export const EXTERNAL_TEMPLATE: TemplateType = EXTERNAL_EDIT_TEMPLATES[0];

function domainOf(email: string | null | undefined): string {
  const e = (email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  return at >= 0 ? e.slice(at + 1) : '';
}

export function isInternalEmail(email: string | null | undefined): boolean {
  return INTERNAL_DOMAINS.includes(domainOf(email));
}

/** External = a valid signed-in user whose email is NOT an internal domain. */
export function isExternalEmail(email: string | null | undefined): boolean {
  const e = (email || '').trim();
  return !!e && e.includes('@') && !isInternalEmail(e);
}

/** Can an external user create/edit this template? (Only the 1099 one.) */
export function externalCanEditTemplate(templateType: string | null | undefined): boolean {
  return EXTERNAL_EDIT_TEMPLATES.includes(String(templateType || '') as TemplateType);
}

/** Back-compat alias — "use" historically meant create/edit (the 1099 template). */
export function externalCanUseTemplate(templateType: string | null | undefined): boolean {
  return externalCanEditTemplate(templateType);
}

/**
 * Can an external user VIEW this inspection? The 1099 template at any status,
 * plus Scope Rate Card / Re-Inspect when (and only when) COMPLETED.
 */
export function externalCanViewTemplate(
  templateType: string | null | undefined,
  status: string | null | undefined,
): boolean {
  if (externalCanEditTemplate(templateType)) return true;
  if (EXTERNAL_VIEW_TEMPLATES.includes(String(templateType || '') as TemplateType)) {
    return isCompletedStatus(status);
  }
  return false;
}

/** Normalize a HubSpot status string to lowercase for completed checks. */
export function isCompletedStatus(status: string | null | undefined): boolean {
  const s = (status || '').trim().toLowerCase();
  return s === 'completed' || s === 'complete';
}

/**
 * Does this email own the inspection (i.e. is the recorded inspector)?
 * Case-insensitive. When the owner is unknown (blank inspector_email), returns
 * true — we can't prove non-ownership, so we don't lock out legacy/blank-field
 * inspections. New external-created 1099s stamp the creator, so this only
 * affects pre-existing records.
 */
export function ownsInspection(email: string | null | undefined, ownerEmail: string | null | undefined): boolean {
  const owner = (ownerEmail || '').trim().toLowerCase();
  if (!owner) return true; // unknown owner → don't restrict
  return (email || '').trim().toLowerCase() === owner;
}

/**
 * The single rule for external-user access to an inspection. Returns a denial
 * REASON string (safe to surface) or null when allowed. Internal users are never
 * restricted.
 *
 * External users:
 *   - WRITE (create/edit/re-open/cancel/submit): only the 1099 template, only
 *     ones they OWN, and never once completed. Scope/Re-Inspect are view-only.
 *   - READ: any 1099, plus COMPLETED Scope Rate Card / Re-Inspect (view + PDF).
 *
 * Call from every inspection read/write API route (server-side enforcement).
 */
export function externalAccessDenial(
  email: string | null | undefined,
  templateType: string | null | undefined,
  opts: { write?: boolean; status?: string | null; ownerEmail?: string | null } = {},
): string | null {
  if (!isExternalEmail(email)) return null; // internal = full access

  if (opts.write) {
    // Writes are confined to the 1099 template; Scope/Re-Inspect are view-only.
    if (!externalCanEditTemplate(templateType)) {
      return 'Your account has view-only access to this inspection type.';
    }
    if (isCompletedStatus(opts.status)) {
      return 'Completed inspections are read-only for your account.';
    }
    // Ownership: external users may only edit/cancel their OWN inspections.
    if (!ownsInspection(email, opts.ownerEmail)) {
      return 'You can only edit or cancel your own inspections.';
    }
    return null;
  }

  // Read access.
  if (!externalCanViewTemplate(templateType, opts.status)) {
    if (EXTERNAL_VIEW_TEMPLATES.includes(String(templateType || '') as TemplateType)) {
      // A Scope/Re-Inspect that isn't completed yet.
      return 'You can only view completed Scope Rate Card or Re-Inspect inspections.';
    }
    return 'Your account can only access 1099 Leasing Agent Property Inspections.';
  }
  return null;
}
