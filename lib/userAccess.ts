/**
 * Access control: internal staff vs. external (1099 leasing-agent) users.
 *
 * Internal users (the company's own domains) keep full access. External users —
 * any other email that's a valid HubSpot CONTACT — are limited to the 1099
 * Leasing Agent Property Inspection: they may start one, view 1099-type
 * inspections, but cannot touch any other template and cannot edit a completed
 * inspection.
 *
 * Role is derived from the email domain on every request (no session migration
 * needed). Enforced SERVER-SIDE in the API routes; the UI mirrors it for clarity.
 */
import type { TemplateType } from './types';

// Company domains that get full internal access. Extend here if a new internal
// domain is added.
export const INTERNAL_DOMAINS = ['resihome.com', 'resicap.com', 'resipro.com'];

// The only template an external user can create or open.
export const EXTERNAL_TEMPLATE: TemplateType = 'leasing_agent_1099_property_inspection';

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

/** Can an external user create/open this template? (Only the 1099 one.) */
export function externalCanUseTemplate(templateType: string | null | undefined): boolean {
  return String(templateType || '') === EXTERNAL_TEMPLATE;
}

/** Normalize a HubSpot status string to lowercase for completed checks. */
export function isCompletedStatus(status: string | null | undefined): boolean {
  const s = (status || '').trim().toLowerCase();
  return s === 'completed' || s === 'complete';
}

/**
 * The single rule for external-user access to an inspection. Returns a denial
 * REASON string (safe to surface) or null when allowed. Internal users are never
 * restricted. External users: only the 1099 template, and no edits once completed.
 * Call from every inspection read/write API route (server-side enforcement).
 */
export function externalAccessDenial(
  email: string | null | undefined,
  templateType: string | null | undefined,
  opts: { write?: boolean; status?: string | null } = {},
): string | null {
  if (!isExternalEmail(email)) return null; // internal = full access
  if (!externalCanUseTemplate(templateType)) {
    return 'Your account can only access 1099 Leasing Agent Property Inspections.';
  }
  if (opts.write && isCompletedStatus(opts.status)) {
    return 'Completed inspections are read-only for your account.';
  }
  return null;
}
