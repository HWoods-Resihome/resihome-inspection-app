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

// Specific addresses on OUTSIDE domains that should nonetheless be treated as
// internal employees (full access to every template, not just 1099 walks) — e.g.
// an internal staffer who signs in with a personal Google account. Compared
// case-insensitively. Keep this short and explicit.
export const INTERNAL_EMAIL_ALLOWLIST = new Set<string>([
  'romack.dustin@gmail.com',
]);

function domainOf(email: string | null | undefined): string {
  const e = (email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  return at >= 0 ? e.slice(at + 1) : '';
}

export function isInternalEmail(email: string | null | undefined): boolean {
  const e = (email || '').trim().toLowerCase();
  if (INTERNAL_EMAIL_ALLOWLIST.has(e)) return true;
  return INTERNAL_DOMAINS.includes(domainOf(e));
}

/**
 * Belongs to a company Google Workspace DOMAIN — i.e. can authenticate against
 * the main "Internal" user-type Google OAuth app.
 *
 * This is DELIBERATELY domain-only and does NOT honor INTERNAL_EMAIL_ALLOWLIST:
 * a personal address (e.g. a gmail) physically cannot sign into a Workspace-
 * Internal OAuth app — Google returns "403 org_internal" before the app is ever
 * reached. So allowlisted outside-domain staff are INTERNAL for permissions
 * (isInternalEmail) but must still authenticate through the External identity
 * OAuth app. Use THIS for picking the OAuth app/provider; use isInternalEmail
 * for what the signed-in user may see and do.
 */
export function isWorkspaceDomainEmail(email: string | null | undefined): boolean {
  return INTERNAL_DOMAINS.includes(domainOf(email));
}

// Templates an external user can CREATE and EDIT (own, until completed).
export const EXTERNAL_EDIT_TEMPLATES: TemplateType[] = ['leasing_agent_1099_property_inspection'];
// Templates an external user can VIEW (read + completed PDF) but never edit —
// and only when COMPLETED. They never see non-completed records of these types.
export const EXTERNAL_VIEW_TEMPLATES: TemplateType[] = ['pm_scope_rate_card', 'pm_turn_reinspect_qc'];
// The single template an external user may create/open for editing. Kept for
// back-compat (login hint, the new-inspection picker, /api/auth/me).
export const EXTERNAL_TEMPLATE: TemplateType = EXTERNAL_EDIT_TEMPLATES[0];

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

// Property statuses at which an EXTERNAL (1099) user may START a 1099 walk. The
// Turn must be done and the property moved to a leasing status first. Matched
// case-insensitively, tolerant of spacing.
const EXTERNAL_1099_ALLOWED_STATUSES = new Set([
  'vacant - pre-leasing',
  'vacant - on market',
]);

/** True when an external user may create a 1099 against a property in this
 *  status (Vacant - Pre-Leasing / Vacant - On Market). Internal users are
 *  unrestricted, so callers should only apply this for external users. */
export function externalCanCreate1099ForStatus(status: string | null | undefined): boolean {
  const s = (status || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return EXTERNAL_1099_ALLOWED_STATUSES.has(s);
}

/** The message shown when an external user tries to start a 1099 on a property
 *  whose status isn't yet a leasing status. */
export const EXTERNAL_1099_STATUS_BLOCK_MSG =
  'Please wait until the Turn is completed and the property status is moved to On-Market to walk the property.';

/**
 * The state that prefixes a region value. Regions are stored as
 * "<STATE>: <City>" (e.g. "GA: Atlanta", "FL: Tampa"); the part before the
 * first colon is the state code. Upper-cased and trimmed; '' for a blank
 * region. External users' view access is unlocked one state at a time, so this
 * is how we group a region into its state.
 */
export function stateOfRegion(region: string | null | undefined): string {
  const r = (region || '').trim();
  if (!r) return '';
  const i = r.indexOf(':');
  return (i >= 0 ? r.slice(0, i) : r).trim().toUpperCase();
}

/** Denial message when an external user opens a completed Scope/Re-Inspect in a
 *  state they haven't unlocked yet (no inspection of their own there). */
export const EXTERNAL_VIEW_STATE_BLOCK_MSG =
  'You can only view inspections in states where you have an assigned inspection.';

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
 *   - READ: any 1099, plus COMPLETED Scope Rate Card / Re-Inspect (view + PDF) —
 *     but only in STATES the user has unlocked by having an inspection of their
 *     own there (see `unlockedStates`).
 *
 * Call from every inspection read/write API route (server-side enforcement).
 */
export function externalAccessDenial(
  email: string | null | undefined,
  templateType: string | null | undefined,
  opts: {
    write?: boolean;
    status?: string | null;
    ownerEmail?: string | null;
    // For the READ gate on view-only (Scope/Re-Inspect) types: the inspection's
    // region and the set of state codes the user has unlocked. When
    // `unlockedStates` is provided (an array — possibly empty), a completed
    // Scope/Re-Inspect is visible only if its region's state is in the set.
    // Omit (undefined) to skip the state gate (back-compat / 1099-only callers).
    region?: string | null;
    unlockedStates?: string[] | null;
  } = {},
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
  // State gate for the view-only types (Scope/Re-Inspect). Their OWN 1099s
  // (edit templates) are never state-gated. A completed Scope/Re-Inspect is
  // visible only in a state the user has unlocked. `unlockedStates` undefined →
  // gate not applied (callers that don't supply it keep the prior behavior).
  if (!externalCanEditTemplate(templateType) && Array.isArray(opts.unlockedStates)) {
    const st = stateOfRegion(opts.region);
    if (!st || !opts.unlockedStates.includes(st)) return EXTERNAL_VIEW_STATE_BLOCK_MSG;
  }
  return null;
}
