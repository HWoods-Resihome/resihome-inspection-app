// Server-only client for the ResiCap/Ameritrust "Maintenance AI Workflow" API.
//
// Used by the Scope Rate Card finalize flow (best-effort — never blocks
// finalize) and by the admin test button to create a maintenance TICKET on the
// property tied to a completed inspection. Credentials/host come from env so
// nothing is hardcoded:
//   MAINTENANCE_AI_API_KEY      — the x-api-key issued for our integration
//   MAINTENANCE_AI_BASE_URL     — default https://hbmm-admin-int.resicapdev.com (dev/int)
//   MAINTENANCE_AI_API_VERSION  — default v1
// If the API key is missing, calls no-op with configured:false so finalize keeps
// working before the env is set.
//
// API doc: "Maintenance AI Workflow - API Document - Version 2.0".
// Endpoint used: POST /api/external/{apiVersion}/ticket

import { VENDORS, vendorGetsOwnPdf } from '@/lib/vendors';

// ---- Defaults (documented reference-data IDs; "subject to change" per the doc) ----
// 4.3 Priority: 777 = Medium. 4.2 Category: 23 = Unit Turns (Paint/Clean/Minor
// Repairs). 4.5 Location: 23 = Whole House. 4.6 Timeslot: 3110 = 10am–12pm.
// Ticket Type: 1828 = Turnkey. Overridable via MAINTENANCE_AI_TICKET_TYPE_ID in
// case the reference data changes (no redeploy needed).
export const TICKET_PRIORITY_MEDIUM = 777;
export const TICKET_CATEGORY_UNIT_TURNS = 23;
export const TICKET_LOCATION_WHOLE_HOUSE = 23;
export const TICKET_TYPE_TURNKEY =
  Number(process.env.MAINTENANCE_AI_TICKET_TYPE_ID) || 1828;
const APPOINTMENT_TIMESLOT = 3110;
// Appointments are required + must be in the future + must differ. We place two
// placeholder windows 3 and 5 days out from the ticket-creation date.
const APPOINTMENT_1_OFFSET_DAYS = 3;
const APPOINTMENT_2_OFFSET_DAYS = 5;

// The fixed intro that leads the ticket description (per Hayden, 2026-06).
export const TICKET_DESCRIPTION_INTRO =
  'Please review the attached Scope of Work in the Vendor Documents and URL, and complete all assigned items. ' +
  'Scope pricing is pre-approved, so work may begin immediately upon acceptance. ' +
  'Any change orders must be submitted and approved before work is performed. ' +
  'SLA is $500 per day, upon completion, upload clear final photos and submit completion. ' +
  'Orders without adequate final photos will be rejected, and incomplete items may be returned as warranty work if photo documentation is not provided.';

const DESCRIPTION_MAX = 8000;

/**
 * Build the human-facing ticket URL for a created ticket. Template is env-driven
 * (so dev/stage/prod can differ) with a {ticketId} placeholder; defaults to the
 * HoneyBadger production format. Returns null if there's no ticket id.
 */
export function buildTicketUrl(ticketId: number | null | undefined): string | null {
  if (ticketId == null) return null;
  const tmpl = (process.env.MAINTENANCE_AI_TICKET_URL_TEMPLATE
    || 'https://honeybadgermm.com/Maintenance#/EditTicket/{ticketId}').trim();
  return tmpl.replace('{ticketId}', String(ticketId));
}

export interface CreateTicketResult {
  ok: boolean;
  configured: boolean;
  ticketId?: number;
  /** HTTP status from the API (when a request was made). */
  status?: number;
  /** The x-request-id GUID we sent (for support/idempotency tracing). */
  requestId?: string;
  error?: string;
}

/**
 * Build the ticket description: the fixed intro, then a list of per-vendor scope
 * document links. Eviction vendors are excluded (same as the email / per-vendor
 * PDF rules). `vendorUrls` is a map of vendorName -> PDF url.
 */
export function buildTicketDescription(vendorUrls: Record<string, string>, masterUrl?: string | null): string {
  // Order links by the canonical VENDORS list so output is stable, then append
  // any extra vendors not in the list. Skip eviction vendors.
  const present = Object.keys(vendorUrls || {});
  const ordered = [
    ...VENDORS.filter((v) => present.includes(v)),
    ...present.filter((v) => !VENDORS.includes(v)),
  ];
  const links: string[] = [];
  // Master report goes first.
  if (masterUrl && masterUrl.trim()) links.push(`Master: ${masterUrl}`);
  for (const v of ordered) {
    if (vendorGetsOwnPdf(v) && (vendorUrls[v] || '').trim()) links.push(`${v}: ${vendorUrls[v]}`);
  }

  const parts = [TICKET_DESCRIPTION_INTRO];
  if (links.length > 0) {
    // One "Label: URL" line each (e.g. "Master: …", "Internal Resolution: …", "Vendor 1: …").
    parts.push('', ...links);
  }
  const out = parts.join('\n');
  return out.length > DESCRIPTION_MAX ? out.slice(0, DESCRIPTION_MAX) : out;
}

/** Format a Date as MM-DD-YYYY (en-US), the format the ticket API expects. */
function formatDateMMDDYYYY(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${mm}-${dd}-${yyyy}`;
}

function genRequestId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // RFC4122-ish fallback
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export interface CreateTicketInput {
  /** Numeric Property ID in the Maintenance system (hbmm_property_id). */
  propertyId: number;
  /** Full description text (intro + links). Use buildTicketDescription(). */
  description: string;
  /** Overrides (default to the documented Medium / Unit Turns / Whole House / Turnkey). */
  priorityId?: number;
  categoryIds?: number[];
  locationId?: number;
  ticketTypeId?: number;
}

/**
 * Create a maintenance ticket. Never throws — returns a result object the caller
 * can surface (finalize logs/response or the admin test button).
 */
export async function createMaintenanceTicket(input: CreateTicketInput): Promise<CreateTicketResult> {
  const apiKey = (process.env.MAINTENANCE_AI_API_KEY || '').trim();
  const baseUrl = (process.env.MAINTENANCE_AI_BASE_URL || 'https://hbmm-admin-int.resicapdev.com').trim().replace(/\/+$/, '');
  const version = (process.env.MAINTENANCE_AI_API_VERSION || 'v1').trim();

  if (!apiKey) {
    return { ok: false, configured: false, error: 'Maintenance AI not configured (set MAINTENANCE_AI_API_KEY).' };
  }
  if (!input.propertyId || !Number.isFinite(input.propertyId)) {
    return { ok: false, configured: true, error: 'Missing/invalid propertyId (hbmm_property_id not set on the property).' };
  }

  const now = new Date();
  const d1 = new Date(now); d1.setDate(d1.getDate() + APPOINTMENT_1_OFFSET_DAYS);
  const d2 = new Date(now); d2.setDate(d2.getDate() + APPOINTMENT_2_OFFSET_DAYS);

  const body = {
    propertyId: input.propertyId,
    ticketTypeId: input.ticketTypeId ?? TICKET_TYPE_TURNKEY,
    priorityId: input.priorityId ?? TICKET_PRIORITY_MEDIUM,
    categoryIds: input.categoryIds ?? [TICKET_CATEGORY_UNIT_TURNS],
    description: input.description,
    locationId: input.locationId ?? TICKET_LOCATION_WHOLE_HOUSE,
    appointmentDate1: formatDateMMDDYYYY(d1),
    appointmentTimeslot1: APPOINTMENT_TIMESLOT,
    appointmentDate2: formatDateMMDDYYYY(d2),
    appointmentTimeslot2: APPOINTMENT_TIMESLOT,
  };

  const requestId = genRequestId();
  try {
    const resp = await fetch(`${baseUrl}/api/external/${version}/ticket`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'x-request-id': requestId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const status = resp.status;
    let json: any = null;
    try { json = await resp.json(); } catch { /* non-JSON body */ }

    if (resp.ok) {
      const ticketId = json?.data?.ticketId;
      return { ok: true, configured: true, status, requestId, ticketId: typeof ticketId === 'number' ? ticketId : undefined };
    }

    // 202 = idempotency replay/in-progress; treat as non-fatal but not "ok".
    const msg = json?.errorMessage
      || (Array.isArray(json?.validationErrors) ? json.validationErrors.join('; ') : '')
      || `HTTP ${status}`;
    return { ok: false, configured: true, status, requestId, error: String(msg).slice(0, 300) };
  } catch (e: any) {
    return { ok: false, configured: true, requestId, error: String(e?.message || e).slice(0, 300) };
  }
}
