/**
 * Configuration & schema validation.
 *
 * Several failures in this app are silent in production: a missing HubSpot
 * property makes finalize fall back to a status-only write (no PDFs, no
 * approval stamp); a malformed *_TYPE_ID makes every CRM call fail; a missing
 * AI key disables a feature with no banner. This module checks the environment
 * and the live HubSpot schema up front so those problems surface in one place
 * (the /api/admin/config-check endpoint, and a boot warning) instead of as a
 * confusing runtime degradation.
 *
 * Read-only and dependency-free. Never throws — every check returns a result.
 */
import { resolvedTypeIds, listObjectPropertyNames } from '@/lib/hubspot';

export interface CheckItem {
  key: string;
  ok: boolean;
  level: 'required' | 'recommended';
  detail?: string;
}

export interface ConfigReport {
  ok: boolean;            // false if any REQUIRED check fails
  env: CheckItem[];
  schema: CheckItem[];
}

// ---- Environment variables -------------------------------------------------

// Absence breaks core flows (auth, every HubSpot call).
const REQUIRED_ENV: { key: string; detail: string; alt?: string }[] = [
  { key: 'HUBSPOT_TOKEN', alt: 'HUBSPOT_SANDBOX_TOKEN', detail: 'HubSpot Private App token (pat-…) — backbone for all CRM reads/writes.' },
  { key: 'HUBSPOT_INSPECTION_TYPE_ID', detail: 'Inspection custom-object type id.' },
  { key: 'HUBSPOT_INSPECTION_QUESTION_TYPE_ID', detail: 'Question custom-object type id.' },
  { key: 'HUBSPOT_INSPECTION_ANSWER_TYPE_ID', detail: 'Answer custom-object type id.' },
  { key: 'HUBSPOT_PROPERTY_TYPE_ID', detail: 'Property object type id.' },
  { key: 'SESSION_SECRET', detail: 'Signing secret for the auth session cookie.' },
];

// Absence disables a feature but the app still runs.
const RECOMMENDED_ENV: { key: string; detail: string }[] = [
  { key: 'ANTHROPIC_API_KEY', detail: 'AI scope review, voice assist, room scan.' },
  { key: 'VOYAGE_API_KEY', detail: 'Catalog semantic matching (voice/scan).' },
  { key: 'OPENAI_API_KEY', detail: 'Speech-to-text transcription.' },
  { key: 'BLOB_READ_WRITE_TOKEN', detail: 'AI usage, AI feedback, and offline-photo blobs.' },
  { key: 'CRON_SECRET', detail: 'Auth for the SFTP-watch and blob-cleanup crons.' },
  { key: 'HUBSPOT_RATE_CARD_LINE_ITEM_TYPE_ID', detail: 'Rate-card line item type id (else resolved by schema lookup).' },
  { key: 'HUBSPOT_REGION_RATE_TYPE_ID', detail: 'Region-rate type id (else resolved by schema lookup).' },
  { key: 'GMAIL_CLIENT_ID', detail: 'Sending the finalize email via the inspector’s Gmail.' },
  { key: 'MAINTENANCE_AI_API_KEY', detail: 'Auto-creating the maintenance ticket on finalize.' },
];

function envPresent(key: string): boolean {
  const v = process.env[key];
  return !!(v && v.trim().length > 0);
}

export function validateEnv(): CheckItem[] {
  const items: CheckItem[] = [];

  for (const e of REQUIRED_ENV) {
    const ok = envPresent(e.key) || (e.alt ? envPresent(e.alt) : false);
    let detail = e.detail;
    // HubSpot token shape sanity (the lib throws on these at call time; surface early).
    if (ok && e.key === 'HUBSPOT_TOKEN') {
      const raw = (process.env.HUBSPOT_TOKEN || process.env.HUBSPOT_SANDBOX_TOKEN || '').trim();
      if (!raw.startsWith('pat-')) detail = `Set but doesn't start with "pat-" — re-paste the Private App token. ${detail}`;
    }
    items.push({ key: e.alt ? `${e.key} (or ${e.alt})` : e.key, ok, level: 'required', detail: ok ? undefined : detail });
  }

  for (const e of RECOMMENDED_ENV) {
    const ok = envPresent(e.key);
    items.push({ key: e.key, ok, level: 'recommended', detail: ok ? undefined : e.detail });
  }

  return items;
}

// ---- HubSpot inspection-object schema --------------------------------------

// Properties the lifecycle endpoints WRITE. Absence makes finalize/qc/submit
// silently degrade (PROPERTY_DOESNT_EXIST → status-only fallback), so a fresh
// or drifted portal can complete inspections with no PDFs or approval stamp.
// Verified against finalize.ts / qc-finalize.ts / submit.ts.
const REQUIRED_INSPECTION_PROPS = [
  'status',
  'completed_at',
  'submitted_by_email',
  'submitted_at',
  'approved_by_name',
  'approved_at',
  'total_vendor_cost',
  'total_client_cost',
  'total_tenant_cost',
  'pdf_master_url',
  'pdf_generated_at',
  'section_list_json',
];

// Used by a feature/template; warn (not fail) if missing.
const RECOMMENDED_INSPECTION_PROPS = [
  'pdf_chargeback_url',
  'pdf_vendor_urls_json',
  'pdf_chargeback_xlsx_url',
  'pdf_attachment_url',
  'qc_verdict',
  'qc_pass_count',
  'qc_fail_count',
  'inspection_result',
  'hbmm_ticket_id',
  'finalize_email_sent_at',
  'sftp_import_result',
  'link_master',
  'link_chargeback',
  'link_xlsx',
];

export async function validateSchema(): Promise<CheckItem[]> {
  const items: CheckItem[] = [];

  let inspectionTypeId: string;
  try {
    inspectionTypeId = resolvedTypeIds().inspection;
    items.push({ key: 'HubSpot type IDs resolve', ok: true, level: 'required' });
  } catch (e: any) {
    items.push({ key: 'HubSpot type IDs resolve', ok: false, level: 'required', detail: String(e?.message || e).slice(0, 200) });
    return items; // can't check properties without the type id
  }

  let names: Set<string>;
  try {
    names = new Set(await listObjectPropertyNames(inspectionTypeId));
    items.push({ key: 'HubSpot reachable (inspection schema read)', ok: true, level: 'required', detail: `${names.size} properties` });
  } catch (e: any) {
    items.push({ key: 'HubSpot reachable (inspection schema read)', ok: false, level: 'required', detail: String(e?.message || e).slice(0, 200) });
    return items;
  }

  const missingReq = REQUIRED_INSPECTION_PROPS.filter((p) => !names.has(p));
  items.push({
    key: 'Required inspection properties',
    ok: missingReq.length === 0,
    level: 'required',
    detail: missingReq.length ? `Missing: ${missingReq.join(', ')} — finalize will silently drop these writes.` : undefined,
  });

  const missingRec = RECOMMENDED_INSPECTION_PROPS.filter((p) => !names.has(p));
  if (missingRec.length) {
    items.push({
      key: 'Optional inspection properties',
      ok: false,
      level: 'recommended',
      detail: `Missing: ${missingRec.join(', ')} — the related feature/template degrades gracefully.`,
    });
  }

  return items;
}

/** Full report: env + live schema. ok=false if any REQUIRED check fails. */
export async function validateConfig(): Promise<ConfigReport> {
  const env = validateEnv();
  const schema = await validateSchema();
  const ok = [...env, ...schema].every((c) => c.level !== 'required' || c.ok);
  return { ok, env, schema };
}

/**
 * Boot-time warning: log any failing REQUIRED env check the first time the
 * server module loads. Cheap (no network) and idempotent — env-only so it's
 * safe to run synchronously at import. The schema check stays on-demand
 * (it needs a HubSpot round-trip) via /api/admin/config-check.
 */
let warned = false;
export function warnOnBootIfMisconfigured(): void {
  if (warned) return;
  warned = true;
  try {
    const failing = validateEnv().filter((c) => c.level === 'required' && !c.ok);
    if (failing.length) {
      console.warn(`[config] ${failing.length} required env var(s) missing/invalid: ` +
        failing.map((c) => c.key).join(', ') + ' — see /api/admin/config-check.');
    }
  } catch { /* never block boot */ }
}
