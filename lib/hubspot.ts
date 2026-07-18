// HubSpot API client. SERVER-SIDE ONLY -- never import in client code.

import { AsyncLocalStorage } from 'node:async_hooks';
import { put } from '@vercel/blob';
import type { Question, Property, HubSpotUser, InspectionSummary } from './types';
import type { ServiceRecord, ServiceStatus } from './services/model';
import type { Worktype } from './services/worktypes';
import { isInternalResolution } from './vendors';
import { buildSectionPhotoAnswerProps, joinPhotoUrls, PHOTO_URL_DELIMITER } from './answerProps';
import { extractLeasingAgent1099Fields } from './leasingAgent1099';
import { parseFcAnswers, finalChecklistPhotos, remapFcAnswerUrls } from './finalChecklist';
import { calculateLine, roundMoney } from './rateCardMath';
import { EXTERNAL_EDIT_TEMPLATES, EXTERNAL_VIEW_TEMPLATES, stateOfRegion, isExternalEmail } from './userAccess';
import { normalizeApprovalRouting, type ApprovalRoutingConfig } from './approvalRouting';
import { rejectedPropNames } from './hubspotErrors';
import { isVendorPasswordSet } from './vendorPassword';
import { reportServerError } from './serverErrorReporter';
import { SERVICE_OBJECTS, QUESTION_ADDITIONS, SERVICE_ASSOCIATIONS, type PropSpec, type ObjectSpec } from './services/schemaSpec';

const API_BASE = 'https://api.hubapi.com';

// HubSpot is moving from semantic versions (v3/v4) to date-based versioning.
// Per the May 2026 changelog, v4 endpoints become unsupported on Mar 30, 2027.
// Their recommended replacement is /2026-03/.
//
// We centralize the date-based version here so future bumps are one-line.
// Endpoints that still use v3 (objects/properties/files/search) are kept on v3
// because they are not in the immediate deprecation set; the playbook explicitly
// supports a hybrid approach. See: https://developers.hubspot.com/blog/date-based-api-versioning-migration-playbook
const HUBSPOT_API_VERSION = '2026-03';

// Path builders for the date-based associations endpoints.
const assocBatchCreateUrl = (fromType: string, toType: string) =>
  `/crm/associations/${HUBSPOT_API_VERSION}/${fromType}/${toType}/batch/create`;
const assocLabelsUrl = (fromType: string, toType: string) =>
  `/crm/associations/${HUBSPOT_API_VERSION}/${fromType}/${toType}/labels`;

function token(): string {
  // Prefer HUBSPOT_TOKEN (production-friendly name); fall back to the original
  // HUBSPOT_SANDBOX_TOKEN so existing sandbox envs keep working unchanged.
  const raw = process.env.HUBSPOT_TOKEN || process.env.HUBSPOT_SANDBOX_TOKEN;
  if (!raw) {
    throw new Error(
      'HUBSPOT_TOKEN (or HUBSPOT_SANDBOX_TOKEN) is not set. Add it to the environment ' +
      '(e.g. HUBSPOT_TOKEN=pat-na1-...) and restart.'
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error('HUBSPOT_SANDBOX_TOKEN is empty or all whitespace. Re-paste the token in .env.local.');
  }
  if (trimmed.includes('<') || trimmed.includes('>') || trimmed.toUpperCase().includes('PASTE')) {
    throw new Error(
      'HUBSPOT_SANDBOX_TOKEN still contains placeholder text like <PASTE_YOUR_PAT_TOKEN_HERE>. ' +
      'Open .env.local and replace the placeholder with your real pat-na1-... token.'
    );
  }
  if (!trimmed.startsWith('pat-')) {
    throw new Error(
      `HUBSPOT_SANDBOX_TOKEN doesn't start with "pat-" (it starts with "${trimmed.slice(0, 8)}..."). ` +
      'Re-paste your Private App token from HubSpot. It should look like pat-na1-XXXXXXXX.'
    );
  }
  return trimmed;
}

// Custom-object type IDs are always "2-<digits>". It's an easy slip to paste
// just the digits into an env var (e.g. "10767494" instead of "2-10767494"),
// which makes HubSpot reject the request with "Unable to infer object type
// from: <digits>". Restore the prefix so a bare numeric id still works.
function normalizeTypeId(v?: string): string | undefined {
  const s = (v || '').trim();
  if (!s) return undefined;
  return /^\d+$/.test(s) ? `2-${s}` : s;
}

function typeIds() {
  const inspection = normalizeTypeId(process.env.HUBSPOT_INSPECTION_TYPE_ID);
  const question = normalizeTypeId(process.env.HUBSPOT_INSPECTION_QUESTION_TYPE_ID);
  const answer = normalizeTypeId(process.env.HUBSPOT_INSPECTION_ANSWER_TYPE_ID);
  const property = normalizeTypeId(process.env.HUBSPOT_PROPERTY_TYPE_ID);
  if (!inspection || !question || !answer || !property) {
    throw new Error('One or more HUBSPOT_*_TYPE_ID env vars are missing. Check .env.local.');
  }
  return { inspection, question, answer, property };
}

// Rate Card object type IDs. Created by Phase 1 scripts.
// We resolve once and cache in-memory; the values don't change at runtime.
let _rateCardTypeIds: { lineItem: string; regionRate: string } | null = null;

async function rateCardTypeIds(): Promise<{ lineItem: string; regionRate: string }> {
  if (_rateCardTypeIds) return _rateCardTypeIds;

  // 1) Prefer env vars (production-safe; explicit; avoids the schema lookup call).
  const envLineItem = normalizeTypeId(process.env.HUBSPOT_RATE_CARD_LINE_ITEM_TYPE_ID);
  const envRegionRate = normalizeTypeId(process.env.HUBSPOT_REGION_RATE_TYPE_ID);
  if (envLineItem && envRegionRate) {
    _rateCardTypeIds = { lineItem: envLineItem, regionRate: envRegionRate };
    return _rateCardTypeIds;
  }

  // 2) Fall back to schema lookup by name. Slightly slower (one extra API call
  //    the first time per server instance) but doesn't require env config.
  const schemas = await hubspotFetch('/crm/v3/schemas');
  const lineItem = (schemas.results || []).find((s: any) => s.name === 'rate_card_line_item');
  const regionRate = (schemas.results || []).find((s: any) => s.name === 'region_rate');
  if (!lineItem || !regionRate) {
    throw new Error(
      'Rate Card schemas not found in HubSpot. Run Phase 1 scripts first ' +
      '(phase1_step1 and phase1_step2). Missing: ' +
      [!lineItem && 'rate_card_line_item', !regionRate && 'region_rate'].filter(Boolean).join(', ')
    );
  }
  _rateCardTypeIds = {
    lineItem: lineItem.objectTypeId,
    regionRate: regionRate.objectTypeId,
  };
  return _rateCardTypeIds;
}

async function hubspotFetch(path: string, init: RequestInit = {}): Promise<any> {
  const url = `${API_BASE}${path}`;
  const method = init.method || 'GET';

  // Request governor: fail fast while the circuit breaker is open, and bound the
  // number of in-flight HubSpot calls per instance. HubSpot is the backbone for
  // ~100 concurrent inspectors; without this, a HubSpot incident lets requests
  // pile up unbounded (exhausting sockets/memory) and keeps hammering an API
  // that's already struggling. See hsAcquire / circuit-breaker helpers above.
  if (hsBreakerOpenUntil && Date.now() < hsBreakerOpenUntil) {
    const err = new Error('Upstream temporarily unavailable (circuit open)');
    (err as any).status = 503;
    throw err;
  }
  await hsAcquire();
  try {
    return await hubspotFetchInner(url, method, path, init);
  } finally {
    hsRelease();
  }
}

// ---- HubSpot request governor (per-instance) ------------------------------
// Two-tier concurrency cap. Foreground (user-facing) requests may use ALL slots;
// BACKGROUND work (insights rebuild, bulk backfills/regenerates, cron) is capped
// below the total so it can never consume every slot and starve live inspectors.
// Foreground waiters are always served before background ones.
const HS_MAX_CONCURRENT = Math.max(1, Number(process.env.HUBSPOT_MAX_CONCURRENT) || 8);
// Slots reserved for foreground: background may use at most (MAX - RESERVE).
const HS_FG_RESERVE = Math.max(1, Math.min(HS_MAX_CONCURRENT - 1, Number(process.env.HUBSPOT_FG_RESERVE) || 3));
const HS_BG_LIMIT = Math.max(1, HS_MAX_CONCURRENT - HS_FG_RESERVE);

// Marks a unit of work as "background" for the governor. Any hubspotFetch made
// (directly or transitively) inside the callback is throttled to the background
// lane — no need to thread a flag through every call site.
const hsPriority = new AsyncLocalStorage<'background'>();
export function runAsBackground<T>(fn: () => Promise<T>): Promise<T> {
  return hsPriority.run('background', fn);
}

let hsActive = 0;
const hsFgWaiters: Array<() => void> = [];
const hsBgWaiters: Array<() => void> = [];
async function hsAcquire(): Promise<void> {
  const bg = hsPriority.getStore() === 'background';
  const limit = bg ? HS_BG_LIMIT : HS_MAX_CONCURRENT;
  if (hsActive < limit) { hsActive++; return; }
  // No free slot in our lane — wait in the matching queue.
  await new Promise<void>((resolve) => (bg ? hsBgWaiters : hsFgWaiters).push(resolve));
}
function hsRelease(): void {
  // Foreground waiters first — transfer the freed slot directly (active unchanged).
  const fg = hsFgWaiters.shift();
  if (fg) { fg(); return; }
  // No foreground waiter: free the slot, then wake background waiters only while
  // there's headroom under the background cap (so background can't refill past it).
  hsActive--;
  while (hsBgWaiters.length > 0 && hsActive < HS_BG_LIMIT) {
    hsActive++;
    (hsBgWaiters.shift())!();
  }
}
// Circuit breaker: after N consecutive HARD failures (retries already exhausted),
// open for a short cooldown so we stop hammering a down API and fail fast instead.
// Any success closes it. Threshold is high so normal load can't trip it.
const HS_BREAKER_THRESHOLD = Math.max(2, Number(process.env.HUBSPOT_BREAKER_THRESHOLD) || 10);
const HS_BREAKER_COOLDOWN_MS = Math.max(1000, Number(process.env.HUBSPOT_BREAKER_COOLDOWN_MS) || 10_000);
let hsConsecutiveFailures = 0;
let hsBreakerOpenUntil = 0;
function hsNoteSuccess(): void { hsConsecutiveFailures = 0; hsBreakerOpenUntil = 0; }
function hsNoteFailure(): void {
  hsConsecutiveFailures++;
  if (hsConsecutiveFailures >= HS_BREAKER_THRESHOLD) {
    hsBreakerOpenUntil = Date.now() + HS_BREAKER_COOLDOWN_MS;
    console.warn(`[hubspotFetch] circuit OPEN after ${hsConsecutiveFailures} consecutive failures — failing fast for ${HS_BREAKER_COOLDOWN_MS}ms`);
    // Alert once per open episode (dedup + throttle handled downstream). The
    // breaker opening means HubSpot has hard-failed repeatedly — high-signal.
    if (hsConsecutiveFailures === HS_BREAKER_THRESHOLD) {
      reportServerError(
        new Error(`HubSpot circuit breaker OPEN after ${hsConsecutiveFailures} consecutive hard failures`),
        { route: 'lib/hubspot:hubspotFetch', phase: 'circuit-breaker-open' },
      );
    }
  }
}

async function hubspotFetchInner(url: string, method: string, path: string, init: RequestInit): Promise<any> {
  // Retry on 429 (rate limit) with exponential backoff. HubSpot's secondly
  // limit (~10 req/sec) can be hit when paginating the (1,000+ row) catalog or
  // when multiple browser tabs fire concurrent loads.
  // We retry up to 4 times total (initial + 3 retries) with backoffs:
  //   250ms -> 750ms -> 2000ms -> 5000ms
  // Honor Retry-After if HubSpot sends it (rare, but it's the API's request).
  const BACKOFFS_MS = [250, 750, 2000, 5000];
  // ±35% jitter on every backoff. Without it, hundreds of serverless instances
  // that all hit a HubSpot 429/5xx at the same moment back off by the SAME fixed
  // amounts and retry in lockstep — re-colliding wave after wave. Jitter spreads
  // the retries out so the upstream recovers instead of being re-stormed.
  const jitter = (ms: number) => Math.round(ms * (0.65 + Math.random() * 0.7));
  let lastError: Error | null = null;

  // Hard per-attempt timeout. Without it a stalled HubSpot connection hangs the
  // whole serverless invocation until the platform ceiling — and, in loops like
  // the photo-reclaim delete sweep, the per-item catch never fires so the job
  // wedges. A 25s abort turns a hang into a normal thrown error the caller can
  // handle/skip. All hubspotFetch calls are small single REST ops → 25s is ample.
  const REQUEST_TIMEOUT_MS = 25000;
  for (let attempt = 0; attempt <= BACKOFFS_MS.length; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: {
          ...(init.headers || {}),
          Authorization: `Bearer ${token()}`,
          'Content-Type': 'application/json',
        },
        signal: ctrl.signal,
      });
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new Error(`Upstream request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429 && attempt < BACKOFFS_MS.length) {
      const retryAfterHeader = res.headers.get('retry-after');
      // Honor an explicit Retry-After (the API's instruction); only jitter our own
      // default backoff. Retry-After is RFC-legal as delta-SECONDS or an
      // HTTP-DATE — parse both. An unparseable value must NOT become NaN, which
      // Math.max propagates and setTimeout coerces to 0ms → all retries fire
      // back-to-back with no delay, hammering an API that just said slow down.
      const retryAfterMs = (() => {
        if (!retryAfterHeader) return jitter(BACKOFFS_MS[attempt]);
        const secs = Number(retryAfterHeader);
        let ms = Number.isFinite(secs) ? secs * 1000 : (Date.parse(retryAfterHeader) - Date.now());
        if (!Number.isFinite(ms) || ms < 0) return jitter(BACKOFFS_MS[attempt]);
        return Math.min(Math.max(BACKOFFS_MS[attempt], ms), 60_000); // never below our backoff; cap at 60s
      })();
      // Consume body so the socket can be reused
      await res.text().catch(() => '');
      console.warn(`[hubspotFetch] 429 on ${method} ${path}, retrying in ${retryAfterMs}ms (attempt ${attempt + 1}/${BACKOFFS_MS.length})`);
      await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
      continue;
    }
    // Retry transient upstream errors (gateway/unavailable/timeout) too — a
    // brief HubSpot blip shouldn't fail an inspector's save outright.
    if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < BACKOFFS_MS.length) {
      await res.text().catch(() => '');
      const waitMs = jitter(BACKOFFS_MS[attempt]);
      console.warn(`[hubspotFetch] ${res.status} on ${method} ${path}, retrying in ${waitMs}ms (attempt ${attempt + 1}/${BACKOFFS_MS.length})`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      // Log the FULL upstream detail server-side for debugging...
      console.error(`[hubspotFetch] ${method} ${path} failed ${res.status}: ${text.slice(0, 1000)}`);
      // ...but throw a sanitized error so routes that surface e.message to the
      // browser don't leak HubSpot internals (object type ids, property names,
      // validation specifics).
      lastError = new Error(`Upstream request failed (${res.status})`);
      (lastError as any).status = res.status;
      (lastError as any).detail = text.slice(0, 1200);
      // Circuit breaker counts ONLY true upstream failures (5xx). A 4xx is
      // request-specific (bad/duplicate/validation) and PROVES HubSpot is up and
      // answering — so it must NOT trip the breaker (that would fail-fast every
      // inspector's save over a few bad requests). Treat 4xx as a healthy
      // response for breaker purposes: reset the counter, then throw.
      if (res.status >= 500) hsNoteFailure(); else hsNoteSuccess();
      throw lastError;
    }
    if (res.status === 204) { hsNoteSuccess(); return null; }
    hsNoteSuccess();
    return res.json();
  }

  // All retries exhausted on 429
  hsNoteFailure();
  throw lastError || new Error('Upstream request failed after retries (rate limited)');
}

export async function fetchQuestionsForTemplate(
  template: string,
  opts: { debug?: boolean; includeDisabled?: boolean } = {}
): Promise<{ questions: Question[]; debug?: any }> {
  const { question: typeId } = typeIds();
  const properties = [
    'question_id_external', 'question_text', 'section', 'section_order',
    'display_order', 'response_type', 'response_options', 'default_value',
    'note_required_on_values', 'has_assigned_to', 'assigned_to_options',
    'repeats_per_room_type', 'applies_to_templates', 'is_required', 'help_text',
    'is_enabled', 'requires_photo', 'requires_note',
  ];

  const out: Question[] = [];
  const debugAll: any[] = [];
  const debugSkipped: any[] = [];
  // `requires_note` is a newer property; if it hasn't been provisioned yet the
  // search would 400 on it. Drop it and retry so question loading never breaks
  // before /admin/setup runs (it simply reads back as false until provisioned).
  let activeProps = properties;
  const runSearch = async (afterCursor?: string): Promise<any> => {
    const body: any = { filterGroups: [], properties: activeProps, limit: 100 };
    if (afterCursor) body.after = afterCursor;
    try {
      return await hubspotFetch(`/crm/v3/objects/${typeId}/search?archived=false`, { method: 'POST', body: JSON.stringify(body) });
    } catch (e) {
      if (activeProps.includes('requires_note')) {
        activeProps = activeProps.filter((p) => p !== 'requires_note');
        const body2: any = { filterGroups: [], properties: activeProps, limit: 100 };
        if (afterCursor) body2.after = afterCursor;
        return await hubspotFetch(`/crm/v3/objects/${typeId}/search?archived=false`, { method: 'POST', body: JSON.stringify(body2) });
      }
      throw e;
    }
  };
  let after: string | undefined = undefined;
  do {
    const resp = await runSearch(after);
    for (const r of resp.results || []) {
      const p = r.properties || {};
      const appliesStr = p.applies_to_templates || '';
      const applies = appliesStr.split('|').map((s: string) => s.trim()).filter(Boolean);

      const questionText = p.question_text || '';
      const questionIdExternal = p.question_id_external || '';

      // If applies-to-templates is empty, treat as "no templates" and skip entirely.
      if (applies.length === 0) {
        if (opts.debug) {
          debugSkipped.push({
            id: r.id,
            questionIdExternal,
            questionText,
            section: p.section,
            reason: 'applies_to_templates is empty',
            archived: r.archived,
          });
        }
        continue;
      }

      if (!applies.includes(template)) {
        if (opts.debug) {
          debugSkipped.push({
            id: r.id,
            questionIdExternal,
            questionText,
            section: p.section,
            reason: 'template not in applies_to_templates',
            applies,
            archived: r.archived,
          });
        }
        continue;
      }

      // Soft on/off: missing/true ⇒ enabled. Disabled questions are hidden from
      // inspectors but surfaced to the form builder (includeDisabled).
      const enabled = String(p.is_enabled).toLowerCase() !== 'false';
      if (!enabled && !opts.includeDisabled) {
        if (opts.debug) debugSkipped.push({ id: r.id, questionIdExternal, questionText, reason: 'disabled (is_enabled=false)' });
        continue;
      }

      const q: Question = {
        hubspotRecordId: r.id,
        questionIdExternal,
        questionText,
        section: p.section || '',
        sectionOrder: Number(p.section_order) || 0,
        displayOrder: Number(p.display_order) || 0,
        responseType: (p.response_type || 'text') as Question['responseType'],
        responseOptions: (p.response_options || '').split('|').map((s: string) => s.trim()).filter(Boolean),
        defaultValue: p.default_value || '',
        noteRequiredOnValues: (p.note_required_on_values || '').split('|').map((s: string) => s.trim()).filter(Boolean),
        hasAssignedTo: String(p.has_assigned_to).toLowerCase() === 'true',
        assignedToOptions: (p.assigned_to_options || '').split('|').map((s: string) => s.trim()).filter(Boolean),
        repeatsPerRoomType: p.repeats_per_room_type || '',
        appliesToTemplates: applies,
        isRequired: String(p.is_required).toLowerCase() === 'true',
        helpText: p.help_text || '',
        enabled,
        requiresPhoto: String(p.requires_photo).toLowerCase() === 'true',
        requiresNote: String(p.requires_note).toLowerCase() === 'true',
      };
      out.push(q);
      if (opts.debug) {
        debugAll.push({
          id: r.id,
          questionIdExternal: q.questionIdExternal,
          questionText: q.questionText,
          section: q.section,
          sectionOrder: q.sectionOrder,
          displayOrder: q.displayOrder,
          archived: r.archived,
          applies,
        });
      }
    }
    after = resp.paging?.next?.after;
  } while (after);

  out.sort((a, b) => (a.sectionOrder - b.sectionOrder) || (a.displayOrder - b.displayOrder));

  if (opts.debug) {
    return {
      questions: out,
      debug: {
        kept: debugAll,
        skipped: debugSkipped,
        keptCount: debugAll.length,
        skippedCount: debugSkipped.length,
      },
    };
  }
  return { questions: out };
}

// ── Question-record maintenance (admin cleanup) ─────────────────────────────
export interface RawQuestionRecord {
  recordId: string;
  questionIdExternal: string;
  questionText: string;
  section: string;
  sectionOrder: number;
  applies: string[];
}

/** Every non-archived inspection_question record (raw), for admin cleanup. */
export async function listAllQuestionRecords(): Promise<RawQuestionRecord[]> {
  const { question: typeId } = typeIds();
  const props = ['question_id_external', 'question_text', 'section', 'section_order', 'applies_to_templates'];
  const out: RawQuestionRecord[] = [];
  let after: string | undefined;
  do {
    const body: any = { filterGroups: [], properties: props, limit: 100 };
    if (after) body.after = after;
    const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search?archived=false`, {
      method: 'POST', body: JSON.stringify(body),
    });
    for (const r of resp.results || []) {
      const p = r.properties || {};
      out.push({
        recordId: r.id,
        questionIdExternal: p.question_id_external || '',
        questionText: p.question_text || '',
        section: p.section || '',
        sectionOrder: Number(p.section_order) || 0,
        applies: (p.applies_to_templates || '').split('|').map((s: string) => s.trim()).filter(Boolean),
      });
    }
    after = resp.paging?.next?.after;
  } while (after);
  return out;
}

export async function updateQuestionRecord(recordId: string, props: Record<string, any>): Promise<void> {
  const { question: typeId } = typeIds();
  await hubspotFetch(`/crm/v3/objects/${typeId}/${recordId}`, {
    method: 'PATCH', body: JSON.stringify({ properties: props }),
  });
}

export async function archiveQuestionRecords(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const { question: typeId } = typeIds();
  for (let i = 0; i < ids.length; i += HUBSPOT_BATCH_LIMIT) {
    const chunk = ids.slice(i, i + HUBSPOT_BATCH_LIMIT);
    await hubspotFetch(`/crm/v3/objects/${typeId}/batch/archive`, {
      method: 'POST', body: JSON.stringify({ inputs: chunk.map((id) => ({ id })) }),
    });
  }
}

export async function createQuestionRecord(props: Record<string, any>): Promise<string> {
  const { question: typeId } = typeIds();
  const resp = await hubspotFetch(`/crm/v3/objects/${typeId}`, {
    method: 'POST', body: JSON.stringify({ properties: props }),
  });
  return resp.id;
}

/** The templates a question currently applies to (for the form-builder guard).
 *  Returns null if the record can't be read. */
export async function getQuestionAppliesToTemplates(recordId: string): Promise<string[] | null> {
  const { question: typeId } = typeIds();
  try {
    const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/${recordId}?properties=applies_to_templates`);
    const raw = resp?.properties?.applies_to_templates || '';
    return String(raw).split('|').map((s) => s.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

// Pull bed/bath from a Property record. Field names are bedrooms / bathrooms.
function pickBedBathFromProps(p: Record<string, any>): { bedrooms?: number | null; bathrooms?: number | null } {
  let bedrooms: number | null = null;
  let bathrooms: number | null = null;
  if (p.bedrooms != null && p.bedrooms !== '') {
    const n = Number(p.bedrooms);
    if (!Number.isNaN(n)) bedrooms = n;
  }
  if (p.bathrooms != null && p.bathrooms !== '') {
    const n = Number(p.bathrooms);
    if (!Number.isNaN(n)) bathrooms = n;
  }
  return { bedrooms, bathrooms };
}

// Property statuses that should never be selectable for a new inspection.
// Overridable via env (comma-separated) without a code change; the field that
// holds the status is also overridable. Defaults match the production portal.
const PROPERTY_STATUS_PROPERTY = (process.env.PROPERTY_STATUS_PROPERTY || 'status').trim();
const PROPERTY_EXCLUDE_STATUSES = (process.env.PROPERTY_EXCLUDE_STATUSES ||
  'Not Managed,Property Sold,PM Denied')
  .split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Search the Property object server-side for the new-inspection picker.
 *
 * Portals can hold 15k+ properties — far past HubSpot Search's hard
 * 10,000-record paging cap (paging past it returns the "Upstream request
 * failed (400)" we hit on the full production portal), and far too many to
 * pre-load into the browser. So this does NOT page the whole object: it runs a
 * single capped query. With no term it returns a small alphabetical default
 * page (so the dropdown has content on first open); with a term it matches
 * server-side across address / name / city / zip. Inactive statuses are always
 * excluded. The client (Combobox) then fuzzy-ranks whatever comes back.
 */
export async function fetchProperties(
  opts: { search?: string; limit?: number } = {}
): Promise<Property[]> {
  const { property: typeId } = typeIds();
  const term = (opts.search || '').trim();
  // Keep payloads small; a type-ahead only needs a handful of best matches.
  const limit = Math.min(Math.max(opts.limit || (term ? 50 : 25), 1), 100);

  // Projection is forgiving — HubSpot silently ignores names that don't exist on
  // the object — so we can list every variant we might display. (`state_code` is
  // the real field on the production object; `state` is a sandbox alias.)
  const candidateProps = [
    'hs_object_id', 'name',
    'address', 'city', 'state', 'state_code', 'zip', 'zip_code',
    'region', 'bedrooms', 'bathrooms',
    PROPERTY_STATUS_PROPERTY,
  ];

  // CRITICAL: unlike the projection, an unknown property name in a `filters` or
  // `sorts` position is a hard 400 ("Upstream request failed (400)"). So we only
  // ever filter/sort on fields confirmed to exist on the object. The production
  // Property object has address/city/zip_code/state_code and the `status`
  // enum — but NO `name` field, which is what was 400-ing the picker.
  const SEARCH_FIELDS = ['address', 'city'];
  // Sort by a guaranteed system property so the default page can't 400 on a
  // missing custom field. Most-recently-modified first is a sensible default.
  const DEFAULT_SORT = [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }];

  // Inactive properties are never selectable. NOT_IN keeps records whose status
  // is empty/null visible. This filter is AND-ed into every search group below.
  const statusFilter = { propertyName: PROPERTY_STATUS_PROPERTY, operator: 'NOT_IN', values: PROPERTY_EXCLUDE_STATUSES };
  const excludeOn = PROPERTY_EXCLUDE_STATUSES.length > 0;

  // Word tokens of the search term (capped so a filter group stays within
  // HubSpot's per-group limit). Each is matched with a single TRAILING wildcard
  // — `meek*` — which is HubSpot's supported CONTAINS_TOKEN form. A leading or
  // double wildcard (`*meek*`) and multi-word values are what 400 the request.
  const tokens = term ? term.split(/\s+/).filter(Boolean).slice(0, 5) : [];

  function buildBody(withStatus: boolean, withSort: boolean, fields: string[]): any {
    const base = withStatus ? [statusFilter] : [];
    let filterGroups: any[];
    if (term) {
      // Require EACH token in a field (AND within the group), OR-ing across the
      // given text fields. "97 meek" → an address containing both "97" and "meek".
      filterGroups = fields.map((f) => ({
        filters: [...base, ...tokens.map((t) => ({ propertyName: f, operator: 'CONTAINS_TOKEN', value: `${t}*` }))],
      }));
      // ZIP search: a 5-digit term matches zip_code exactly. EQ works whether
      // zip_code is a string or a number property (CONTAINS_TOKEN can't run on
      // a numeric field), so typing a zip lists every address in it.
      const zip = term.replace(/\s+/g, '');
      if (/^\d{5}$/.test(zip)) {
        filterGroups.push({ filters: [...base, { propertyName: 'zip_code', operator: 'EQ', value: zip }] });
      }
    } else {
      filterGroups = withStatus ? [{ filters: base }] : [];
    }
    const body: any = { filterGroups, properties: candidateProps, limit };
    if (!term && withSort) body.sorts = DEFAULT_SORT;
    return body;
  }

  async function search(withStatus: boolean, withSort: boolean, fields: string[] = SEARCH_FIELDS) {
    return hubspotFetch(`/crm/v3/objects/${typeId}/search`, {
      method: 'POST',
      body: JSON.stringify(buildBody(withStatus, withSort, fields)),
    });
  }

  // Try the full query, then degrade on a 400 so a single misconfigured field
  // can never hard-break the picker: drop the status filter, then (when
  // searching) narrow to address-only in case a field like a numeric zip can't
  // take CONTAINS_TOKEN, then drop the sort.
  let resp: any;
  try {
    resp = await search(excludeOn, true);
  } catch (e1: any) {
    if (e1?.status !== 400) throw e1;
    console.warn('[fetchProperties] search 400; retrying without status filter.');
    try {
      resp = await search(false, true);
    } catch (e2: any) {
      if (e2?.status !== 400) throw e2;
      if (term) {
        console.warn('[fetchProperties] still 400; retrying search on address only.');
        resp = await search(false, true, ['address']);
      } else {
        console.warn('[fetchProperties] still 400; retrying without sort.');
        resp = await search(false, false);
      }
    }
  }

  const out: Property[] = [];
  for (const r of resp.results || []) {
    const p = r.properties || {};
    const address = p.address || '';
    const city = p.city || '';
    const state = p.state_code || p.state || '';
    const zip = (p.zip_code || p.zip || '').toString().trim();
    let name = p.name || '';
    if (!name) name = [address, city, state, zip].filter(Boolean).join(', ');
    if (!name) name = `(Property ${r.id})`;
    const { bedrooms, bathrooms } = pickBedBathFromProps(p);
    out.push({
      recordId: r.id,
      name,
      address: address || undefined,
      city: city || undefined,
      state: state || undefined,
      zip: zip || undefined,
      region: (p.region || '').toString().trim() || undefined,
      status: (p[PROPERTY_STATUS_PROPERTY] || '').toString().trim() || undefined,
      bedrooms,
      bathrooms,
    });
  }
  if (!term) out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Fetch ONE page of ALL properties (lean projection) for the offline full-list
 * cache. Uses the LIST endpoint (`/crm/v3/objects/{type}`), NOT search: HubSpot's
 * search API caps pagination at 10k results, but there are 15k+ properties, so a
 * full pull must use the cursor-paginated list endpoint. Excludes inactive
 * statuses (mirrors the picker). The client loops on `after` until it's absent.
 */
export async function fetchPropertiesPage(
  opts: { after?: string; limit?: number } = {},
): Promise<{ properties: Property[]; after?: string }> {
  const { property: typeId } = typeIds();
  const limit = Math.min(Math.max(opts.limit || 100, 1), 100);
  const projection = [
    'name', 'address', 'city', 'state', 'state_code', 'zip', 'zip_code',
    'region', 'bedrooms', 'bathrooms', PROPERTY_STATUS_PROPERTY,
  ];
  const qs = new URLSearchParams({ limit: String(limit), properties: projection.join(','), archived: 'false' });
  if (opts.after) qs.set('after', opts.after);
  const resp = await hubspotFetch(`/crm/v3/objects/${typeId}?${qs.toString()}`);
  const out: Property[] = [];
  for (const r of resp.results || []) {
    const p = r.properties || {};
    const status = (p[PROPERTY_STATUS_PROPERTY] || '').toString().trim();
    if (status && PROPERTY_EXCLUDE_STATUSES.includes(status)) continue; // skip inactive
    const address = p.address || '';
    const city = p.city || '';
    const state = p.state_code || p.state || '';
    const zip = (p.zip_code || p.zip || '').toString().trim();
    let name = p.name || '';
    if (!name) name = [address, city, state, zip].filter(Boolean).join(', ');
    if (!name) name = `(Property ${r.id})`;
    const { bedrooms, bathrooms } = pickBedBathFromProps(p);
    out.push({
      recordId: r.id, name,
      address: address || undefined, city: city || undefined, state: state || undefined, zip: zip || undefined,
      region: (p.region || '').toString().trim() || undefined,
      status: status || undefined,
      bedrooms, bathrooms,
    });
  }
  return { properties: out, after: resp.paging?.next?.after };
}

/**
 * Discovery helper for wiring the Services rules engine to the REAL Property
 * object. Returns the Property field catalog (name/label/type, with enum options)
 * plus the distinct values found on a sample of live records for a set of
 * candidate "grouping" fields — so we can identify which field represents
 * portfolio / owner / market / region / community without guessing names.
 * Read-only; never writes.
 */
export async function inspectPropertyFields(sampleSize = 200, fieldsOverride?: string[]): Promise<{
  typeId: string;
  fields: { name: string; label: string; type: string; fieldType: string; options?: { label: string; value: string }[] }[];
  candidates: Record<string, { field: string; label: string; distinct: { value: string; count: number }[] }>;
  sampled: number;
}> {
  const { property: typeId } = typeIds();
  const defs = await hubspotFetch(`/crm/v3/properties/${typeId}`).catch(() => ({ results: [] }));
  const allFields = (defs.results || []).map((p: any) => ({
    name: p.name, label: p.label, type: p.type, fieldType: p.fieldType,
    options: Array.isArray(p.options) && p.options.length ? p.options.map((o: any) => ({ label: o.label, value: o.value })) : undefined,
  }));
  // Non-system fields only (drop hs_*, createdate, etc.) for readability.
  const fields = allFields.filter((f: any) => !/^hs_/.test(f.name) && !['createdate', 'lastmodifieddate'].includes(f.name));
  const byName = new Map<string, { name: string; label: string }>(fields.map((f: any) => [f.name, { name: f.name, label: f.label }]));

  // Which fields to tally distinct values for. An explicit ?fields= list wins;
  // otherwise auto-pick grouping fields, preferring an EXACT name match (so
  // `portfolio`/`region` beat `home_owners_association`/`area_manager`).
  const picked: Record<string, { name: string; label: string }> = {};
  if (fieldsOverride && fieldsOverride.length) {
    for (const n of fieldsOverride) { const f = byName.get(n); if (f) picked[n] = f; }
  } else {
    const prefs: Record<string, { exact: string[]; re: RegExp }> = {
      portfolio: { exact: ['portfolio'], re: /portfolio|owner_name|investor|fund/i },
      region: { exact: ['region'], re: /^region$|market|metro/i },
      community: { exact: ['neighborhood_name', 'sub_division', 'community_status'], re: /communit|subdivision|neighborhood/i },
    };
    for (const [key, { exact, re }] of Object.entries(prefs)) {
      const hit = exact.map((n) => byName.get(n)).find(Boolean)
        || fields.find((f: any) => re.test(f.name) || re.test(f.label || ''));
      if (hit) picked[key] = { name: hit.name, label: hit.label };
    }
  }

  // Sample records and tally distinct values for the picked candidate fields.
  const pickedNames = [...new Set(Object.values(picked).map((p) => p.name))];
  const tally: Record<string, Map<string, number>> = {};
  pickedNames.forEach((n) => (tally[n] = new Map()));
  let sampled = 0;
  if (pickedNames.length) {
    let after: string | undefined;
    do {
      const qs = new URLSearchParams({ limit: '100', properties: pickedNames.join(','), archived: 'false' });
      if (after) qs.set('after', after);
      const resp = await hubspotFetch(`/crm/v3/objects/${typeId}?${qs.toString()}`).catch(() => ({ results: [] }));
      for (const r of resp.results || []) {
        sampled++;
        for (const n of pickedNames) {
          const v = (r.properties?.[n] ?? '').toString().trim();
          if (!v) continue;
          tally[n].set(v, (tally[n].get(v) || 0) + 1);
        }
      }
      after = resp.paging?.next?.after;
    } while (after && sampled < sampleSize);
  }

  const candidates: Record<string, { field: string; label: string; distinct: { value: string; count: number }[] }> = {};
  for (const [key, p] of Object.entries(picked)) {
    const distinct = [...(tally[p.name] || new Map()).entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 100);
    candidates[key] = { field: p.name, label: p.label, distinct };
  }

  return { typeId, fields, candidates, sampled };
}

// ── Services coverage: real portfolio / region catalog from the Property object ──
// The rules-engine coverage picker (Portfolio → Region drill-down) needs the live
// list of portfolios and, per portfolio, the regions present in it — with counts.
// HubSpot has no GROUP BY, so we page the LIST endpoint (not Search, which caps at
// 10k) up to a cap and tally. Cached in-module briefly since the catalog is stable
// and this is display-only; generation reads live records via searchPropertiesForCoverage.
export interface CoverageCatalog {
  portfolios: { key: string; count: number }[];
  regionsByPortfolio: Record<string, { key: string; count: number }[]>;
  regions: { key: string; count: number }[];
  scanned: number;
  capped: boolean;
}
let _coverageCache: { at: number; cap: number; data: CoverageCatalog } | null = null;
const COVERAGE_TTL_MS = 10 * 60 * 1000;

export async function fetchPropertyCoverage(cap = 6000): Promise<CoverageCatalog | null> {
  if (_coverageCache && _coverageCache.cap === cap && Date.now() - _coverageCache.at < COVERAGE_TTL_MS) return _coverageCache.data;
  const { property: typeId } = typeIds();
  const pf = new Map<string, number>();
  const rg = new Map<string, number>();
  const pfRg = new Map<string, Map<string, number>>();
  let scanned = 0;
  let capped = false;
  try {
    let after: string | undefined;
    do {
      const qs = new URLSearchParams({ limit: '100', properties: ['portfolio', 'region', PROPERTY_STATUS_PROPERTY].join(','), archived: 'false' });
      if (after) qs.set('after', after);
      const resp = await hubspotFetch(`/crm/v3/objects/${typeId}?${qs.toString()}`);
      for (const r of resp.results || []) {
        const p = r.properties || {};
        const status = String(p[PROPERTY_STATUS_PROPERTY] || '').trim();
        if (status && PROPERTY_EXCLUDE_STATUSES.includes(status)) continue; // skip inactive
        scanned++;
        const portfolio = String(p.portfolio || '').trim();
        const region = String(p.region || '').trim();
        if (portfolio) {
          pf.set(portfolio, (pf.get(portfolio) || 0) + 1);
          if (region) {
            if (!pfRg.has(portfolio)) pfRg.set(portfolio, new Map());
            const m = pfRg.get(portfolio)!;
            m.set(region, (m.get(region) || 0) + 1);
          }
        }
        if (region) rg.set(region, (rg.get(region) || 0) + 1);
      }
      after = resp.paging?.next?.after;
      if (scanned >= cap) { capped = !!after; break; }
    } while (after);
  } catch (e) { console.warn('[coverage] scan failed:', e); if (!scanned) return null; }

  const sortAlpha = (m: Map<string, number>) => [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => a.key.localeCompare(b.key));
  const regionsByPortfolio: Record<string, { key: string; count: number }[]> = {};
  for (const [p, m] of pfRg.entries()) regionsByPortfolio[p] = sortAlpha(m);
  const data: CoverageCatalog = { portfolios: sortAlpha(pf), regionsByPortfolio, regions: sortAlpha(rg), scanned, capped };
  _coverageCache = { at: Date.now(), cap, data };
  return data;
}

// Property `status` enum options (label + stored value) for the rules-engine
// enrollment/stop value picker. Cached for the process lifetime (enum is stable).
let _statusOptsCache: { label: string; value: string }[] | null = null;
export async function fetchPropertyStatusOptions(): Promise<{ label: string; value: string }[]> {
  if (_statusOptsCache) return _statusOptsCache;
  const { property: typeId } = typeIds();
  try {
    const def = await hubspotFetch(`/crm/v3/properties/${typeId}/${PROPERTY_STATUS_PROPERTY}`);
    const opts = (def?.options || [])
      .filter((o: any) => !o.hidden)
      .map((o: any) => ({ label: String(o.label || o.value), value: String(o.value) }));
    if (opts.length) _statusOptsCache = opts;
    return opts;
  } catch (e) { console.warn('[coverage] status options fetch failed:', e); return []; }
}

/**
 * Live Property records within a coverage selection (portfolios AND/OR regions),
 * for generation and the rules-engine 'list' mode drill-down. Uses Search with IN
 * filters so result sets stay well under the 10k cap. Optionally filters by status.
 */
export async function searchPropertiesForCoverage(
  opts: { portfolios?: string[]; regions?: string[]; statuses?: string[]; limit?: number } = {},
): Promise<{ id: string; address: string; locality: string; region: string; portfolio: string; status: string; rrqcPassDate: string }[]> {
  const { property: typeId } = typeIds();
  const limit = Math.min(Math.max(opts.limit || 1000, 1), 2000);
  const filters: any[] = [];
  if (opts.portfolios?.length) filters.push({ propertyName: 'portfolio', operator: 'IN', values: opts.portfolios });
  if (opts.regions?.length) filters.push({ propertyName: 'region', operator: 'IN', values: opts.regions });
  if (opts.statuses?.length) filters.push({ propertyName: PROPERTY_STATUS_PROPERTY, operator: 'IN', values: opts.statuses });
  if (PROPERTY_EXCLUDE_STATUSES.length) filters.push({ propertyName: PROPERTY_STATUS_PROPERTY, operator: 'NOT_IN', values: PROPERTY_EXCLUDE_STATUSES });
  // rrqc_pass_date is projected so enrollment criteria like "RRQC Pass Date is
  // known" can be evaluated per property (Rules Engine). Optional field — absent → ''.
  const projection = ['address', 'city', 'state_code', 'state', 'zip_code', 'zip', 'region', 'portfolio', PROPERTY_STATUS_PROPERTY, 'rrqc_pass_date'];
  const out: { id: string; address: string; locality: string; region: string; portfolio: string; status: string; rrqcPassDate: string }[] = [];
  try {
    let after: string | undefined;
    do {
      const body: any = { filterGroups: [{ filters }], properties: projection, limit: 100 };
      if (after) body.after = after;
      const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search`, { method: 'POST', body: JSON.stringify(body) });
      for (const r of resp.results || []) {
        const p = r.properties || {};
        const address = String(p.address || '').trim();
        const city = String(p.city || '').trim();
        const st = String(p.state_code || p.state || '').trim();
        const zip = String(p.zip_code || p.zip || '').trim();
        out.push({
          id: String(r.id), address: address || `(Property ${r.id})`,
          locality: [city, st, zip].filter(Boolean).join(', ').replace(/, (\d)/, ' $1'),
          region: String(p.region || '').trim(), portfolio: String(p.portfolio || '').trim(),
          status: String(p[PROPERTY_STATUS_PROPERTY] || '').trim(),
          rrqcPassDate: String(p.rrqc_pass_date || '').trim(),
        });
        if (out.length >= limit) return out;
      }
      after = resp.paging?.next?.after;
    } while (after);
  } catch (e) { console.warn('[coverage] property search failed:', e); }
  return out;
}

/**
 * Fetch a single Property's stored coordinates by record id. Used to validate
 * the camera's GPS fix against the property location. Returns null when the
 * property has no usable lat/long (the fields exist but aren't always filled
 * in) — the caller then falls back to geocoding the address.
 *
 * Uses the search API (which silently ignores unknown property names) and tries
 * a few common field-name variants so we don't depend on one exact name.
 */
export async function fetchPropertyCoords(recordId: string): Promise<{ lat: number; lng: number } | null> {
  const { property: typeId } = typeIds();
  // Field names vary by portal. Try the configured names first (if set), then a
  // broad set of common variants. The projection silently ignores names that
  // don't exist, so listing extras is harmless.
  const latEnv = (process.env.HUBSPOT_PROPERTY_LAT_PROPERTY || '').trim();
  const lngEnv = (process.env.HUBSPOT_PROPERTY_LNG_PROPERTY || '').trim();
  const latNames = [latEnv, 'latitude', 'lat', 'geo_latitude', 'hs_latitude', 'property_latitude', 'y_coordinate'].filter(Boolean);
  const lngNames = [lngEnv, 'longitude', 'lng', 'lon', 'geo_longitude', 'hs_longitude', 'property_longitude', 'x_coordinate'].filter(Boolean);
  const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search`, {
    method: 'POST',
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: 'hs_object_id', operator: 'EQ', value: recordId }] }],
      properties: [...latNames, ...lngNames],
      limit: 1,
    }),
  });
  const p = resp.results?.[0]?.properties || {};
  const firstNum = (names: string[]): number => {
    for (const n of names) {
      const v = Number(p[n]);
      if (isFinite(v) && v !== 0) return v;
    }
    return NaN;
  };
  const lat = firstNum(latNames);
  const lng = firstNum(lngNames);
  // Treat 0,0 (the null island) as "not set" — it's never a real US property.
  if (isFinite(lat) && isFinite(lng) && (lat !== 0 || lng !== 0)) return { lat, lng };
  return null;
}

/**
 * A geocodable street address for a Property record (street, City, ST ZIP), or
 * null. Used by the map to place COMMUNITY inspections — whose address snapshot
 * is the community name, not a street — via their associated property.
 */
export async function fetchPropertyAddress(recordId: string): Promise<string | null> {
  const { property: typeId } = typeIds();
  const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search`, {
    method: 'POST',
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: 'hs_object_id', operator: 'EQ', value: recordId }] }],
      properties: ['full_address', 'address', 'city', 'state_code', 'state', 'zip_code', 'zip'],
      limit: 1,
    }),
  });
  const p = resp.results?.[0]?.properties || {};
  const full = (p.full_address || '').toString().trim();
  if (full.length >= 5) return full;
  const street = (p.address || '').toString().trim();
  const city = (p.city || '').toString().trim();
  const state = (p.state_code || p.state || '').toString().trim();
  const zip = (p.zip_code || p.zip || '').toString().trim();
  const joined = [street, city, [state, zip].filter(Boolean).join(' ').trim()].filter(Boolean).join(', ');
  return joined.length >= 5 ? joined : null;
}

// ── Community / Visit: the Community custom object linked to a property ──────
// Optional — only the Community/Visit inspection surfaces it. Everything is
// fail-open: if the object/association/name can't be resolved we return null
// and the header simply omits the community line.
//   undefined = not yet resolved · null = definitively unavailable
let _communityMeta: { typeId: string; nameProp: string } | null | undefined;

async function resolveCommunityMeta(): Promise<{ typeId: string; nameProp: string } | null> {
  if (_communityMeta !== undefined) return _communityMeta;
  const envName = (process.env.HUBSPOT_COMMUNITY_NAME_PROPERTY || '').trim();
  const envType = normalizeTypeId(process.env.HUBSPOT_COMMUNITY_TYPE_ID);
  if (envType) { _communityMeta = { typeId: envType, nameProp: envName || 'name' }; return _communityMeta; }
  try {
    const schemas = await hubspotFetch('/crm/v3/schemas');
    const match = (schemas.results || []).find((s: any) =>
      /communit/i.test(s.name || '') || /communit/i.test(s.labels?.singular || '') || /communit/i.test(s.labels?.plural || ''));
    if (!match) { _communityMeta = null; return null; } // definitively not present
    _communityMeta = { typeId: match.objectTypeId, nameProp: envName || match.primaryDisplayProperty || 'name' };
    return _communityMeta;
  } catch (e) {
    console.warn('[community] schema resolve failed (will retry):', e);
    return null; // transient — do NOT cache, so a later request can retry
  }
}

/** Name of the Community object associated with a property, or null. Fail-open. */
export async function fetchPropertyCommunityName(propertyRecordId: string): Promise<string | null> {
  try {
    const meta = await resolveCommunityMeta();
    if (!meta) return null;
    const { property } = typeIds();
    const assoc = await hubspotFetch(`/crm/v4/objects/${property}/${propertyRecordId}/associations/${meta.typeId}?limit=1`);
    const communityId = assoc?.results?.[0]?.toObjectId;
    if (!communityId) return null;
    const rec = await hubspotFetch(`/crm/v3/objects/${meta.typeId}/${communityId}?properties=${encodeURIComponent(meta.nameProp)}`);
    const name = String(rec?.properties?.[meta.nameProp] || '').trim();
    return name || null;
  } catch (e) {
    console.warn('[community] name fetch failed:', e);
    return null;
  }
}

/**
 * The `rrqc_walk_email` distribution address on the Community object associated
 * with a property, or null. Used to CC a community's RRQC walk contact on the
 * New Construction RRQC completion email. Fail-open → null (no community, no
 * association, or a blank field all yield null, so the email just goes to the
 * inspector).
 */
export async function fetchPropertyCommunityRrqcWalkEmail(propertyRecordId: string): Promise<string | null> {
  try {
    const meta = await resolveCommunityMeta();
    if (!meta) return null;
    const { property } = typeIds();
    const assoc = await hubspotFetch(`/crm/v4/objects/${property}/${propertyRecordId}/associations/${meta.typeId}?limit=1`);
    const communityId = assoc?.results?.[0]?.toObjectId;
    if (!communityId) return null;
    const rec = await hubspotFetch(`/crm/v3/objects/${meta.typeId}/${communityId}?properties=rrqc_walk_email`);
    const email = String(rec?.properties?.rrqc_walk_email || '').trim();
    return email || null;
  } catch (e) {
    console.warn('[community] rrqc_walk_email fetch failed:', e);
    return null;
  }
}

/**
 * The FIRST Property record associated to a Community object, or null. Used to
 * place a community inspection on the map — its own record has no street address,
 * so we borrow the community's first property's location. Fail-open.
 */
export async function fetchCommunityFirstPropertyId(communityId: string): Promise<string | null> {
  try {
    const meta = await resolveCommunityMeta();
    if (!meta) return null;
    const { property } = typeIds();
    const assoc = await hubspotFetch(`/crm/v4/objects/${meta.typeId}/${communityId}/associations/${property}?limit=1`);
    const pid = assoc?.results?.[0]?.toObjectId;
    return pid != null ? String(pid) : null;
  } catch (e) {
    console.warn('[community] first-property fetch failed:', e);
    return null;
  }
}

export interface CommunityOption { id: string; name: string; city: string; state: string; zip: string; region?: string; }

/** List Community objects as a de-duplicated (by name) picker list for the
 *  Community / Visit inspection. Fail-open → [] if the object isn't present.
 *  Location fields are the Community object's own (community_city / state /
 *  community_zipcode). */
export async function listCommunities(): Promise<CommunityOption[]> {
  const meta = await resolveCommunityMeta();
  if (!meta) return [];
  const props = [meta.nameProp, 'community_city', 'state', 'community_zipcode'];
  const qs = props.map((p) => `properties=${encodeURIComponent(p)}`).join('&');
  const out: CommunityOption[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  let pages = 0;
  try {
    do {
      const resp = await hubspotFetch(`/crm/v3/objects/${meta.typeId}?limit=100&${qs}${after ? `&after=${after}` : ''}`);
      for (const r of (resp.results || [])) {
        const p = r.properties || {};
        const name = String(p[meta.nameProp] || '').trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue; // unique by name
        seen.add(key);
        out.push({
          id: String(r.id), name,
          city: String(p.community_city || '').trim(),
          state: String(p.state || '').trim(),
          zip: String(p.community_zipcode || '').trim(),
        });
      }
      after = resp.paging?.next?.after;
      pages++;
    } while (after && pages < 25);
  } catch (e) {
    console.warn('[community] list failed:', e);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// Cached id → "City, State ZIP" map for ALL communities (NOT name-deduped),
// used to enrich the inspection LIST cards for community/visit inspections
// created before the address snapshot baked in the locality. Short TTL; the set
// is small (<50) so one paged scan is cheap. Fail-open → empty map.
let _commLocCache: { at: number; map: Map<string, string> } | null = null;
const COMMUNITY_LOC_TTL_MS = 5 * 60 * 1000;
export async function communityLocationMap(): Promise<Map<string, string>> {
  if (_commLocCache && Date.now() - _commLocCache.at < COMMUNITY_LOC_TTL_MS) return _commLocCache.map;
  const meta = await resolveCommunityMeta();
  const map = new Map<string, string>();
  if (!meta) { _commLocCache = { at: Date.now(), map }; return map; }
  const props = ['community_city', 'state', 'community_zipcode'];
  const qs = props.map((p) => `properties=${encodeURIComponent(p)}`).join('&');
  let after: string | undefined;
  let pages = 0;
  try {
    do {
      const resp = await hubspotFetch(`/crm/v3/objects/${meta.typeId}?limit=100&${qs}${after ? `&after=${after}` : ''}`);
      for (const r of (resp.results || [])) {
        const p = r.properties || {};
        const loc = formatCommunityLocation({
          city: String(p.community_city || '').trim(),
          state: String(p.state || '').trim(),
          zip: String(p.community_zipcode || '').trim(),
        });
        if (loc) map.set(String(r.id), loc);
      }
      after = resp.paging?.next?.after;
      pages++;
    } while (after && pages < 25);
  } catch (e) {
    console.warn('[community] location map failed:', e);
  }
  _commLocCache = { at: Date.now(), map };
  return map;
}

/** One Community's display name + location (city/state/zip). Fail-open → null. */
export async function fetchCommunityById(communityId: string): Promise<CommunityOption | null> {
  const meta = await resolveCommunityMeta();
  if (!meta || !communityId) return null;
  try {
    const props = [meta.nameProp, 'community_city', 'state', 'community_zipcode'];
    const qs = props.map((p) => `properties=${encodeURIComponent(p)}`).join('&');
    const r = await hubspotFetch(`/crm/v3/objects/${meta.typeId}/${communityId}?${qs}`);
    const p = r?.properties || {};
    return {
      id: String(r.id),
      name: String(p[meta.nameProp] || '').trim(),
      city: String(p.community_city || '').trim(),
      state: String(p.state || '').trim(),
      zip: String(p.community_zipcode || '').trim(),
    };
  } catch (e) {
    console.warn('[community] fetchById failed:', e);
    return null;
  }
}

/**
 * All Community records as { id, name }, sorted by name. Null when the Community
 * object can't be resolved. Prefers the `community_name` property, falling back
 * to the resolved display property. Used by the Services rules-engine community
 * coverage picker and generation.
 */
export async function listServiceCommunities(): Promise<{ id: string; name: string; units: number }[] | null> {
  const meta = await resolveCommunityMeta();
  if (!meta) return null;
  const props = [...new Set(['community_name', meta.nameProp, 'total_units'])];
  try {
    const out: { id: string; name: string; units: number }[] = [];
    let after: string | undefined;
    do {
      const qs = new URLSearchParams({ limit: '100', properties: props.join(','), archived: 'false' });
      if (after) qs.set('after', after);
      const resp = await hubspotFetch(`/crm/v3/objects/${meta.typeId}?${qs.toString()}`);
      for (const r of resp.results || []) {
        const p = r.properties || {};
        const name = String(p.community_name || p[meta.nameProp] || '').trim();
        const units = Number(p.total_units);
        if (name) out.push({ id: String(r.id), name, units: Number.isFinite(units) ? units : 0 });
      }
      after = resp.paging?.next?.after;
    } while (after);
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  } catch (e) { console.warn('[community] list failed:', e); return null; }
}

export interface CommunityProperty { id: string; address: string; locality: string; region: string; rrqcPassDate: string; status: string }

/** All properties associated to a Community, with address + `rrqc_pass_date`.
 *  Powers the community grass-cut eligible snapshot (rrqcPassDate set) and the
 *  reviewer's "add property" picker (all of them). Fail-open → []. */
export async function fetchCommunityProperties(communityId: string): Promise<CommunityProperty[]> {
  const ids = await fetchCommunityPropertyIds(communityId);
  if (!ids.length) return [];
  const { property } = typeIds();
  const projection = ['address', 'city', 'state_code', 'state', 'zip_code', 'zip', 'region', 'rrqc_pass_date', PROPERTY_STATUS_PROPERTY];
  const out: CommunityProperty[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    try {
      const resp = await hubspotFetch(`/crm/v3/objects/${property}/batch/read`, {
        method: 'POST',
        body: JSON.stringify({ properties: projection, inputs: ids.slice(i, i + 100).map((id) => ({ id })) }),
      });
      for (const r of resp.results || []) {
        const p = r.properties || {};
        const city = String(p.city || '').trim();
        const st = String(p.state_code || p.state || '').trim();
        const zip = String(p.zip_code || p.zip || '').trim();
        out.push({
          id: String(r.id),
          address: String(p.address || '').trim() || `(Property ${r.id})`,
          locality: [city, st, zip].filter(Boolean).join(', ').replace(/, (\d)/, ' $1'),
          region: String(p.region || '').trim(),
          rrqcPassDate: String(p.rrqc_pass_date || '').trim(),
          status: String(p[PROPERTY_STATUS_PROPERTY] || '').trim(),
        });
      }
    } catch (e) { console.warn('[community] batch read failed:', e); }
  }
  return out;
}

/** Property record ids associated to a Community (all pages). Empty when none. */
export async function fetchCommunityPropertyIds(communityId: string): Promise<string[]> {
  const meta = await resolveCommunityMeta();
  if (!meta) return [];
  const { property } = typeIds();
  const out: string[] = [];
  try {
    let after: string | undefined;
    do {
      const qs = after ? `?limit=100&after=${after}` : '?limit=100';
      const assoc = await hubspotFetch(`/crm/v4/objects/${meta.typeId}/${communityId}/associations/${property}${qs}`);
      for (const a of assoc.results || []) if (a.toObjectId != null) out.push(String(a.toObjectId));
      after = assoc.paging?.next?.after;
    } while (after);
  } catch (e) { console.warn('[community] property ids fetch failed:', e); }
  return out;
}

/** Discovery: the Community object's field catalog + full community name list. */
export async function inspectCommunityObject(): Promise<{
  typeId: string; nameProp: string;
  fields: { name: string; label: string; type: string; fieldType: string }[];
  communities: { id: string; name: string }[]; count: number;
} | null> {
  const meta = await resolveCommunityMeta();
  if (!meta) return null;
  const defs = await hubspotFetch(`/crm/v3/properties/${meta.typeId}`).catch(() => ({ results: [] }));
  const fields = (defs.results || [])
    .filter((p: any) => !/^hs_/.test(p.name) && !['createdate', 'lastmodifieddate'].includes(p.name))
    .map((p: any) => ({ name: p.name, label: p.label, type: p.type, fieldType: p.fieldType }));
  const communities = (await listCommunities()) || [];
  return { typeId: meta.typeId, nameProp: meta.nameProp, fields, communities, count: communities.length };
}

// ── ResiWalk - Services: Phase 0 schema provisioner ─────────────────────────
// Additive-only. dry-run diffs the schemaSpec against HubSpot (no writes); apply
// creates the two custom objects, their properties, the additive Question props,
// and the labeled associations. Idempotent (skips what already exists).
const isConflict = (e: unknown) => {
  const blob = `${String((e as any)?.message || e || '')} ${String((e as any)?.detail || '')}`;
  return /409|already ?exists|already a label|PROPERTY_ALREADY_EXISTS|been created|duplicate/i.test(blob);
};

async function ensurePropertyGroup(typeId: string, name: string): Promise<string> {
  try {
    const g = await hubspotFetch(`/crm/v3/properties/${typeId}/groups`);
    if ((g.results || []).some((x: any) => x.name === name)) return name;
  } catch { /* fall through to create */ }
  try {
    await hubspotFetch(`/crm/v3/properties/${typeId}/groups`, { method: 'POST', body: JSON.stringify({ name, label: 'Service Information' }) });
  } catch (e) { if (!isConflict(e)) throw e; }
  return name;
}

function propPayload(p: PropSpec, groupName?: string) {
  return {
    name: p.name, label: p.label, type: p.type, fieldType: p.fieldType,
    ...(groupName ? { groupName } : {}),
    ...(p.options ? { options: p.options.map((o, i) => ({ label: o.label, value: o.value, displayOrder: i })) } : {}),
  };
}

async function createProperty(typeId: string, p: PropSpec, groupName: string) {
  try { await hubspotFetch(`/crm/v3/properties/${typeId}`, { method: 'POST', body: JSON.stringify(propPayload(p, groupName)) }); }
  catch (e) { if (!isConflict(e)) throw e; }
}

// Read-only: report ALL custom objects (active + archived) with their record
// counts — so we can find the pre-existing "Service" object (likely archived,
// which the default schema list hides) and see if it's safe to delete. No writes.
export async function inspectServiceLikeObjects(): Promise<any> {
  const fetchList = async (archived: boolean): Promise<any[]> => {
    try {
      const r = await hubspotFetch(`/crm/v3/schemas${archived ? '?archived=true' : ''}`);
      return (r.results || []).map((s: any) => ({ ...s, _archived: archived }));
    } catch { return []; }
  };
  const all = [...await fetchList(false), ...await fetchList(true)];
  const seen = new Set<string>();
  const out: any[] = [];
  for (const s of all) {
    if (seen.has(s.objectTypeId)) continue;
    seen.add(s.objectTypeId);
    let recordCount: number | null = null;
    try {
      const r = await hubspotFetch(`/crm/v3/objects/${s.objectTypeId}/search`, { method: 'POST', body: JSON.stringify({ limit: 1 }) });
      recordCount = typeof r.total === 'number' ? r.total : null;
    } catch { /* count unavailable (e.g. archived) */ }
    out.push({
      name: s.name, objectTypeId: s.objectTypeId, fullyQualifiedName: s.fullyQualifiedName,
      singular: s.labels?.singular, plural: s.labels?.plural, archived: !!s._archived,
      createdAt: s.createdAt, propertyCount: (s.properties || []).length, recordCount,
    });
  }
  return { count: out.length, objects: out };
}

// ── Services Phase 1: read Service Work Orders (falls back to null when the
// object isn't configured yet, so the UI can use sample data in the meantime) ──
const SERVICE_LIST_PROPS = [
  'service_name', 'worktype', 'subtype', 'status', 'is_bid_item', 'scope', 'due_date',
  'region_snapshot', 'address_snapshot', 'locality_snapshot', 'community_name',
  'property_status_snapshot', 'latitude', 'longitude', 'vendor_name', 'pet_stations',
  'property_id_ref', 'community_id_ref', 'submitted_at', 'completed_at', 'ontime',
  'master_service_id', 'for_billing',
  'hs_createdate',
];

function normServiceDate(v: any): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const n = Number(s);
  if (Number.isFinite(n)) { const d = new Date(n >= 1e11 ? n : n * 1000); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`; }
  return '';
}

function mapServiceRow(r: any): ServiceRecord {
  const p = r.properties || {};
  const num = (v: any): number | null => { const n = Number(v); return Number.isFinite(n) && n !== 0 ? n : null; };
  // Only DEFINED keys — getServerSideProps can't serialize `undefined` values.
  const rec: ServiceRecord = {
    id: String(r.id),
    scope: p.scope === 'community' ? 'community' : 'property',
    address: p.address_snapshot || p.service_name || '(Service)',
    locality: p.locality_snapshot || '',
    portfolio: '',
    region: p.region_snapshot || '',
    worktype: (p.worktype || 'landscaping') as Worktype,
    subtype: p.subtype || '',
    status: (p.status || 'assigned') as ServiceStatus,
    petStations: p.pet_stations === 'true',
    vendor: p.vendor_name || null,
    dueDate: normServiceDate(p.due_date),
  };
  if (String(p.vendor_email || '').trim()) rec.vendorEmail = String(p.vendor_email).trim();
  if (p.is_bid_item === 'true') rec.isBidItem = true;
  if (String(p.master_service_id || '').trim()) rec.masterServiceId = String(p.master_service_id).trim();
  if (p.for_billing === 'true') rec.forBilling = true;
  if (p.community_name) rec.community = p.community_name;
  if (p.property_status_snapshot) rec.propertyStatus = p.property_status_snapshot;
  if (p.ontime === 'true') rec.onTime = true;
  // Completion timestamp (ms epoch or ISO) → ISO, for day-view route ordering.
  if (p.completed_at) {
    const t = String(p.completed_at).trim();
    const d = /^\d{10,}$/.test(t) ? new Date(Number(t)) : new Date(t);
    if (!isNaN(+d)) rec.completedAt = d.toISOString();
  }
  // Creation date → the "estimated" date shown for estimated (bid) services.
  if (p.hs_createdate) { const e = normServiceDate(p.hs_createdate); if (e) rec.estimatedAt = e; }
  const lat = num(p.latitude); if (lat !== null) rec.lat = lat;
  const lng = num(p.longitude); if (lng !== null) rec.lng = lng;
  // Property (or Community) ref so the map can geocode via the property's stored
  // coords when lat/lng aren't stamped on the service yet.
  const ref = String(p.property_id_ref || p.community_id_ref || '').trim();
  if (ref) rec.propertyId = ref;
  return rec;
}

/** All Service Work Orders (up to `limit`). Returns null when the object type id
 *  env var isn't set yet — the caller then falls back to sample data. */
// Short-TTL cache for the whole services list. The list is identical for every
// caller (the page filters/labels client-side), so one shared cache is safe and
// makes toggling between the Services and Inspections tabs feel instant instead
// of re-querying HubSpot (up to 500 records) on every navigation. Any Service
// Work Order write busts it (see createServiceWorkOrder / patchServiceWorkOrder),
// so post-action refreshes still show fresh data.
// List cache keyed by SCOPE — a vendor's scoped fetch must never be served to
// another viewer (or to an admin), so the key is the vendor email (or 'all').
interface SvcListEntry { data: ServiceRecord[] | null; at: number; inflight: Promise<ServiceRecord[] | null> | null }
const _svcListCache = new Map<string, SvcListEntry>();
const SVC_LIST_TTL_MS = 30_000;
export function bustServiceListCache(): void { _svcListCache.clear(); }

export interface ServiceListOpts {
  /** Restrict to one vendor's own orders (server-side vendor_email filter). Omit
   *  for the admin/all view. */
  vendorEmail?: string | null;
  /** Max records to pull. A vendor's own set is small; the admin/all view is
   *  capped and sorted newest-due-first so current/upcoming work stays in-window
   *  and only the oldest completed history is dropped past the cap. */
  limit?: number;
}

export async function searchServiceWorkOrders(opts: ServiceListOpts = {}): Promise<ServiceRecord[] | null> {
  const vendorEmail = String(opts.vendorEmail || '').trim().toLowerCase();
  const limit = opts.limit ?? (vendorEmail ? 3000 : 3000);
  const key = vendorEmail || 'all';
  const cur = _svcListCache.get(key);
  if (cur && cur.data && Date.now() - cur.at < SVC_LIST_TTL_MS) return cur.data;
  if (cur && cur.inflight) return cur.inflight;   // single-flight per scope
  const inflight = searchServiceWorkOrdersLive(limit, vendorEmail || undefined)
    .then((items) => { _svcListCache.set(key, { data: items, at: Date.now(), inflight: null }); return items; })
    .catch((e) => { _svcListCache.set(key, { data: null, at: 0, inflight: null }); throw e; });
  _svcListCache.set(key, { data: cur?.data ?? null, at: cur?.at ?? 0, inflight });
  return inflight;
}

/** Lightweight service list for pickers (admin test-send): id + label fields
 *  only, NO locality/status enrichment and NO shared cache — so it returns fast
 *  and can't be affected by the enriched-list path. Newest first. Fail-open→[]. */
export async function searchServicesForPicker(limit = 300): Promise<{ id: string; worktype: string; subtype: string; address: string; status: string; masterServiceId: string }[]> {
  const typeId = (process.env.HUBSPOT_SERVICE_TYPE_ID || '').trim();
  if (!typeId) return [];
  const out: { id: string; worktype: string; subtype: string; address: string; status: string; masterServiceId: string }[] = [];
  let after: string | undefined;
  try {
    do {
      const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search`, {
        method: 'POST',
        body: JSON.stringify({
          limit: 100, after,
          properties: ['service_name', 'worktype', 'subtype', 'status', 'address_snapshot', 'master_service_id'],
          sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
        }),
      });
      for (const r of resp.results || []) {
        const p = r.properties || {};
        out.push({
          id: String(r.id), worktype: p.worktype || '', subtype: p.subtype || '',
          address: p.address_snapshot || p.service_name || `(Service ${r.id})`,
          status: p.status || '', masterServiceId: String(p.master_service_id || '').trim(),
        });
      }
      after = resp.paging?.next?.after;
    } while (after && out.length < limit);
  } catch (e) { console.warn('[services] picker search failed:', e); }
  return out;
}

async function searchServiceWorkOrdersLive(limit = 3000, vendorEmail?: string): Promise<ServiceRecord[] | null> {
  const typeId = (process.env.HUBSPOT_SERVICE_TYPE_ID || '').trim();
  if (!typeId) return null;
  try {
    const items: ServiceRecord[] = [];
    const refById = new Map<string, string>();   // service id → property_id_ref
    let after: string | undefined;
    // Vendor scope: filter server-side to the vendor's own orders so a vendor
    // ALWAYS gets their complete set (never truncated by a global window) and
    // never receives another vendor's data. Sort DESCENDING by due date so the
    // window holds current/upcoming work; only the oldest (completed) history is
    // dropped past the cap, not this week's jobs.
    const filterGroups = vendorEmail
      ? [{ filters: [{ propertyName: 'vendor_email', operator: 'EQ', value: vendorEmail }] }]
      : undefined;
    do {
      const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search`, {
        method: 'POST',
        body: JSON.stringify({
          limit: 100, after,
          properties: SERVICE_LIST_PROPS,
          ...(filterGroups ? { filterGroups } : {}),
          sorts: [{ propertyName: 'due_date', direction: 'DESCENDING' }],
        }),
      });
      for (const r of resp.results || []) {
        const row = mapServiceRow(r);
        const ref = String(r.properties?.property_id_ref || '').trim();
        if (ref) refById.set(row.id, ref);
        items.push(row);
      }
      after = resp.paging?.next?.after;
    } while (after && items.length < limit);
    // Community services carry only the community name; fill in City/ST/ZIP from
    // the community's own location (name → locality map, cached).
    if (items.some((s) => s.scope === 'community' && !s.locality && s.community)) {
      const byName = await communityLocalityByName().catch(() => new Map<string, string>());
      for (const s of items) {
        if (s.scope === 'community' && !s.locality && s.community) {
          const loc = byName.get(s.community);
          if (loc) s.locality = loc;
        }
      }
    }
    // SFR property status: LIVE until the service is submitted, then the value
    // stamped at submit (property_status_snapshot) stays locked. So only the
    // pre-submit property rows get their status refreshed from the property NOW.
    const preSubmit = items.filter((s) => s.scope === 'property' && (s.status === 'estimated' || s.status === 'assigned') && refById.get(s.id));
    if (preSubmit.length) {
      const liveById = await batchReadPropertyStatuses(preSubmit.map((s) => refById.get(s.id)!)).catch(() => new Map<string, string>());
      for (const s of preSubmit) { const live = liveById.get(refById.get(s.id)!); if (live) s.propertyStatus = live; }
    }
    return items;
  } catch (e) {
    console.warn('[services] searchServiceWorkOrders failed:', e);
    return null;
  }
}

/** City/State/ZIP + region of the FIRST property associated to a Community — the
 *  fallback when the Community object's own fields are blank. Uses the standard
 *  property fields (city / state_code / zip_code|zip / region). Fail-open → null. */
async function fetchFirstCommunityProperty(communityId: string): Promise<{ city: string; state: string; zip: string; region: string } | null> {
  const meta = await resolveCommunityMeta();
  const { property } = typeIds();
  if (!meta || !communityId) return null;
  try {
    const assoc = await hubspotFetch(`/crm/v4/objects/${meta.typeId}/${communityId}/associations/${property}?limit=1`);
    const first = assoc?.results?.[0];
    const propId = first?.toObjectId != null ? String(first.toObjectId) : '';
    if (!propId) return null;
    const props = ['city', 'state_code', 'state', 'zip_code', 'zip', 'region'];
    const qs = props.map((p) => `properties=${encodeURIComponent(p)}`).join('&');
    const r = await hubspotFetch(`/crm/v3/objects/${property}/${propId}?${qs}`);
    const p = r?.properties || {};
    const city = String(p.city || '').trim();
    const state = String(p.state_code || p.state || '').trim();
    const zip = String(p.zip_code || p.zip || '').trim();
    const region = String(p.region || '').trim();
    if (!city && !state && !zip && !region) return null;
    return { city, state, zip, region };
  } catch (e) {
    console.warn('[community] first-property fallback failed:', e);
    return null;
  }
}

// Community NAME → "City, State ZIP", built from the existing id-keyed location
// map + the id/name list (both cached). Lets us backfill locality on community
// services that stored only the name.
export async function communityLocalityByName(): Promise<Map<string, string>> {
  const [comms, locById] = await Promise.all([
    listServiceCommunities().catch(() => null),
    communityLocationMap().catch(() => new Map<string, string>()),
  ]);
  const byName = new Map<string, string>();
  for (const c of comms || []) { const loc = locById.get(c.id); if (loc) byName.set(c.name, loc); }
  return byName;
}

/** The Community object's OWN region. The field name isn't universally known, so
 *  this is a best-effort ISOLATED fetch (configurable via
 *  HUBSPOT_COMMUNITY_REGION_PROPERTY, default `region`): a 400 for a missing
 *  property fails open to null (→ the caller falls back to the property region)
 *  instead of breaking the whole display fetch. */
async function fetchCommunityOwnRegion(communityId: string): Promise<string | null> {
  const meta = await resolveCommunityMeta();
  if (!meta || !communityId) return null;
  const field = (process.env.HUBSPOT_COMMUNITY_REGION_PROPERTY || 'region').trim();
  try {
    const r = await hubspotFetch(`/crm/v3/objects/${meta.typeId}/${communityId}?properties=${encodeURIComponent(field)}`);
    const v = r?.properties?.[field];
    return (typeof v === 'string' && v.trim()) ? v.trim() : null;
  } catch {
    return null; // field may not exist on the object → fall back to property region
  }
}

/** Community display for a specific inspection: the community name + resolved
 *  City/State/ZIP + region. Prefers the Community object's OWN fields; when a
 *  field is blank, falls back to the FIRST associated property (its city/state/
 *  zip and/or region). Fail-open → null (only when the community itself can't be
 *  resolved). */
export async function resolveCommunityDisplay(communityId: string): Promise<CommunityOption | null> {
  const c = await fetchCommunityById(communityId);
  if (!c) return null;
  const needLoc = !c.city && !c.state && !c.zip;
  let region = (await fetchCommunityOwnRegion(communityId)) || '';
  // One property lookup covers BOTH the location and region fallbacks.
  if (needLoc || !region) {
    const fp = await fetchFirstCommunityProperty(communityId);
    if (fp) {
      if (needLoc) { c.city = fp.city; c.state = fp.state; c.zip = fp.zip; }
      if (!region) region = fp.region;
    }
  }
  return { ...c, region: region || undefined };
}

/** "City, State ZIP" location line for a Community (from its own city/state/zip
 *  fields). Returns '' if none are set. Shared by the picker and the PDF header. */
export function formatCommunityLocation(c: { city?: string; state?: string; zip?: string } | null | undefined): string {
  if (!c) return '';
  return [c.city, [c.state, c.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}

/** Associate a Community object to an Inspection (default/unlabeled v4 assoc),
 *  so Community/Visit inspections are linked on the Community record too.
 *  Best-effort — never throws. */
export async function associateCommunityToInspection(inspectionId: string, communityId: string): Promise<void> {
  const meta = await resolveCommunityMeta();
  if (!meta || !communityId || !inspectionId) return;
  const { inspection } = typeIds();
  try {
    await hubspotFetch(`/crm/v4/objects/${inspection}/${inspectionId}/associations/default/${meta.typeId}/${communityId}`, { method: 'PUT' });
  } catch (e) {
    console.warn('[community] associate to inspection failed:', e);
  }
}

// ── Service Rules Engine: read + upsert rule records ──
const RULE_PROPS = [
  'rule_name', 'active', 'worktype', 'subtype', 'scope', 'pet_stations', 'props_mode',
  'vendor_cost', 'markup_pct', 'vendors_json', 'service_description', 'recurring',
  'cadences_json', 'initial_due_days', 'skip_months_json', 'included_props_json',
  'portfolios_json', 'communities_json', 'regions_json', 'enroll_field', 'enroll_op',
  'enroll_value', 'enroll_criteria_json', 'enroll_combinator', 'start_date',
  'stop_enabled', 'stop_mode', 'stop_field', 'stop_op', 'stop_value',
  'stop_criteria_json', 'stop_combinator', 'stop_date', 'stop_count',
];

/** All Service Rule records (raw props + id), or null when not configured. */
export async function searchServiceRuleRecords(): Promise<{ id: string; props: Record<string, any> }[] | null> {
  const typeId = (process.env.HUBSPOT_SERVICE_RULE_TYPE_ID || '').trim();
  if (!typeId) return null;
  try {
    const out: { id: string; props: Record<string, any> }[] = [];
    let after: string | undefined;
    do {
      const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search`, {
        method: 'POST',
        body: JSON.stringify({ limit: 100, after, properties: RULE_PROPS, sorts: [{ propertyName: 'hs_createdate', direction: 'ASCENDING' }] }),
      });
      for (const r of resp.results || []) out.push({ id: String(r.id), props: r.properties || {} });
      after = resp.paging?.next?.after;
    } while (after);
    return out;
  } catch (e) { console.warn('[services] rule read failed:', e); return null; }
}

/** Create (id null) or update a Service Rule record. Returns the record id, or
 *  null when the object type id env var isn't set. */
// Property names HubSpot rejects in a write — either the property doesn't exist
// yet (`Property "enroll_criteria_json" does not exist`) or a value isn't a valid
// enum option (`... was not one of the allowed options ... "name":"enroll_op"`).
// Both happen when a schema-dependent field/option ships before its provision
// run; stripping the named props and retrying lets the write self-heal so it
// never bricks the save (the field simply persists once provisioned).

/**
 * Create (id=null) or PATCH a CRM object, self-healing against properties HubSpot
 * rejects as unknown OR as an invalid enum value — it drops the named props and
 * retries. This keeps writes working when a field/option ships ahead of its
 * provision run, and (the point of this) never lets a NEW enum value (e.g. a new
 * review decision or answer choice) 400 an OLDER record's close-out. Returns the
 * response body. Other errors rethrow.
 */
async function writeObjectResilient(typeId: string, id: string | null, props: Record<string, any>): Promise<any> {
  let body = { ...props };
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      if (id) return await hubspotFetch(`/crm/v3/objects/${typeId}/${id}`, { method: 'PATCH', body: JSON.stringify({ properties: body }) });
      return await hubspotFetch(`/crm/v3/objects/${typeId}`, { method: 'POST', body: JSON.stringify({ properties: body }) });
    } catch (e: any) {
      const rejected = rejectedPropNames(e).filter((n) => n in body);
      if (!rejected.length) throw e;
      for (const n of rejected) delete body[n];
      console.warn(`[services] work order write: dropping rejected props and retrying: ${rejected.join(', ')}`);
    }
  }
  throw new Error('work order write failed after stripping rejected properties');
}

export async function upsertServiceRuleRecord(id: string | null, props: Record<string, any>): Promise<string | null> {
  const typeId = (process.env.HUBSPOT_SERVICE_RULE_TYPE_ID || '').trim();
  if (!typeId) return null;
  let body = { ...props };
  // Retry a few times, each pass stripping any property HubSpot rejects (unknown
  // field OR invalid enum value not yet provisioned). Other errors rethrow.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      if (id) { await hubspotFetch(`/crm/v3/objects/${typeId}/${id}`, { method: 'PATCH', body: JSON.stringify({ properties: body }) }); return id; }
      const resp = await hubspotFetch(`/crm/v3/objects/${typeId}`, { method: 'POST', body: JSON.stringify({ properties: body }) });
      return resp?.id ? String(resp.id) : null;
    } catch (e: any) {
      const rejected = rejectedPropNames(e).filter((n) => n in body);
      if (!rejected.length) throw e;
      for (const n of rejected) delete body[n];
      console.warn(`[services] rule save: dropping rejected props and retrying: ${rejected.join(', ')}`);
    }
  }
  throw new Error('rule save failed after stripping rejected properties');
}

export async function deleteServiceRuleRecord(id: string): Promise<boolean> {
  const typeId = (process.env.HUBSPOT_SERVICE_RULE_TYPE_ID || '').trim();
  if (!typeId || !id) return false;
  await hubspotFetch(`/crm/v3/objects/${typeId}/${id}`, { method: 'DELETE' });
  return true;
}

// HubSpot CRM search offset paging errors past 10,000 results — clamp every full
// scan below that so a large object can't throw mid-page.
const HUBSPOT_SEARCH_MAX = 10_000;

/** Existing Service Work Order (enrollment_key, status, vendor) pairs — for
 *  generation dedup + rotation. Null ONLY when the object isn't configured; a real
 *  read error THROWS (so generation fails loudly instead of silently reading the
 *  null as "not configured" and creating nothing). */
export async function readServiceWorkOrderKeys(): Promise<{ key: string; status: string; vendor: string }[] | null> {
  const typeId = (process.env.HUBSPOT_SERVICE_TYPE_ID || '').trim();
  if (!typeId) return null;
  const out: { key: string; status: string; vendor: string }[] = [];
  let after: string | undefined;
  do {
    const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search`, {
      method: 'POST', body: JSON.stringify({ limit: 100, after, properties: ['enrollment_key', 'status', 'vendor_name'] }),
    });
    for (const r of resp.results || []) out.push({ key: String(r.properties?.enrollment_key || ''), status: String(r.properties?.status || ''), vendor: String(r.properties?.vendor_name || '') });
    after = resp.paging?.next?.after;
    if (out.length >= HUBSPOT_SEARCH_MAX) { if (after) console.warn('[services] key scan hit the 10k search cap — dedup set is partial'); break; }
  } while (after);
  return out;
}

/** All Service Work Orders normalized for vendor-performance insights. Excludes
 *  per-property billing-line children (master_service_id set) so completed counts
 *  and costs aren't double-counted. Returns null when the object isn't configured. */
export async function fetchServiceInsightsRows(): Promise<import('./services/insights').SvcInsightsRow[] | null> {
  const typeId = (process.env.HUBSPOT_SERVICE_TYPE_ID || '').trim();
  if (!typeId) return null;
  const PROPS = ['status', 'is_bid_item', 'ontime', 'review_decision', 'vendor_name', 'vendor_cost', 'master_service_id'];
  try {
    const rows: import('./services/insights').SvcInsightsRow[] = [];
    let after: string | undefined;
    do {
      const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search`, {
        method: 'POST', body: JSON.stringify({ limit: 100, after, properties: PROPS }),
      });
      for (const r of resp.results || []) {
        const p = r.properties || {};
        if (String(p.master_service_id || '').trim()) continue;   // split child — rolled into its master
        const cost = Number(p.vendor_cost);
        rows.push({
          status: String(p.status || ''),
          isBidItem: p.is_bid_item === 'true',
          ontime: String(p.status || '') === 'completed' ? (p.ontime === 'true' ? true : p.ontime === 'false' ? false : null) : null,
          reviewDecision: String(p.review_decision || ''),
          vendor: String(p.vendor_name || ''),
          vendorCost: Number.isFinite(cost) ? cost : null,
        });
      }
      after = resp.paging?.next?.after;
      if (rows.length >= HUBSPOT_SEARCH_MAX) { if (after) console.warn('[services] insights scan hit the 10k search cap — metrics are partial'); break; }
    } while (after);
    return rows;
  } catch (e) { console.warn('[services] insights read failed:', e); return null; }
}

/** Create one Service Work Order from a property map. Returns the new record id,
 *  or null when the object type id env var isn't set (caller falls back to preview). */
export async function createServiceWorkOrder(props: Record<string, any>): Promise<string | null> {
  const typeId = (process.env.HUBSPOT_SERVICE_TYPE_ID || '').trim();
  if (!typeId) return null;
  const resp = await writeObjectResilient(typeId, null, props);
  bustServiceListCache();   // a new work order → the list changed
  return resp?.id ? String(resp.id) : null;
}

// Full property set for the single-work-order (completion) view.
const SERVICE_DETAIL_PROPS = [
  'service_name', 'worktype', 'subtype', 'status', 'scope', 'is_bid_item',
  'service_description', 'due_date', 'region_snapshot', 'address_snapshot',
  'locality_snapshot', 'community_name', 'property_status_snapshot',
  'vendor_name', 'vendor_email', 'pet_stations', 'vendor_cost', 'markup_pct',
  'client_cost', 'vendor_cost_adjustment', 'vendor_cost_adjustment_reason',
  'submitted_at', 'completed_at', 'ai_verdict', 'ai_notes',
  'review_decision', 'review_notes', 'reviewed_by', 'reviewed_at',
  'before_photo_urls', 'after_photo_urls', 'pet_before_photo_urls',
  'pet_after_photo_urls', 'answers_json', 'property_id_ref', 'community_id_ref', 'enrollment_key',
  // Reference coordinates (property/community) — the geofence anchor the AI review
  // compares each photo's burned-in capture GPS against.
  'latitude', 'longitude',
  // Community grass-cut billing split (RECURRING_SERVICES_PLAN.md).
  'for_billing', 'master_service_id', 'covered_property_ids', 'covered_property_count', 'per_property_rate', 'split_at',
  'hs_createdate',
];

/** One Service Work Order's raw props by record id, or null (not configured / not found). */
export async function fetchServiceWorkOrder(id: string): Promise<{ id: string; props: Record<string, any> } | null> {
  const typeId = (process.env.HUBSPOT_SERVICE_TYPE_ID || '').trim();
  if (!typeId || !id) return null;
  try {
    const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/${id}?properties=${SERVICE_DETAIL_PROPS.join(',')}`);
    if (resp?.id) {
      const p = resp.properties || {};
      // Community services carry only the name — fill City/ST/ZIP from the
      // community's own location for the record header.
      if (p.scope === 'community' && !String(p.locality_snapshot || '').trim()) {
        let loc = '';
        const idRef = String(p.community_id_ref || '').trim();
        if (idRef) { const c = await fetchCommunityById(idRef).catch(() => null); if (c) loc = formatCommunityLocation({ city: c.city, state: c.state, zip: c.zip }); }
        if (!loc && p.community_name) loc = (await communityLocalityByName().catch(() => new Map<string, string>())).get(String(p.community_name)) || '';
        if (loc) p.locality_snapshot = loc;
      }
      return { id: String(resp.id), props: p };
    }
    return null;
  } catch (e) { console.warn('[services] work order fetch failed:', e); return null; }
}

/**
 * A property's current status + Rently lock telemetry — for the service completion
 * unlock button (shown for cleaning services at non-Tenant-Leased homes) and its
 * online/offline ring. Returns null when the id/lookup fails (fail-open: no button).
 */
export async function fetchPropertyLockInfo(recordId: string): Promise<{ status: string; deviceType: string; hubStatus: string; lockStatus: string; bedrooms: number | null; bathrooms: number | null; squareFootage: number | null; region: string } | null> {
  if (!recordId) return null;
  const { property: typeId } = typeIds();
  const numOrNull = (v: any): number | null => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
  try {
    const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search`, {
      method: 'POST',
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: 'hs_object_id', operator: 'EQ', value: recordId }] }],
        properties: [PROPERTY_STATUS_PROPERTY, 'rently_device_type', 'rently_sh_hub_status', 'rently_sh_lock_status', 'bedrooms', 'bathrooms', 'square_footage', 'region'],
        limit: 1,
      }),
    });
    const p = resp?.results?.[0]?.properties;
    if (!p) return null;
    return {
      status: String(p[PROPERTY_STATUS_PROPERTY] || '').trim(),
      deviceType: String(p.rently_device_type || '').trim(),
      hubStatus: String(p.rently_sh_hub_status || '').trim(),
      lockStatus: String(p.rently_sh_lock_status || '').trim(),
      bedrooms: numOrNull(p.bedrooms), bathrooms: numOrNull(p.bathrooms), squareFootage: numOrNull(p.square_footage),
      region: String(p.region || '').trim(),
    };
  } catch (e) { console.warn('[services] lock info fetch failed:', e); return null; }
}

/** Patch a Service Work Order's properties. Returns false when not configured. */
export async function patchServiceWorkOrder(id: string, props: Record<string, any>): Promise<boolean> {
  const typeId = (process.env.HUBSPOT_SERVICE_TYPE_ID || '').trim();
  if (!typeId || !id) return false;
  await writeObjectResilient(typeId, id, props);
  bustServiceListCache();   // status/vendor/etc changed → invalidate the list
  return true;
}

/** Bid-item children spawned from a parent completion (enrollment_key = bid:<parentId>). */
export async function findServiceBidChildren(parentId: string): Promise<{ id: string; props: Record<string, any> }[]> {
  const typeId = (process.env.HUBSPOT_SERVICE_TYPE_ID || '').trim();
  if (!typeId || !parentId) return [];
  try {
    const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search`, {
      method: 'POST',
      body: JSON.stringify({ limit: 20, properties: SERVICE_DETAIL_PROPS, filterGroups: [{ filters: [{ propertyName: 'enrollment_key', operator: 'EQ', value: `bid:${parentId}` }] }] }),
    });
    return (resp.results || []).map((r: any) => ({ id: String(r.id), props: r.properties || {} }));
  } catch (e) { console.warn('[services] bid children search failed:', e); return []; }
}

/** Service Work Orders in a given status (raw props + id), or null when not configured. */
export async function searchServiceWorkOrdersByStatus(status: string, limit = 200): Promise<{ id: string; props: Record<string, any> }[] | null> {
  const typeId = (process.env.HUBSPOT_SERVICE_TYPE_ID || '').trim();
  if (!typeId) return null;
  try {
    const out: { id: string; props: Record<string, any> }[] = [];
    let after: string | undefined;
    do {
      const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search`, {
        method: 'POST',
        body: JSON.stringify({ limit: 100, after, properties: SERVICE_DETAIL_PROPS, filterGroups: [{ filters: [{ propertyName: 'status', operator: 'EQ', value: status }] }] }),
      });
      for (const r of resp.results || []) out.push({ id: String(r.id), props: r.properties || {} });
      after = resp.paging?.next?.after;
    } while (after && out.length < limit);
    return out;
  } catch (e) { console.warn('[services] status search failed:', e); return null; }
}

/** Delete Service Work Orders (teardown). dry-run lists targets; apply deletes them.
 *  scope: 'generated' = gen:* keys, 'seeded' = seed:* keys, 'test' = both, 'all' = every order. */
export async function purgeServiceWorkOrders(apply: boolean, scope: 'generated' | 'seeded' | 'test' | 'all'): Promise<any> {
  const typeId = (process.env.HUBSPOT_SERVICE_TYPE_ID || '').trim();
  if (!typeId) return { error: 'HUBSPOT_SERVICE_TYPE_ID not set.' };
  const want = (key: string): boolean => {
    if (scope === 'all') return true;
    if (scope === 'generated') return key.startsWith('gen:');
    if (scope === 'seeded') return key.startsWith('seed:');
    return key.startsWith('gen:') || key.startsWith('seed:'); // test
  };
  const targets: { id: string; key: string; name: string }[] = [];
  let after: string | undefined;
  do {
    const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search`, {
      method: 'POST', body: JSON.stringify({ limit: 100, after, properties: ['enrollment_key', 'service_name', 'status'] }),
    });
    for (const r of resp.results || []) {
      const key = String(r.properties?.enrollment_key || '');
      if (want(key)) targets.push({ id: String(r.id), key, name: String(r.properties?.service_name || '') });
    }
    after = resp.paging?.next?.after;
  } while (after);

  const report: any = { mode: apply ? 'apply' : 'dry-run', scope, typeId, total: targets.length, deleted: [], errors: [] };
  if (!apply) { report.wouldDelete = targets.map((t) => ({ id: t.id, name: t.name, key: t.key })); return report; }
  for (const t of targets) {
    try { await hubspotFetch(`/crm/v3/objects/${typeId}/${t.id}`, { method: 'DELETE' }); report.deleted.push(t.id); }
    catch (e: any) { report.errors.push({ id: t.id, error: String(e?.message || e) }); }
  }
  return report;
}

export async function provisionServicesSchema(apply: boolean): Promise<any> {
  const report: any = { mode: apply ? 'apply' : 'dry-run', objects: [], questionAdditions: [], associations: [], envVars: {}, notes: [] };
  const schemas = await hubspotFetch('/crm/v3/schemas').catch(() => ({ results: [] }));
  const existing: any[] = schemas.results || [];
  const findSchema = (name: string) => existing.find((s) => s.name === name || (s.fullyQualifiedName || '').endsWith(`_${name}`));
  const typeIdByName: Record<string, string> = {};

  for (const obj of SERVICE_OBJECTS as ObjectSpec[]) {
    const found = findSchema(obj.name);
    const entry: any = { name: obj.name, label: obj.labels.plural };
    let typeId: string | undefined = found?.objectTypeId;
    try {
      if (!found) {
        if (apply) {
          const created = await hubspotFetch('/crm/v3/schemas', {
            method: 'POST',
            body: JSON.stringify({
              name: obj.name, labels: obj.labels, primaryDisplayProperty: obj.primaryDisplayProperty,
              requiredProperties: [obj.primaryDisplayProperty], secondaryDisplayProperties: [],
              properties: obj.properties.map((p) => propPayload(p)),
            }),
          });
          typeId = created.objectTypeId;
          entry.action = 'created'; entry.typeId = typeId; entry.propertiesCreated = obj.properties.length;
        } else {
          entry.action = 'CREATE'; entry.willCreateProperties = obj.properties.length;
        }
      } else {
        const props = await hubspotFetch(`/crm/v3/properties/${typeId}`).catch(() => ({ results: [] }));
        const liveByName = new Map<string, any>((props.results || []).map((p: any) => [p.name, p]));
        const have = new Set(liveByName.keys());
        const missing = obj.properties.filter((p) => !have.has(p.name));
        entry.action = 'exists'; entry.typeId = typeId; entry.missingProperties = missing.map((p) => p.name);
        if (apply && missing.length) {
          const group = await ensurePropertyGroup(typeId!, `${obj.name}_information`);
          for (const p of missing) await createProperty(typeId!, p, group);
          entry.propertiesCreated = missing.length;
        }
        // Reconcile enum OPTIONS on properties that already exist (e.g. a new
        // subtype like `common_areas`, or a new worktype/status). Additive only.
        const optionAdds: { name: string; added: string[] }[] = [];
        for (const spec of obj.properties as PropSpec[]) {
          if (!spec.options || !spec.options.length) continue;
          const live = liveByName.get(spec.name);
          if (!live || !Array.isArray(live.options)) continue;
          const liveVals = new Set(live.options.map((o: any) => String(o.value)));
          const add = spec.options.filter((o) => !liveVals.has(String(o.value)));
          if (!add.length) continue;
          optionAdds.push({ name: spec.name, added: add.map((o) => o.value) });
          if (apply) {
            await hubspotFetch(`/crm/v3/properties/${typeId}/${spec.name}`, {
              method: 'PATCH',
              body: JSON.stringify({ options: [...live.options, ...add.map((o) => ({ label: o.label, value: o.value, hidden: false }))] }),
            }).catch((err) => { console.warn(`[provision] option add failed for ${spec.name}:`, err); });
          }
        }
        if (optionAdds.length) entry.optionAdds = optionAdds;
      }
    } catch (e: any) {
      entry.action = 'error'; entry.error = String(e?.message || e); entry.detail = e?.detail || null;
    }
    if (typeId) { typeIdByName[obj.name] = typeId; report.envVars[obj.envVar] = typeId; }
    report.objects.push(entry);
  }

  // Additive properties on the reused Question object.
  const { question } = typeIds();
  const qprops = await hubspotFetch(`/crm/v3/properties/${question}`).catch(() => ({ results: [] }));
  const qhave = new Set((qprops.results || []).map((p: any) => p.name));
  const qMissing = QUESTION_ADDITIONS.filter((p) => !qhave.has(p.name));
  const qgroup = apply && qMissing.length ? await ensurePropertyGroup(question, 'service_information') : 'service_information';
  for (const p of QUESTION_ADDITIONS) {
    if (qhave.has(p.name)) { report.questionAdditions.push({ name: p.name, action: 'exists' }); continue; }
    if (apply) { await createProperty(question, p, qgroup); report.questionAdditions.push({ name: p.name, action: 'created' }); }
    else report.questionAdditions.push({ name: p.name, action: 'CREATE' });
  }

  // Labeled associations (need both type ids to exist).
  const resolveTo = async (token: string): Promise<string | undefined> => {
    if (token === 'PROPERTY') return typeIds().property;
    if (token === 'COMPANY') return '0-2';
    if (token === 'COMMUNITY') return (await resolveCommunityMeta())?.typeId;
    return typeIdByName[token];
  };
  for (const a of SERVICE_ASSOCIATIONS) {
    const fromId = typeIdByName[a.from];
    const toId = await resolveTo(a.to);
    const e: any = { name: a.name, from: a.from, to: a.to };
    if (!fromId || !toId) { e.action = apply ? 'skipped (type id not available — run apply after objects exist)' : 'CREATE (after objects exist)'; report.associations.push(e); continue; }
    if (apply) {
      try { await hubspotFetch(`/crm/v4/associations/${fromId}/${toId}/labels`, { method: 'POST', body: JSON.stringify({ label: a.label, name: a.name }) }); e.action = 'created'; }
      catch (err) { e.action = isConflict(err) ? 'exists' : `error: ${String((err as any)?.message || err).slice(0, 100)}`; }
    } else e.action = 'CREATE';
    report.associations.push(e);
  }

  if (apply && report.envVars.HUBSPOT_SERVICE_TYPE_ID) {
    report.notes.push('Set these env vars in Vercel (Preview + Production) so the app resolves the new objects, then redeploy.');
  }
  return report;
}

/**
 * Fetch all Inspection records for the list view (Round A).
 * Returns lightweight summary records sorted by most-recent-first.
 *
 * Sort priority: scheduled_date if set, else completed_at, else createdate (HubSpot built-in).
 */
// Lightweight properties pulled for the list / summary view.
const INSPECTION_LIST_PROPERTIES = [
  'inspection_id_external', 'inspection_name', 'template_type', 'status',
  'property_address_snapshot', 'inspector_name', 'inspector_email',
  'bedrooms_at_inspection', 'bathrooms_at_inspection',
  'started_at', 'completed_at', 'scheduled_date',
  'total_questions_answered',
  'pdf_attachment_url',
  'hs_createdate',
  'last_edited_at', 'hs_lastmodifieddate',
  'total_client_cost',
  'source_rate_card_id', 'source_rate_card_name', 'qc_verdict', 'qc_overall_note',
  // Added for ResiWalk Insights analytics (region filter, turnaround timestamps,
  // pass/fail, photo counts). Harmless extra fields for the home list.
  'region_snapshot', 'submitted_at', 'approved_at', 'approved_by_name',
  'inspection_result', 'total_photos_attached', 'first_photo_at', 'last_photo_at',
  // Property status: the frozen value (set at completion), the sortable snapshot
  // (kept fresh by enrichPropertyStatuses), and the property ref so active rows
  // can be enriched with the live status (see enrichPropertyStatuses).
  'property_status_at_completion', 'property_status_snapshot', 'property_id_ref',
  // Reference coordinates stamped at creation so the calendar map can plot the
  // pin without a live geocode (falls back to client geocoding when absent).
  'latitude', 'longitude',
  // Record Owner — kept in sync TO inspector_name/email by enrichInspectorFromOwner.
  'hubspot_owner_id',
];

/** Map a HubSpot inspection search result into a lightweight InspectionSummary. */
function mapInspectionRow(r: any): InspectionSummary {
  const p = r.properties || {};
  return {
    recordId: r.id,
    inspectionIdExternal: p.inspection_id_external || '',
    inspectionName: p.inspection_name || `(Inspection ${r.id})`,
    templateType: p.template_type || '',
    status: p.status || '',
    propertyAddressSnapshot: p.property_address_snapshot || '',
    inspectorName: p.inspector_name || '',
    inspectorEmail: p.inspector_email || '',
    bedroomsAtInspection: p.bedrooms_at_inspection != null && p.bedrooms_at_inspection !== ''
      ? Number(p.bedrooms_at_inspection) : null,
    bathroomsAtInspection: p.bathrooms_at_inspection != null && p.bathrooms_at_inspection !== ''
      ? Number(p.bathrooms_at_inspection) : null,
    startedAt: p.started_at || null,
    completedAt: p.completed_at || null,
    scheduledDate: p.scheduled_date || null,
    createdAt: p.hs_createdate || null,
    updatedAt: p.last_edited_at || p.hs_lastmodifieddate || null,
    totalQuestionsAnswered: p.total_questions_answered != null && p.total_questions_answered !== ''
      ? Number(p.total_questions_answered) : null,
    pdfUrl: p.pdf_attachment_url || null,
    regionSnapshot: p.region_snapshot || null,
    sectionListJson: p.section_list_json || null,
    pdfMasterUrl: null,
    pdfChargebackUrl: null,
    pdfChargebackXlsxUrl: null,
    pdfVendorUrlsJson: null,
    pdfGeneratedAt: null,
    sourceRateCardId: p.source_rate_card_id || null,
    sourceRateCardName: p.source_rate_card_name || null,
    qcVerdict: (p.qc_verdict === 'pass' || p.qc_verdict === 'fail') ? p.qc_verdict : null,
    qcOverallNote: p.qc_overall_note || null,
    qcPassCount: null,
    qcFailCount: null,
    submittedAt: p.submitted_at || null,
    submittedByEmail: null,
    approvedByName: p.approved_by_name || null,
    approvedAt: p.approved_at || null,
    resolutionTimingJson: null,
    totalClientCost: p.total_client_cost != null && p.total_client_cost !== ''
      ? Number(p.total_client_cost) : null,
    inspectionResult: (p.inspection_result === 'pass' || p.inspection_result === 'fail') ? p.inspection_result : null,
    totalPhotosAttached: p.total_photos_attached != null && p.total_photos_attached !== ''
      ? Number(p.total_photos_attached) : null,
    firstPhotoAt: p.first_photo_at || null,
    lastPhotoAt: p.last_photo_at || null,
    propertyStatusAtCompletion: (p.property_status_at_completion || '').toString().trim() || null,
    // Display value: start from the frozen value (completed rows are done here);
    // active rows get the live status filled in by enrichPropertyStatuses.
    propertyStatus: (p.property_status_at_completion || '').toString().trim() || null,
    propertyRecordId: p.property_id_ref || null,
    lat: (() => { const n = Number(p.latitude); return Number.isFinite(n) && n !== 0 ? n : null; })(),
    lng: (() => { const n = Number(p.longitude); return Number.isFinite(n) && n !== 0 ? n : null; })(),
  };
}

// Status strings that mean the inspection is finished — its property status is
// frozen and should NOT be refreshed from the live property record.
const COMPLETED_STATUS_RE = /^(completed|complete|submitted)$/i;

/**
 * Enrich ACTIVE (non-completed) rows with the property's LIVE lifecycle status,
 * so the home card shows the current status while the inspection is scheduled /
 * in progress / pending approval. Completed rows already carry the frozen
 * `property_status_at_completion` and are left untouched. One batched property
 * read across the page's distinct property ids; best-effort (never throws).
 */
async function enrichPropertyStatuses(items: InspectionSummary[], rawResults: any[]): Promise<void> {
  const { property: propertyTypeId } = typeIds();
  // Map each active row → its property_id_ref + stored snapshot (off the raw search result).
  const refByRow = new Map<string, string>();
  const storedSnapById = new Map<string, string>();
  for (const r of rawResults) {
    const ref = (r.properties?.property_id_ref || '').toString().trim();
    if (ref) refByRow.set(String(r.id), ref);
    storedSnapById.set(String(r.id), (r.properties?.property_status_snapshot || '').toString().trim());
  }
  const active = items.filter((i) => !COMPLETED_STATUS_RE.test((i.status || '').trim()) && refByRow.get(i.recordId));
  const needIds = Array.from(new Set(active.map((i) => refByRow.get(i.recordId)!)));
  if (needIds.length === 0) return;
  try {
    const statusById = new Map<string, string | null>();
    for (let i = 0; i < needIds.length; i += 100) {
      const chunk = needIds.slice(i, i + 100);
      const resp = await hubspotFetch(`/crm/v3/objects/${propertyTypeId}/batch/read`, {
        method: 'POST',
        body: JSON.stringify({ properties: [PROPERTY_STATUS_PROPERTY], inputs: chunk.map((id) => ({ id })) }),
      });
      for (const rec of resp.results || []) {
        statusById.set(String(rec.id), (rec.properties?.[PROPERTY_STATUS_PROPERTY] || '').toString().trim() || null);
      }
    }
    // Fill the in-memory display value, and keep the SORTABLE snapshot in sync.
    // This runs only on a cache miss (the list is cached + single-flighted), and
    // only writes the rows whose snapshot actually drifted (or was never set —
    // backfills legacy records as they're viewed). updateInspection doesn't touch
    // last_edited_at, so refreshing the snapshot never reorders the default sort.
    const writes: Promise<unknown>[] = [];
    for (const it of active) {
      const live = statusById.get(refByRow.get(it.recordId)!);
      if (live) it.propertyStatus = live;
      const liveVal = (live || '').trim();
      if (liveVal && liveVal !== storedSnapById.get(it.recordId)) {
        writes.push(updateInspection(it.recordId, { property_status_snapshot: liveVal }).catch(() => {}));
      }
    }
    if (writes.length) await Promise.allSettled(writes);
  } catch {
    /* best-effort — leave the live status unresolved on failure */
  }
}

/**
 * Keep each row's inspector_name/email in sync with its HubSpot record Owner:
 * when the owner resolves to an email/name different from the stored inspector,
 * update the row in memory AND persist it (so the change "sticks" for the next
 * load and the detail/PDF). Uses only the owners-by-id map (no per-row user
 * fetch); rows whose owner has no usable name are left untouched. Runs only on a
 * cache miss; writes only the rows that drifted. updateInspection doesn't touch
 * last_edited_at, so this never reorders the default sort.
 */
async function enrichInspectorFromOwner(items: InspectionSummary[], rawResults: any[]): Promise<void> {
  const ownerByRow = new Map<string, string>();
  for (const r of rawResults) {
    const oid = (r.properties?.hubspot_owner_id || '').toString().trim();
    if (oid) ownerByRow.set(String(r.id), oid);
  }
  if (ownerByRow.size === 0) return;
  const byId = await fetchOwnersById();
  if (!byId) return;
  const writes: Promise<unknown>[] = [];
  for (const it of items) {
    const oid = ownerByRow.get(it.recordId);
    const owner = oid ? byId.get(oid) : undefined;
    if (!owner || !owner.email) continue;
    const name = `${owner.firstName} ${owner.lastName}`.trim();
    if (!name) continue; // no usable owner name → leave the stored inspector as-is
    const curEmail = (it.inspectorEmail || '').trim().toLowerCase();
    if (owner.email === curEmail && name === (it.inspectorName || '').trim()) continue;
    it.inspectorEmail = owner.email;
    it.inspectorName = name;
    writes.push(updateInspection(it.recordId, { inspector_email: owner.email, inspector_name: name }).catch(() => {}));
  }
  if (writes.length) await Promise.allSettled(writes);
}

/**
 * Batch-read the CURRENT live status of Property records by id. Returns
 * id -> status (current value of PROPERTY_STATUS_PROPERTY). Best-effort: ids
 * that fail/miss are simply absent. Chunked to HubSpot's 100/batch limit.
 *
 * Used by the Insights snapshot, which wants every inspection tagged with its
 * property's status AS IT IS NOW (so "filter by Vacant - On Market" includes
 * completed inspections too) — distinct from the per-inspection FROZEN
 * property_status_at_completion that the home card shows.
 */
export async function batchReadPropertyStatuses(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = Array.from(new Set(ids.filter(Boolean).map(String)));
  if (unique.length === 0) return out;
  const { property: propertyTypeId } = typeIds();
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    try {
      const resp = await hubspotFetch(`/crm/v3/objects/${propertyTypeId}/batch/read`, {
        method: 'POST',
        body: JSON.stringify({ properties: [PROPERTY_STATUS_PROPERTY], inputs: chunk.map((id) => ({ id })) }),
      });
      for (const rec of resp.results || []) {
        const st = (rec.properties?.[PROPERTY_STATUS_PROPERTY] || '').toString().trim();
        if (st) out.set(String(rec.id), st);
      }
    } catch (e) {
      console.warn('[insights] property status batch read failed:', String((e as any)?.message || e).slice(0, 160));
    }
  }
  return out;
}

export async function fetchInspections(opts: { search?: string } = {}): Promise<InspectionSummary[]> {
  const { inspection: typeId } = typeIds();
  // A search term lets the user reach inspections beyond the recent-500 window
  // (address / name / inspector substring match), so old records aren't
  // unreachable from the list.
  const search = (opts.search || '').trim();

  const out: InspectionSummary[] = [];
  let after: string | undefined = undefined;
  let pages = 0;
  // When searching, OR across address / name / inspector via separate filter
  // groups (HubSpot ANDs within a group, ORs between groups).
  const searchGroups = search
    ? [
        { filters: [{ propertyName: 'property_address_snapshot', operator: 'CONTAINS_TOKEN', value: `*${search}*` }] },
        { filters: [{ propertyName: 'inspection_name', operator: 'CONTAINS_TOKEN', value: `*${search}*` }] },
        { filters: [{ propertyName: 'inspector_name', operator: 'CONTAINS_TOKEN', value: `*${search}*` }] },
      ]
    : [];
  const maxPages = search ? 3 : 5;
  do {
    const body: any = {
      filterGroups: searchGroups,
      properties: INSPECTION_LIST_PROPERTIES,
      limit: 100,
      sorts: [{ propertyName: 'hs_createdate', direction: 'DESCENDING' }],
    };
    if (after) body.after = after;
    const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search?archived=false`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    for (const r of resp.results || []) out.push(mapInspectionRow(r));
    after = resp.paging?.next?.after;
    pages++;
    // Cap the default (no-search) list at 500; a search narrows server-side so
    // older records remain reachable by address/name/inspector.
    if (pages >= maxPages) break;
  } while (after);

  return out;
}

// ============================================================================
// Server-side list: filtering, sorting, paging, and status counts.
//
// This is what lets the home screen scale to 10,000+ inspections: instead of
// pulling a recent-500 window and filtering/counting/paging in the browser, the
// query is pushed into HubSpot's search API. Filters + sort + offset paging are
// evaluated server-side, and accurate per-status counts come from each search
// response's `total` (the search API reports the full match count even though
// it only lets you PAGE through the first 10,000 — well within reach once a
// status/inspector/template filter narrows the set).
// ============================================================================

// Status is written lowercase-underscore, but legacy records used other casings;
// match defensively with the known variants.
const STATUS_VARIANTS: Record<string, string[]> = {
  scheduled: ['scheduled', 'Scheduled'],
  in_progress: ['in_progress', 'in progress', 'in-progress', 'In Progress'],
  pending_approval: ['pending_approval', 'pending approval', 'pending-approval', 'pendingapproval', 'Pending Approval'],
  completed: ['completed', 'complete', 'Completed', 'submitted'],
};
const CANCELLED_VARIANTS = ['cancelled', 'canceled', 'Cancelled', 'Canceled'];
// "Open" = everything still in flight: not completed and not cancelled.
const OPEN_EXCLUDE_VARIANTS = [...STATUS_VARIANTS.completed, ...CANCELLED_VARIANTS];

export type InspectionStatusKey = 'all' | 'open' | 'scheduled' | 'in_progress' | 'pending_approval' | 'completed';
export type InspectionSortField = 'date' | 'updated' | 'scheduled' | 'address' | 'inspector' | 'price' | 'property_status';

export interface InspectionQuery {
  search?: string;
  status?: InspectionStatusKey;
  inspectors?: string[];         // exact inspector_name values; empty = no filter
  templates?: string[];          // exact template_type values; empty = no filter
  regions?: string[];            // exact region_snapshot values; empty = no filter
  // External (1099) user's email. When set, applies the restricted visibility
  // rule: only the 1099 inspections assigned to THIS email, plus COMPLETED
  // Scope/Re-Inspect from anyone (view-only). Lists become per-user — callers
  // MUST include this email in any cache key.
  externalEmail?: string | null;
  // State gate for the view-only (Scope/Re-Inspect) set: the exact
  // region_snapshot values an external user has unlocked (regions in the states
  // where they have an inspection of their own — see externalUnlockedView). The
  // completed Scope/Re-Inspect group is restricted to these regions.
  //   • undefined → not gated (back-compat; the list endpoint always sets it),
  //   • []        → no states unlocked yet → the view-only group is dropped
  //                 (the user sees only their OWN 1099s),
  //   • [..]      → restrict the view-only group to these regions.
  // Derived from `externalEmail`, so callers MUST fold it into any cache key.
  externalViewRegions?: string[] | null;
}

export interface InspectionCounts {
  all: number; scheduled: number; in_progress: number; pending_approval: number; completed: number;
}

// AND-filters that constrain a query (everything except the search OR). Inspector
// and template accept multiple values (OR within the dimension via the IN
// operator) so the dropdowns can multi-select.
function inspectionAndFilters(q: InspectionQuery): any[] {
  const filters: any[] = [];
  const status = q.status && q.status !== 'all' ? q.status : '';
  if (status === 'open') {
    // "All Open" — everything except completed (cancelled already excluded).
    filters.push({ propertyName: 'status', operator: 'NOT_IN', values: OPEN_EXCLUDE_VARIANTS });
  } else if (status && STATUS_VARIANTS[status]) {
    filters.push({ propertyName: 'status', operator: 'IN', values: STATUS_VARIANTS[status] });
  } else {
    // "All" still hides cancelled inspections from the field team.
    filters.push({ propertyName: 'status', operator: 'NOT_IN', values: CANCELLED_VARIANTS });
  }
  const templates = (q.templates || []).map((t) => t.trim()).filter((t) => t && t !== 'all');
  if (templates.length) filters.push({ propertyName: 'template_type', operator: 'IN', values: templates });
  const inspectors = (q.inspectors || []).map((n) => n.trim()).filter((n) => n && n !== 'all');
  if (inspectors.length) filters.push({ propertyName: 'inspector_name', operator: 'IN', values: inspectors });
  const regions = (q.regions || []).map((r) => r.trim()).filter((r) => r && r !== 'all');
  if (regions.length) filters.push({ propertyName: 'region_snapshot', operator: 'IN', values: regions });
  return filters;
}

// Inspector + region AND-filters shared by the external allow-groups (template
// and status are set PER allow-group, so they're not included here).
function externalCommonFilters(q: InspectionQuery): any[] {
  const filters: any[] = [];
  const inspectors = (q.inspectors || []).map((n) => n.trim()).filter((n) => n && n !== 'all');
  if (inspectors.length) filters.push({ propertyName: 'inspector_name', operator: 'IN', values: inspectors });
  const regions = (q.regions || []).map((r) => r.trim()).filter((r) => r && r !== 'all');
  if (regions.length) filters.push({ propertyName: 'region_snapshot', operator: 'IN', values: regions });
  return filters;
}

// External (1099) users see a DISJUNCTION: their OWN 1099 inspections (the ones
// whose inspector_email is theirs, any status) PLUS COMPLETED Scope Rate Card /
// Re-Inspect inspections from anyone (view-only). HubSpot ORs across
// filterGroups, so that's up to two "allow-groups". Template narrowing from the
// facet intersects with the allowed set; an all-disallowed selection is ignored
// (falls back to the full allowed set) so the list can never widen beyond policy.
function externalAllowGroups(q: InspectionQuery): { filters: any[] }[] {
  const common = externalCommonFilters(q);
  // The 1099 group is scoped to the inspections assigned to THIS user. Match on
  // inspector_email, accepting both the original and lowercased form so a
  // case-difference (e.g. owner-sync lowercases) can't hide their own work.
  const email = (q.externalEmail || '').trim();
  const ownerValues = Array.from(new Set([email, email.toLowerCase()].filter(Boolean)));
  const ownerFilter = ownerValues.length
    ? [{ propertyName: 'inspector_email', operator: 'IN', values: ownerValues }]
    : [];
  const selected = (q.templates || []).map((t) => t.trim()).filter((t) => t && t !== 'all');
  let editTpls: string[] = [...EXTERNAL_EDIT_TEMPLATES];
  let viewTpls: string[] = [...EXTERNAL_VIEW_TEMPLATES];
  if (selected.length) {
    const e = EXTERNAL_EDIT_TEMPLATES.filter((t) => selected.includes(t));
    const v = EXTERNAL_VIEW_TEMPLATES.filter((t) => selected.includes(t));
    if (e.length || v.length) { editTpls = e; viewTpls = v; } // valid narrowing; else ignore
  }

  const status = q.status && q.status !== 'all' ? q.status : '';
  const groups: { filters: any[] }[] = [];
  // 1099 group: the user's OWN 1099s — the selected status, or all non-cancelled.
  if (editTpls.length) {
    const statusFilter = status === 'open'
      ? { propertyName: 'status', operator: 'NOT_IN', values: OPEN_EXCLUDE_VARIANTS }
      : status && STATUS_VARIANTS[status]
        ? { propertyName: 'status', operator: 'IN', values: STATUS_VARIANTS[status] }
        : { propertyName: 'status', operator: 'NOT_IN', values: CANCELLED_VARIANTS };
    groups.push({ filters: [{ propertyName: 'template_type', operator: 'IN', values: editTpls }, statusFilter, ...ownerFilter, ...common] });
  }
  // Scope / Re-Inspect group: COMPLETED only, and STATE-GATED — restricted to
  // the regions the user has unlocked (regions in the states where they have an
  // inspection of their own). Contributes only when the selected status includes
  // completed (the "all" tab or the "completed" chip). `externalViewRegions`:
  // undefined → not gated; [] → drop the group (no states unlocked); [..] →
  // restrict to those regions.
  const viewRegions = q.externalViewRegions;
  const viewGated = Array.isArray(viewRegions);
  if (viewTpls.length && (status === '' || status === 'completed') && (!viewGated || viewRegions!.length > 0)) {
    const regionGate = viewGated
      ? [{ propertyName: 'region_snapshot', operator: 'IN', values: viewRegions }]
      : [];
    groups.push({ filters: [
      { propertyName: 'template_type', operator: 'IN', values: viewTpls },
      { propertyName: 'status', operator: 'IN', values: STATUS_VARIANTS.completed },
      ...regionGate,
      ...common,
    ] });
  }
  // Safety net: never emit an unfiltered query for an external user.
  if (groups.length === 0) {
    groups.push({ filters: [{ propertyName: 'template_type', operator: 'EQ', value: '__none__' }] });
  }
  return groups;
}

// Compose filterGroups. When searching, replicate the AND-filters into each of
// the three search dimensions (address / name / inspector) so search ANDs with
// the active filters (HubSpot ORs across groups, ANDs within a group).
function inspectionFilterGroups(q: InspectionQuery): any[] {
  if (q.externalEmail) {
    const allow = externalAllowGroups(q);
    const search = (q.search || '').trim();
    if (!search) return allow;
    const token = `*${search}*`;
    // AND the search token into each allow-group (search replicated per field ⇒
    // groups × fields). HubSpot caps filterGroups at 5 AND total filters at 18.
    // Each group can already carry up to 6 filters (template + status + owner/
    // regionGate + selected inspector + selected region + the search token), so
    // with TWO allow-groups we search a SINGLE field (2 groups × 6 = 12 ≤ 18);
    // searching 2 fields would be 4 groups × 6 = 24 → a 400 that breaks the whole
    // list. With one allow-group we can afford all three fields (3 × 6 = 18).
    const fields = allow.length > 1
      ? ['property_address_snapshot']
      : ['property_address_snapshot', 'inspection_name', 'inspector_name'];
    const out: any[] = [];
    for (const g of allow) {
      for (const propertyName of fields) {
        out.push({ filters: [{ propertyName, operator: 'CONTAINS_TOKEN', value: token }, ...g.filters] });
      }
    }
    return out;
  }
  const and = inspectionAndFilters(q);
  const search = (q.search || '').trim();
  if (!search) return [{ filters: and }];
  const token = `*${search}*`;
  return ['property_address_snapshot', 'inspection_name', 'inspector_name'].map((propertyName) => ({
    filters: [{ propertyName, operator: 'CONTAINS_TOKEN', value: token }, ...and],
  }));
}

const SORT_PROPERTY: Record<InspectionSortField, string> = {
  // 'date' is the single combined date sort: it orders on last_edited_at, which
  // we initialize at create to the scheduled date and bump on every edit — so it
  // reads as "updated date, falling back to scheduled date when nothing's been
  // edited yet". This MUST stay a single sort: HubSpot's CRM Search API rejects
  // more than one sort property with a 400 ("too many sorts; max allowed: 1").
  date: 'last_edited_at',
  // 'updated' / 'scheduled' kept as back-compat aliases for any saved view; the
  // UI now offers only the combined 'date'.
  updated: 'last_edited_at',
  scheduled: 'scheduled_date',
  address: 'property_address_snapshot',
  inspector: 'inspector_name',
  price: 'total_client_cost',
  // Property lifecycle status. Sorts on the stored snapshot (kept in sync with
  // the live status by enrichPropertyStatuses + stamped at create/completion),
  // since the live property status isn't a queryable field on the inspection.
  property_status: 'property_status_snapshot',
};

/**
 * Server-side, filtered, sorted, paginated inspection list. Offset paging uses
 * HubSpot's numeric `after` cursor (valid through the first 10,000 results of a
 * query). Returns the page of items plus the full match `total` for the pager.
 */
export async function searchInspectionsPage(params: InspectionQuery & {
  sortField?: InspectionSortField;
  sortDir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}): Promise<{ items: InspectionSummary[]; total: number }> {
  const { inspection: typeId } = typeIds();
  const sortField: InspectionSortField = params.sortField && SORT_PROPERTY[params.sortField]
    ? params.sortField : 'updated';
  const direction = params.sortDir === 'asc' ? 'ASCENDING' : 'DESCENDING';
  const pageSize = Math.min(100, Math.max(1, params.pageSize || 20));
  const page = Math.max(1, params.page || 1);
  const offset = (page - 1) * pageSize;
  // HubSpot's CRM Search API accepts only ONE sort property — passing a second
  // entry returns 400 Bad Request. So sort on the single mapped property
  // (SORT_PROPERTY.updated = 'last_edited_at', matching the card's displayed
  // date). Records with no last_edited_at sort last in DESC and still render via
  // the card's `last_edited_at || hs_lastmodifieddate` display fallback.
  const sorts = [{ propertyName: SORT_PROPERTY[sortField], direction }];
  const body: any = {
    filterGroups: inspectionFilterGroups(params),
    properties: INSPECTION_LIST_PROPERTIES,
    limit: pageSize,
    sorts,
  };
  // HubSpot caps offset paging at 10,000; clamp so a very deep page never errors.
  if (offset > 0) body.after = String(Math.min(offset, Math.max(0, 10000 - pageSize)));
  const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search?archived=false`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const rawResults = resp.results || [];
  const items = rawResults.map(mapInspectionRow);
  const total = typeof resp.total === 'number' ? resp.total : items.length;
  // Enrich Turn Re-Inspect QC rows with the client total of the SCOPE they
  // re-inspect (the re-inspect itself carries no rate-card lines, so its own
  // total_client_cost is empty). One batched read across the distinct source
  // scope ids on this page; best-effort (a failed read just leaves it null).
  // Then fill the LIVE property status on active rows (completed rows keep the
  // frozen value). Both are batched + best-effort; run in parallel.
  await Promise.all([
    enrichReinspectClientTotals(items, typeId),
    enrichPropertyStatuses(items, rawResults),
    enrichInspectorFromOwner(items, rawResults),
  ]);
  return { items, total };
}

/**
 * Display FALLBACK for older re-inspects: a re-inspect's own `total_client_cost`
 * is stamped at create (from its copied scope lines) and by the totals backfill,
 * so the price SORT — which orders on that stored property server-side — and the
 * card's "Client: $x" agree. For re-inspects created before that stamping (whose
 * stored total is still empty), fill the display value from the SOURCE scope's
 * total here so the card isn't blank in the meantime. Only fills the gaps; never
 * overrides a stamped value (which would let display disagree with the sort).
 * Batched, best-effort — never throws.
 */
async function enrichReinspectClientTotals(items: InspectionSummary[], typeId: string): Promise<void> {
  const needIds = Array.from(new Set(
    items
      .filter((i) => i.templateType === 'pm_turn_reinspect_qc' && i.sourceRateCardId && i.totalClientCost == null)
      .map((i) => String(i.sourceRateCardId)),
  ));
  if (needIds.length === 0) return;
  try {
    const totalById = new Map<string, number | null>();
    for (let i = 0; i < needIds.length; i += 100) {
      const chunk = needIds.slice(i, i + 100);
      const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/batch/read`, {
        method: 'POST',
        body: JSON.stringify({ properties: ['total_client_cost'], inputs: chunk.map((id) => ({ id })) }),
      });
      for (const rec of resp.results || []) {
        const raw = rec.properties?.total_client_cost;
        totalById.set(String(rec.id), raw != null && raw !== '' ? Number(raw) : null);
      }
    }
    for (const it of items) {
      if (it.templateType === 'pm_turn_reinspect_qc' && it.sourceRateCardId && it.totalClientCost == null) {
        const t = totalById.get(String(it.sourceRateCardId));
        if (t != null) it.totalClientCost = t;
      }
    }
  } catch {
    /* best-effort enrichment — leave totals null on failure */
  }
}

/**
 * Per-status counts for the filter chips, honoring the active (non-status)
 * filters. One cheap count-only search per chip, run in parallel; the count is
 * read off each search response's `total`.
 */
export async function countInspectionsByStatus(q: InspectionQuery): Promise<InspectionCounts> {
  const { inspection: typeId } = typeIds();
  const keys: InspectionStatusKey[] = ['all', 'scheduled', 'in_progress', 'pending_approval', 'completed'];
  const countOne = async (status: InspectionStatusKey): Promise<number> => {
    const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search?archived=false`, {
      method: 'POST',
      body: JSON.stringify({
        filterGroups: inspectionFilterGroups({ ...q, status }),
        properties: ['hs_object_id'],
        limit: 1,
      }),
    });
    return typeof resp.total === 'number' ? resp.total : (resp.results || []).length;
  };
  // Run the 5 status counts in 2 small waves (≤3 concurrent) instead of all at
  // once. A single cold list load already costs 1 list search + these 5; firing
  // all 5 simultaneously slammed HubSpot's per-second search bucket and was the
  // main driver of the 429 spikes on /api/inspections. Bounding the burst spreads
  // them out. Order-independent — each writes its own slot.
  // 'open' isn't counted server-side (the client derives it as all − completed);
  // it's present here only to satisfy the Record type.
  const out: Record<InspectionStatusKey, number> = { all: 0, open: 0, scheduled: 0, in_progress: 0, pending_approval: 0, completed: 0 };
  const COUNT_CONCURRENCY = 3;
  let idx = 0;
  const worker = async () => {
    while (idx < keys.length) {
      const k = keys[idx++];
      out[k] = await countOne(k);
    }
  };
  await Promise.all(Array.from({ length: Math.min(COUNT_CONCURRENCY, keys.length) }, () => worker()));
  return out;
}

/** Count of CANCELLED inspections (excluded from the analytics snapshot, but
 *  retained as a number for a future cancellation-rate view). Best-effort. */
export async function countInspectionsCancelled(): Promise<number> {
  const { inspection: typeId } = typeIds();
  try {
    const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search?archived=false`, {
      method: 'POST',
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: 'status', operator: 'IN', values: ['cancelled', 'canceled', 'Cancelled', 'Canceled'] }] }],
        properties: ['hs_object_id'],
        limit: 1,
      }),
    });
    return typeof resp.total === 'number' ? resp.total : (resp.results || []).length;
  } catch (e) {
    console.warn('[insights] cancelled count failed:', e);
    return 0;
  }
}

// Bounded scan that collects the requested properties from inspections matching
// `q`. HubSpot has no distinct/aggregation API, so the filter dropdowns derive
// their options from the most-recently-touched matching records. Capped so a
// broad query (e.g. status=all) still costs O(cap), not O(dataset).
const FACET_SCAN_MAX_PAGES = 5; // up to ~500 most-recently-touched matches — plenty for a dropdown, cheap under load

async function scanInspectionProps(q: InspectionQuery, properties: string[]): Promise<any[]> {
  const { inspection: typeId } = typeIds();
  const rows: any[] = [];
  let after: string | undefined;
  let pages = 0;
  do {
    const body: any = {
      filterGroups: inspectionFilterGroups(q),
      properties,
      limit: 100,
      sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
    };
    if (after) body.after = after;
    const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search?archived=false`, {
      method: 'POST', body: JSON.stringify(body),
    });
    for (const r of resp.results || []) rows.push(r.properties || {});
    after = resp.paging?.next?.after;
    pages++;
  } while (after && pages < FACET_SCAN_MAX_PAGES);
  return rows;
}

const distinct = (vals: any[]): string[] =>
  Array.from(new Set(vals.map((v) => String(v || '').trim()).filter(Boolean)));

// ---------------------------------------------------------------------------
// External users' per-STATE view unlock.
//
// An external (1099) user only sees completed Scope/Re-Inspect inspections in
// STATES where they have an inspection of their OWN. They start with nothing;
// the first inspection they're assigned in (say) FL unlocks view-only access to
// every completed Turn / QC in all FL regions. Their own 1099s define the
// unlocked states (any template/status counts). Cached per email — states
// change rarely, only when the user starts work in a new state — and busted on
// create (bustExternalUnlockedView).
// ---------------------------------------------------------------------------
const unlockedViewCache = new Map<string, { data: { states: string[]; regions: string[] }; at: number }>();
const UNLOCKED_VIEW_TTL_MS = 5 * 60 * 1000;

/** Drop the cached unlock for one email (after they create an inspection), or
 *  all of them when called with no argument. */
export function bustExternalUnlockedView(email?: string | null): void {
  const key = (email || '').trim().toLowerCase();
  if (key) unlockedViewCache.delete(key);
  else unlockedViewCache.clear();
}

/**
 * The states an external user has unlocked, plus the region_snapshot values
 * within them. `states` are distinct 2-letter codes (e.g. ['FL','GA']) derived
 * from the regions on the inspections ASSIGNED to this email. `regions` is every
 * region_snapshot value (the canonical region matrix, unioned with the user's
 * own observed regions) whose state is unlocked — used as the IN-filter that
 * scopes the completed Scope/QC they may see. Empty arrays when they have no
 * inspections yet (the clean first-login state).
 */
export async function externalUnlockedView(
  email: string | null | undefined,
): Promise<{ states: string[]; regions: string[] }> {
  const key = (email || '').trim().toLowerCase();
  if (!key) return { states: [], regions: [] };
  const hit = unlockedViewCache.get(key);
  if (hit && Date.now() - hit.at < UNLOCKED_VIEW_TTL_MS) return hit.data;

  const { inspection: typeId } = typeIds();
  const ownerValues = Array.from(new Set([(email || '').trim(), key].filter(Boolean)));

  // Scan the user's OWN inspections (matched on inspector_email, any template /
  // status) for their region_snapshot values.
  const ownRegions: string[] = [];
  let scanFailed = false;
  try {
    let after: string | undefined;
    let pages = 0;
    do {
      const body: any = {
        filterGroups: [{ filters: [{ propertyName: 'inspector_email', operator: 'IN', values: ownerValues }] }],
        properties: ['region_snapshot'],
        limit: 100,
        sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
      };
      if (after) body.after = after;
      const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search?archived=false`, {
        method: 'POST', body: JSON.stringify(body),
      });
      for (const r of resp.results || []) {
        const v = (r.properties?.region_snapshot || '').toString().trim();
        if (v) ownRegions.push(v);
      }
      after = resp.paging?.next?.after;
      pages++;
    } while (after && pages < 20);
  } catch (e) {
    console.warn('[externalUnlockedView] own-inspection scan failed:', e);
    scanFailed = true;
  }

  const states = Array.from(new Set(ownRegions.map((r) => stateOfRegion(r)).filter(Boolean)));
  if (states.length === 0) {
    // Do NOT cache when the scan errored: "scan failed" must not be frozen as
    // "user has unlocked nothing" for the full TTL — that would hide every
    // completed Scope/Re-Inspect this 1099 user is allowed to view for 5 minutes
    // after a transient HubSpot blip. Return restrictive for THIS request but let
    // the next one re-attempt.
    const data = { states: [], regions: [] };
    if (!scanFailed) unlockedViewCache.set(key, { data, at: Date.now() });
    return data;
  }

  // Expand to every region in those states: the canonical region matrix (so a
  // sibling region the user hasn't personally worked still counts) unioned with
  // their own observed regions (in case one isn't in the matrix).
  let regionUniverse: string[] = [];
  try {
    regionUniverse = (await fetchRegionRates()).map((r) => r.region).filter(Boolean);
  } catch (e) {
    console.warn('[externalUnlockedView] region matrix load failed:', e);
    scanFailed = true; // don't cache a region set missing the sibling regions (below)
  }
  const stateSet = new Set(states);
  const regions = Array.from(new Set(
    [...regionUniverse, ...ownRegions].filter((r) => stateSet.has(stateOfRegion(r))),
  ));

  const data = { states, regions };
  // Do NOT cache a DEGRADED result: if the region-matrix load failed, `regions`
  // is missing the sibling regions in the unlocked states, which would
  // over-restrict the completed Scope/Re-Inspect view for the full TTL. Return
  // it for THIS request but let the next one re-attempt (mirrors the own-scan
  // failure guard above).
  if (!scanFailed) unlockedViewCache.set(key, { data, at: Date.now() });
  return data;
}

/**
 * Options for the inspector + template filter dropdowns, computed DEPENDENTLY:
 * each dimension is constrained by the OTHER active filters (exclude-self
 * faceting). So choosing a status narrows both dropdowns to names/templates that
 * exist within it; choosing an inspector narrows the template options to that
 * inspector's templates; and so on. Inspector options list only names that
 * actually appear on inspections. External (1099) users only ever see their one
 * template.
 */
export async function inspectionFacets(query: InspectionQuery): Promise<{ inspectors: string[]; templates: string[]; regions: string[] }> {
  const extEmail = query.externalEmail || null;
  // Each dimension's options IGNORE that dimension's own selection (so you can
  // change it) but respect the OTHER active filters. The external visibility
  // rule (own 1099 + completed Scope/Re-Inspect) is carried through
  // `externalEmail`, so every scan is already bounded to what the user may see.
  const extViewRegions = query.externalViewRegions;
  const inspectorQ: InspectionQuery = { search: query.search, status: query.status, templates: query.templates, regions: query.regions, externalEmail: extEmail, externalViewRegions: extViewRegions };
  const templateQ: InspectionQuery = { search: query.search, status: query.status, inspectors: query.inspectors, regions: query.regions, externalEmail: extEmail, externalViewRegions: extViewRegions };
  const regionQ: InspectionQuery = { search: query.search, status: query.status, inspectors: query.inspectors, templates: query.templates, externalEmail: extEmail, externalViewRegions: extViewRegions };
  const noneSelected = (query.inspectors?.length || 0) === 0
    && (query.templates?.length || 0) === 0
    && (query.regions?.length || 0) === 0;

  let inspectors: string[] = [];
  let templates: string[] = [];
  let regions: string[] = [];
  try {
    if (noneSelected) {
      // No dimension selected → all share one constraint; single combined scan.
      const rows = await scanInspectionProps(inspectorQ, ['inspector_name', 'template_type', 'region_snapshot']);
      inspectors = distinct(rows.map((p) => p.inspector_name));
      templates = distinct(rows.map((p) => p.template_type));
      regions = distinct(rows.map((p) => p.region_snapshot));
    } else {
      // A dimension is selected → scan each list under the OTHER filters (parallel).
      const [iRows, tRows, rRows] = await Promise.all([
        scanInspectionProps(inspectorQ, ['inspector_name']),
        scanInspectionProps(templateQ, ['template_type']),
        scanInspectionProps(regionQ, ['region_snapshot']),
      ]);
      inspectors = distinct(iRows.map((p) => p.inspector_name));
      templates = distinct(tRows.map((p) => p.template_type));
      regions = distinct(rRows.map((p) => p.region_snapshot));
    }
  } catch (e) {
    console.warn('[facets] scan failed:', e);
  }
  inspectors.sort((a, b) => a.localeCompare(b));
  regions = regions.filter(Boolean).sort((a, b) => a.localeCompare(b));
  return { inspectors, templates, regions };
}

/**
 * List "Scheduled" inspections whose scheduled_date is at least `daysPastDue`
 * days in the past — the stale ones an inspector never started. Used by the
 * auto-cancel cron. Only status=scheduled is returned (in_progress / completed /
 * cancelled are excluded by the status filter), and records with no
 * scheduled_date can't be judged past-due so the LT filter naturally skips them.
 * Oldest-scheduled first; capped at `max` per sweep (the daily cron drains any
 * backlog over subsequent runs).
 */
export async function listStaleScheduledInspections(
  daysPastDue: number,
  max = 500,
): Promise<Array<{ recordId: string; inspectionName: string; scheduledDate: string | null }>> {
  const { inspection: typeId } = typeIds();
  const cutoffMs = Date.now() - Math.max(0, daysPastDue) * 864e5;
  const out: Array<{ recordId: string; inspectionName: string; scheduledDate: string | null }> = [];
  let after: string | undefined;
  let pages = 0;
  const maxPages = Math.max(1, Math.ceil(max / 100));
  do {
    const body: any = {
      filterGroups: [{
        filters: [
          { propertyName: 'status', operator: 'IN', values: STATUS_VARIANTS.scheduled },
          { propertyName: 'scheduled_date', operator: 'LT', value: String(cutoffMs) },
        ],
      }],
      properties: ['inspection_name', 'scheduled_date', 'status'],
      limit: 100,
      sorts: [{ propertyName: 'scheduled_date', direction: 'ASCENDING' }], // most overdue first
    };
    if (after) body.after = after;
    const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search?archived=false`, {
      method: 'POST', body: JSON.stringify(body),
    });
    for (const r of resp.results || []) {
      out.push({
        recordId: r.id,
        inspectionName: r.properties?.inspection_name || `(Inspection ${r.id})`,
        scheduledDate: r.properties?.scheduled_date || null,
      });
      if (out.length >= max) return out;
    }
    after = resp.paging?.next?.after;
    pages++;
  } while (after && pages < maxPages);
  return out;
}

/**
 * For the QC Turn Re-Inspect flow: list a property's Scope Rate Card
 * inspections that are submitted/completed (the only ones worth validating).
 * Sorted most-recently-submitted first so the picker can default to the top.
 *
 * "Submitted" here means status is completed (PDFs generated) OR pending
 * approval (submitted but not yet finalized). We surface both because a QC may
 * be kicked off as soon as the scope is submitted, before final approval.
 */
export interface SourceRateCardOption {
  recordId: string;
  inspectionName: string;
  status: string;
  submittedAt: string | null;   // completed_at, else started_at, else created
}

export async function fetchSourceRateCardInspections(
  propertyRecordId: string
): Promise<SourceRateCardOption[]> {
  const { inspection: typeId } = typeIds();
  const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search?archived=false`, {
    method: 'POST',
    body: JSON.stringify({
      filterGroups: [
        {
          filters: [
            { propertyName: 'property_id_ref', operator: 'EQ', value: propertyRecordId },
            { propertyName: 'template_type', operator: 'EQ', value: 'pm_scope_rate_card' },
          ],
        },
      ],
      properties: [
        'inspection_name', 'status', 'completed_at', 'started_at', 'hs_createdate',
        'property_address_snapshot',
      ],
      limit: 100,
    }),
  });

  const out: SourceRateCardOption[] = [];
  for (const r of resp.results || []) {
    const p = r.properties || {};
    const status = (p.status || '').trim().toLowerCase();
    // Only submitted/completed sources are selectable.
    const isSubmitted =
      status === 'completed' || status === 'complete' || status === 'submitted' ||
      status === 'pending approval' || status === 'pending_approval' ||
      status === 'pending-approval' || status === 'pendingapproval';
    if (!isSubmitted) continue;
    out.push({
      recordId: r.id,
      inspectionName: p.inspection_name || `(Inspection ${r.id})`,
      status: p.status || '',
      submittedAt: p.completed_at || p.started_at || p.hs_createdate || null,
    });
  }

  // Most recently submitted first. Parse epoch-ms or ISO.
  const ts = (s: string | null): number => {
    if (!s) return 0;
    if (/^\d+$/.test(s)) return Number(s);
    const t = Date.parse(s);
    return isNaN(t) ? 0 : t;
  };
  out.sort((a, b) => ts(b.submittedAt) - ts(a.submittedAt));
  return out;
}

/**
 * Fetch all active HubSpot users. Requires settings.users.read scope.
 * Returns: list of {id, email, firstName, lastName, fullName}.
 */
export async function fetchUsers(): Promise<HubSpotUser[]> {
  const out: HubSpotUser[] = [];
  let after: string | undefined = undefined;
  do {
    const qs = new URLSearchParams({ limit: '100' });
    if (after) qs.set('after', after);
    const resp = await hubspotFetch(`/settings/v3/users?${qs.toString()}`);
    for (const u of resp.results || []) {
      const firstName = u.firstName || '';
      const lastName = u.lastName || '';
      const email = u.email || '';
      // Some users have no name set; fall back to email username
      let fullName = `${firstName} ${lastName}`.trim();
      if (!fullName) fullName = email.split('@')[0] || `(User ${u.id})`;
      out.push({
        id: String(u.id),
        email,
        firstName,
        lastName,
        fullName,
      });
    }
    after = resp.paging?.next?.after;
  } while (after);
  out.sort((a, b) => a.fullName.localeCompare(b.fullName));
  return out;
}

// Active HubSpot users only. A user that's deactivated/removed has their OWNER
// record archived, so the set of non-archived owners is the authoritative
// "currently active" list. The owner record ALSO carries the person's
// firstName/lastName — which /settings/v3/users frequently leaves blank — so we
// capture those here too and use them to resolve a real display name (instead of
// falling back to the email username like "asanders"). Cached briefly (login
// hits this a few times per sign-in). Returns null on error so callers fail OPEN
// (don't lock everyone out during an owners-API hiccup).
interface OwnerNameInfo { email: string; firstName: string; lastName: string }
let _activeOwnersCache: { byEmail: Map<string, OwnerNameInfo>; at: number } | null = null;
const ACTIVE_OWNERS_TTL_MS = 5 * 60 * 1000;
async function fetchActiveOwners(): Promise<Map<string, OwnerNameInfo> | null> {
  if (_activeOwnersCache && Date.now() - _activeOwnersCache.at < ACTIVE_OWNERS_TTL_MS) {
    return _activeOwnersCache.byEmail;
  }
  try {
    const byEmail = new Map<string, OwnerNameInfo>();
    let after: string | undefined;
    do {
      const qs = new URLSearchParams({ limit: '100', archived: 'false' });
      if (after) qs.set('after', after);
      const resp = await hubspotFetch(`/crm/v3/owners/?${qs.toString()}`);
      for (const o of resp.results || []) {
        const email = String(o.email || '').trim().toLowerCase();
        if (!email) continue;
        byEmail.set(email, { email, firstName: o.firstName || '', lastName: o.lastName || '' });
      }
      after = resp.paging?.next?.after;
    } while (after);
    _activeOwnersCache = { byEmail, at: Date.now() };
    return byEmail;
  } catch (e) {
    console.warn('[auth] could not load active owners; falling back to all users:', e);
    return null;
  }
}

// ownerId -> {email, firstName, lastName}, so an inspection's hubspot_owner_id
// can be resolved to a display name + email (for the owner→inspector sync).
// Cached briefly like fetchActiveOwners. Returns null on error (callers no-op).
let _ownersByIdCache: { byId: Map<string, OwnerNameInfo>; at: number } | null = null;
async function fetchOwnersById(): Promise<Map<string, OwnerNameInfo> | null> {
  if (_ownersByIdCache && Date.now() - _ownersByIdCache.at < ACTIVE_OWNERS_TTL_MS) {
    return _ownersByIdCache.byId;
  }
  try {
    const byId = new Map<string, OwnerNameInfo>();
    let after: string | undefined;
    do {
      const qs = new URLSearchParams({ limit: '100', archived: 'false' });
      if (after) qs.set('after', after);
      const resp = await hubspotFetch(`/crm/v3/owners/?${qs.toString()}`);
      for (const o of resp.results || []) {
        const email = String(o.email || '').trim().toLowerCase();
        byId.set(String(o.id), { email, firstName: o.firstName || '', lastName: o.lastName || '' });
      }
      after = resp.paging?.next?.after;
    } while (after);
    _ownersByIdCache = { byId, at: Date.now() };
    return byId;
  } catch (e) {
    console.warn('[owner-sync] could not load owners by id:', e);
    return null;
  }
}

/**
 * Resolve a HubSpot owner id to the inspector display name + email. The name is
 * repaired from the user record when the owner record's name is blank (same
 * logic as create/login), so we never fall back to an email username when a real
 * name exists. Returns null when the id is unknown or has no email.
 */
async function resolveOwnerInspector(ownerId: string): Promise<{ name: string; email: string } | null> {
  const id = (ownerId || '').trim();
  if (!id) return null;
  const byId = await fetchOwnersById();
  const owner = byId?.get(id);
  if (!owner || !owner.email) return null;
  let name = `${owner.firstName} ${owner.lastName}`.trim();
  if (!name) {
    try {
      const u = (await fetchActiveUsers()).find((x) => x.email.trim().toLowerCase() === owner.email);
      name = (u?.fullName && !u.fullName.includes('@')) ? u.fullName : owner.email.split('@')[0];
    } catch { name = owner.email.split('@')[0]; }
  }
  return { name, email: owner.email };
}

/**
 * Keep the app's inspector fields in sync with the inspection's HubSpot record
 * Owner: when `hubspot_owner_id` resolves to an owner whose email/name differs
 * from the stored `inspector_email`/`inspector_name`, re-stamp those two fields
 * (the app's source of truth) from the owner. Best-effort, idempotent (no-op
 * once in sync); returns the resolved inspector when it changed, else null.
 *
 * `props` may be passed to avoid a re-read when the caller already has them.
 */
export async function syncInspectorFromOwner(
  recordId: string,
  props?: { hubspot_owner_id?: string; inspector_email?: string; inspector_name?: string },
): Promise<{ name: string; email: string } | null> {
  try {
    let p = props;
    if (!p) {
      const read = await readInspectionProps(recordId, ['hubspot_owner_id', 'inspector_email', 'inspector_name']);
      p = read || {};
    }
    // A 1099 (external) agent OWNS their walk via inspector_email — never via the
    // HubSpot record owner. HubSpot can auto-assign a default/internal owner on
    // create (the private-app user, or a property-inherited PM), and syncing that
    // back over an external inspector would silently reassign the walk away from
    // the agent: their own inspection then drops out of their scoped home list AND
    // every subsequent write is denied with "You can only edit or cancel your own
    // inspections." Internal users never feel this (they aren't ownership-gated),
    // so it hit 1099 agents specifically. Owner→inspector sync is an INTERNAL-staff
    // reassignment convenience only; leave external inspectors untouched.
    if (isExternalEmail((p.inspector_email || '').toString().trim())) return null;
    const ownerId = (p.hubspot_owner_id || '').toString().trim();
    if (!ownerId) return null;
    const resolved = await resolveOwnerInspector(ownerId);
    if (!resolved) return null;
    const curEmail = (p.inspector_email || '').toString().trim().toLowerCase();
    const curName = (p.inspector_name || '').toString().trim();
    if (resolved.email === curEmail && resolved.name === curName) return null; // already in sync
    await updateInspection(recordId, { inspector_email: resolved.email, inspector_name: resolved.name });
    return resolved;
  } catch (e) {
    console.warn(`[syncInspectorFromOwner] ${recordId} skipped:`, e);
    return null;
  }
}

/**
 * One-shot repair: re-stamp an inspection's inspector_email / inspector_name back
 * to a specific (usually 1099-agent) email. Used to recover walks whose inspector
 * was silently reassigned to an internal HubSpot owner by the old owner-sync (see
 * syncInspectorFromOwner). The display name is resolved from the active-users list
 * (same logic as create) so we never persist an email-username fallback.
 *
 * Returns { ok, before, after } — `before` is the current stored inspector_email
 * so the caller can preview / audit the change. `dryRun` reads only, writes nothing.
 */
export async function repairInspectorEmail(
  recordId: string,
  inspectorEmail: string,
  opts: { dryRun?: boolean } = {},
): Promise<{ ok: boolean; before: string; after: string; name: string; note?: string }> {
  const want = (inspectorEmail || '').trim();
  if (!recordId || !want) return { ok: false, before: '', after: '', name: '', note: 'missing recordId or email' };

  const cur = await readInspectionProps(recordId, ['inspector_email', 'inspector_name', 'template_type']);
  if (!cur) return { ok: false, before: '', after: '', name: '', note: 'inspection not found' };
  const before = (cur.inspector_email || '').toString().trim();

  // Resolve a real display name for the target email (falls back to the current
  // stored name, then the email username) — mirrors create's name resolution.
  let name = (cur.inspector_name || '').toString().trim();
  try {
    const match = (await fetchActiveUsers()).find((u) => (u.email || '').trim().toLowerCase() === want.toLowerCase());
    if (match?.fullName && !match.fullName.includes('@')) name = match.fullName;
  } catch { /* best-effort */ }
  if (!name || name.includes('@')) name = want.split('@')[0];

  if (opts.dryRun) return { ok: true, before, after: want, name, note: 'dry-run (no write)' };

  await updateInspection(recordId, { inspector_email: want, inspector_name: name });
  // The walk re-enters the agent's scoped home list + may re-unlock a state's view.
  if (isExternalEmail(want)) bustExternalUnlockedView(want);
  return { ok: true, before, after: want, name };
}

/**
 * Active HubSpot users — fetchUsers() filtered to those whose owner is NOT
 * archived (i.e. the account hasn't been deactivated/removed). This is the gate
 * sign-in must use so a deactivated user can't authenticate. It also REPAIRS the
 * display name: /settings/v3/users often returns blank firstName/lastName (which
 * made fullName fall back to the email username, e.g. "asanders"), so we prefer
 * the owner record's name when the users record has none. If the owners list
 * can't be loaded, falls back to all users (fail-open) so an API hiccup can't
 * lock everyone out.
 */
export async function fetchActiveUsers(): Promise<HubSpotUser[]> {
  const [users, owners] = await Promise.all([fetchUsers(), fetchActiveOwners()]);
  if (!owners) return users; // owners unavailable → don't break login
  const out: HubSpotUser[] = [];
  for (const u of users) {
    const owner = owners.get(u.email.trim().toLowerCase());
    if (!owner) continue; // not an active owner → deactivated, exclude
    const firstName = u.firstName || owner.firstName || '';
    const lastName = u.lastName || owner.lastName || '';
    let fullName = `${firstName} ${lastName}`.trim();
    if (!fullName) fullName = u.email.split('@')[0] || u.fullName;
    out.push({ ...u, firstName, lastName, fullName });
  }
  out.sort((a, b) => a.fullName.localeCompare(b.fullName));
  return out;
}

// Association type IDs are stable, provisioned-once metadata, but were being
// re-fetched on EVERY answer-create batch (two lookups per save). Under hundreds
// of concurrent autosaves that's a large, avoidable multiplier on HubSpot's
// association-labels endpoint, so memoize the resolved id. Only a FOUND id is
// cached (forever); a miss stays uncached so a label provisioned later is picked
// up without a cold start.
const _assocTypeIdCache = new Map<string, number>();
async function getAssociationTypeId(fromTypeId: string, toTypeId: string, label: string): Promise<number | null> {
  const key = `${fromTypeId}:${toTypeId}:${label}`;
  const cached = _assocTypeIdCache.get(key);
  if (cached !== undefined) return cached;
  const resp = await hubspotFetch(assocLabelsUrl(fromTypeId, toTypeId));
  for (const a of resp.results || []) {
    if (a.label === label) { _assocTypeIdCache.set(key, a.typeId); return a.typeId; }
  }
  return null;
}

// Fallback: return the first available association type between two objects
// (prefers an unlabeled/primary type). Used when a specifically-labeled type
// isn't found, so answers still get associated to their inspection rather than
// being created orphaned (which would make them invisible on reopen).
async function getDefaultAssociationTypeId(fromTypeId: string, toTypeId: string): Promise<number | null> {
  const resp = await hubspotFetch(assocLabelsUrl(fromTypeId, toTypeId));
  const results = resp.results || [];
  if (results.length === 0) return null;
  // Prefer a type with no custom label (the primary/unlabeled association).
  const unlabeled = results.find((a: any) => !a.label);
  return (unlabeled?.typeId ?? results[0]?.typeId) ?? null;
}

/**
 * Resolve a usable Inspection<->Property association type, creating one if it
 * doesn't exist yet. Returns the direction to associate in (HubSpot links are
 * bidirectional, so associating either way connects the records):
 *   { fromTypeId, toTypeId, typeId, reversed }
 * `reversed` = true means associate Property->Inspection (fromId=property).
 * Returns null only if no type exists AND one can't be created (missing scope).
 */
type AssocResolution = { fromTypeId: string; toTypeId: string; typeId: number; reversed: boolean };
let _inspPropAssocCache: AssocResolution | null = null;
async function resolveInspToPropertyAssoc(): Promise<AssocResolution | null> {
  if (_inspPropAssocCache) return _inspPropAssocCache;
  const { inspection, property } = typeIds();

  // 1) Inspection -> Property: prefer the "Property" label, else the default.
  let t = await getAssociationTypeId(inspection, property, 'Property');
  if (t == null) t = await getDefaultAssociationTypeId(inspection, property);
  if (t != null) return (_inspPropAssocCache = { fromTypeId: inspection, toTypeId: property, typeId: t, reversed: false });

  // 2) Property -> Inspection (reverse) — associating that way links them too.
  const r = await getDefaultAssociationTypeId(property, inspection);
  if (r != null) return (_inspPropAssocCache = { fromTypeId: property, toTypeId: inspection, typeId: r, reversed: true });

  // 3) Neither exists — create a labeled association type Inspection -> Property.
  try {
    const created = await hubspotFetch(assocLabelsUrl(inspection, property), {
      method: 'POST',
      body: JSON.stringify({ label: 'Property', name: 'inspection_to_property' }),
    });
    const newId = created?.results?.[0]?.typeId ?? created?.typeId ?? created?.results?.[0]?.associationTypeId;
    if (newId != null) return (_inspPropAssocCache = { fromTypeId: inspection, toTypeId: property, typeId: Number(newId), reversed: false });
    console.warn('Created Inspection->Property assoc but no typeId in response:', JSON.stringify(created).slice(0, 300));
  } catch (e) {
    console.warn('Could not create Inspection->Property association type:', e);
  }
  return null;
}

/** Associate one inspection to its property, resolving/creating the type as needed. */
async function associateInspectionToProperty(inspectionId: string, propertyId: string): Promise<boolean> {
  const a = await resolveInspToPropertyAssoc();
  if (!a) return false;
  const pair = a.reversed ? { fromId: propertyId, toId: inspectionId } : { fromId: inspectionId, toId: propertyId };
  const r = await batchCreateAssociations(a.fromTypeId, a.toTypeId, a.typeId, [pair]);
  return r.failed === 0;
}

async function createInspection(props: Record<string, any>): Promise<string> {
  const { inspection: typeId } = typeIds();
  const resp = await hubspotFetch(`/crm/v3/objects/${typeId}`, {
    method: 'POST',
    body: JSON.stringify({ properties: props }),
  });
  return resp.id;
}

const HUBSPOT_BATCH_LIMIT = 100;

async function createAnswers(answersProps: Record<string, any>[]): Promise<Array<{externalId: string; recordId: string}>> {
  const { answer: typeId } = typeIds();
  if (answersProps.length === 0) return [];

  const out: Array<{externalId: string; recordId: string}> = [];

  // HubSpot limits batch/create to 100 inputs per call. Chunk to stay under.
  for (let i = 0; i < answersProps.length; i += HUBSPOT_BATCH_LIMIT) {
    const chunk = answersProps.slice(i, i + HUBSPOT_BATCH_LIMIT);
    const inputs = chunk.map((p) => ({ properties: p }));
    const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/batch/create`, {
      method: 'POST',
      body: JSON.stringify({ inputs }),
    });
    for (const r of (resp.results || [])) {
      out.push({
        externalId: r.properties?.answer_id_external || '',
        recordId: r.id,
      });
    }
  }
  return out;
}

export interface SubmitInput {
  inspectionProps: Record<string, any>;
  answersProps: Array<{
    answerProps: Record<string, any>;
    questionHubspotRecordId: string | null;
  }>;
  propertyRecordId: string;
}

/**
 * Batch-create labeled associations between two object types using the
 * date-based 2026-03 associations API. Up to 2,000 pairs per call
 * (we chunk at 1,000 for safety).
 *
 * Used both for true bulk operations (Inspection->Answer) AND for single-pair
 * associations (Inspection->Property), to avoid the now-deprecated v4 single
 * PUT endpoint which has no clean labeled date-based equivalent.
 */
async function batchCreateAssociations(
  fromTypeId: string,
  toTypeId: string,
  assocTypeId: number,
  pairs: Array<{ fromId: string; toId: string }>
): Promise<{ ok: number; failed: number }> {
  if (pairs.length === 0) return { ok: 0, failed: 0 };
  const CHUNK_SIZE = 1000;
  let ok = 0, failed = 0;
  for (let i = 0; i < pairs.length; i += CHUNK_SIZE) {
    const chunk = pairs.slice(i, i + CHUNK_SIZE);
    const inputs = chunk.map(({ fromId, toId }) => ({
      from: { id: fromId },
      to: { id: toId },
      types: [{ associationCategory: 'USER_DEFINED', associationTypeId: assocTypeId }],
    }));
    try {
      const resp = await hubspotFetch(assocBatchCreateUrl(fromTypeId, toTypeId), {
        method: 'POST',
        body: JSON.stringify({ inputs }),
      });
      ok += (resp.results || []).length;
      const numErrors = resp.numErrors || (resp.errors?.length || 0);
      failed += numErrors;
      if (numErrors > 0) {
        console.warn(`batch/create assoc partial failure: ${numErrors} of ${chunk.length}`,
          JSON.stringify(resp.errors).slice(0, 500));
      }
    } catch (e) {
      console.warn(`Batch create associations chunk failed (${chunk.length} pairs):`, e);
      failed += chunk.length;
    }
  }
  return { ok, failed };
}

export async function submitInspection(input: SubmitInput): Promise<{ inspectionId: string }> {
  const tids = typeIds();

  const [inspToAnswer, qToAnswer] = await Promise.all([
    getAssociationTypeId(tids.inspection, tids.answer, 'Answer of'),
    getAssociationTypeId(tids.question, tids.answer, 'Answer to'),
  ]);

  const inspectionId = await createInspection(input.inspectionProps);
  const answerResults = await createAnswers(input.answersProps.map((a) => a.answerProps));

  // Inspection -> Property (resolves/creates the association type as needed).
  const propOk = await associateInspectionToProperty(inspectionId, input.propertyRecordId);
  if (!propOk) console.warn('Inspection->Property association not created');

  // Inspection -> Answers (batch)
  if (inspToAnswer != null && answerResults.length > 0) {
    const pairs = answerResults.map((r) => ({ fromId: inspectionId, toId: r.recordId }));
    const result = await batchCreateAssociations(tids.inspection, tids.answer, inspToAnswer, pairs);
    if (result.failed > 0) console.warn(`Inspection->Answer: ${result.failed} associations failed of ${pairs.length}`);
  }

  // Question -> Answer (batch; skip null question records like section_photo)
  if (qToAnswer != null) {
    const qaPairs: Array<{ fromId: string; toId: string }> = [];
    for (let i = 0; i < answerResults.length; i++) {
      const qid = input.answersProps[i].questionHubspotRecordId;
      if (!qid) continue;
      qaPairs.push({ fromId: qid, toId: answerResults[i].recordId });
    }
    if (qaPairs.length > 0) {
      const result = await batchCreateAssociations(tids.question, tids.answer, qToAnswer, qaPairs);
      if (result.failed > 0) console.warn(`Question->Answer: ${result.failed} associations failed of ${qaPairs.length}`);
    }
  }

  return { inspectionId };
}

/**
 * One-time / maintenance backfill: ensure EVERY existing inspection is associated
 * to its Property object. Reads each inspection's `property_id_ref`, then
 * (re)creates the Inspection->Property association in batches. Re-creating an
 * existing association is a harmless no-op, so this is safe to run repeatedly.
 */
export async function backfillInspectionPropertyAssociations(): Promise<{
  scanned: number; withRef: number; associated: number; failed: number; missingRef: number;
}> {
  const tids = typeIds();
  const assoc = await resolveInspToPropertyAssoc();
  if (!assoc) throw new Error('No Inspection<->Property association type exists in HubSpot, and one could not be created (the API token likely lacks association-schema write scope). Create an Inspection→Property association in HubSpot Settings, then re-run.');

  // Page through every inspection record, collecting (inspectionId, propertyId)
  // and orienting each pair per the resolved association direction.
  const pairs: Array<{ fromId: string; toId: string }> = [];
  let scanned = 0; let missingRef = 0;
  let after: string | undefined = undefined;
  do {
    const qs = new URLSearchParams({ limit: '100', properties: 'property_id_ref' });
    if (after) qs.set('after', after);
    const resp = await hubspotFetch(`/crm/v3/objects/${tids.inspection}?${qs.toString()}`);
    for (const r of (resp.results || [])) {
      scanned++;
      const ref = (r.properties?.property_id_ref || '').trim();
      if (ref) pairs.push(assoc.reversed ? { fromId: ref, toId: r.id } : { fromId: r.id, toId: ref });
      else missingRef++;
    }
    after = resp.paging?.next?.after;
  } while (after);

  const { ok, failed } = await batchCreateAssociations(assoc.fromTypeId, assoc.toTypeId, assoc.typeId, pairs);
  return { scanned, withRef: pairs.length, associated: ok, failed, missingRef };
}

/**
 * Upload a file (image or PDF) to HubSpot Files API, return public URL.
 *
 * `overwrite=true` replaces an existing file with the same name+folder in
 * place (same URL kept). Use this for deterministic-named files like
 * generated PDFs so re-finalizing an inspection updates the existing file
 * rather than leaving an orphan and creating "-1.pdf".
 *
 * Defaults to `false` (matches HubSpot's API default) because inspection
 * photos use random UUID filenames where overwrite isn't needed.
 */
// HubSpot Files uploads can hang on a slow S3 write; time-box them so a stalled
// upload fails fast (the caller retries / the offline queue keeps the bytes)
// instead of pinning a serverless function until the platform kills it.
const FILE_UPLOAD_TIMEOUT_MS = 30000;
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error(`HubSpot file upload timed out after ${timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function uploadFile(
  buffer: Buffer,
  filename: string,
  contentType: string,
  folderPath: string = '/inspection_photos',
  overwrite: boolean = false
): Promise<string> {
  const url = `${API_BASE}/files/v3/files`;
  const form = new FormData();
  const blob = new Blob([buffer], { type: contentType });
  form.append('file', blob, filename);
  form.append('options', JSON.stringify({
    access: 'PUBLIC_INDEXABLE',
    overwrite,
    // IDEMPOTENT RETRIES: a photo's first upload can reach HubSpot while the
    // CLIENT sees a timeout/error (weak signal), then the retry re-sends the SAME
    // filename. With the default strategy HubSpot rejects that with 409 Conflict
    // — which (now that failed photos are kept + retried, never dropped) looped
    // forever and blocked sync/submit. RETURN_EXISTING makes a same-name upload
    // return the already-stored file's URL instead, so the retry simply succeeds.
    duplicateValidationStrategy: 'RETURN_EXISTING',
    duplicateValidationScope: 'EXACT_FOLDER',
  }));
  form.append('folderPath', folderPath);

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}` },
    body: form,
  }, FILE_UPLOAD_TIMEOUT_MS);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot file upload failed ${res.status}: ${text.slice(0, 500)}`);
  }
  const json = await res.json();
  return json.url || json.cdnUrl || '';
}

/**
 * Same as uploadFile, but also returns the HubSpot File ID so the file can be
 * associated to a record (e.g. attached to the inspection's Attachments card
 * via a Note engagement). Kept separate so existing callers of uploadFile are
 * unaffected.
 */
export async function uploadFileWithId(
  buffer: Buffer,
  filename: string,
  contentType: string,
  folderPath: string = '/inspection_pdfs',
  overwrite: boolean = true
): Promise<{ url: string; id: string }> {
  const url = `${API_BASE}/files/v3/files`;
  const form = new FormData();
  const blob = new Blob([buffer], { type: contentType });
  form.append('file', blob, filename);
  form.append('options', JSON.stringify({ access: 'PUBLIC_INDEXABLE', overwrite }));
  form.append('folderPath', folderPath);

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}` },
    body: form,
  }, FILE_UPLOAD_TIMEOUT_MS);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot file upload failed ${res.status}: ${text.slice(0, 500)}`);
  }
  const json = await res.json();
  return { url: json.url || json.cdnUrl || '', id: String(json.id || '') };
}

/**
 * Replace an existing HubSpot File's CONTENT in place, by id, preserving its URL
 * (the "Replace" action in the Files UI). Reads the file's current name / folder
 * / access, then re-uploads with overwrite — HubSpot keeps the SAME file id + URL
 * when the name + folder match. Best-effort: returns { ok:false, error } instead
 * of throwing. Used by the training-guide connector to push the latest manual.
 */
export async function replaceHubspotFileById(
  fileId: string,
  buffer: Buffer,
  contentType: string,
): Promise<{ ok: boolean; id?: string; url?: string; error?: string }> {
  try {
    // 1) Current metadata so we overwrite THIS file (same name + folder), not make a new one.
    const meta = await hubspotFetch(`/files/v3/files/${fileId}`);
    const name = String(meta?.name || '').trim();
    if (!name) return { ok: false, error: `file ${fileId} not found / has no name` };
    const extension = String(meta?.extension || '').trim();
    const fullName = extension ? `${name}.${extension}` : name;
    const folderId = meta?.parentFolderId != null ? String(meta.parentFolderId) : '';
    const access = String(meta?.access || 'PUBLIC_INDEXABLE');

    // 2) Re-upload with overwrite → replaces content, keeps id + URL.
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: contentType }), fullName);
    form.append('options', JSON.stringify({ access, overwrite: true }));
    if (folderId) form.append('folderId', folderId);

    const res = await fetchWithTimeout(`${API_BASE}/files/v3/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token()}` },
      body: form,
    }, 60000);
    const body = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 300)}` };
    const j = JSON.parse(body);
    return { ok: true, id: String(j.id || fileId), url: j.url || meta.url || '' };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 300) };
  }
}

/**
 * Attach one or more uploaded HubSpot Files to an Inspection record so they
 * appear under the record's "Attachments" card. HubSpot surfaces attachments
 * via Note engagements that carry `hs_attachment_ids`, associated to the
 * record. We create a single Note holding all the file IDs.
 *
 * Best-effort: never throws — a failure here should not fail finalize. Returns
 * the created note id (or null).
 */
export async function attachFilesToInspectionRecord(
  inspectionRecordId: string,
  fileIds: string[],
  noteBody: string = 'Inspection report PDFs'
): Promise<string | null> {
  const ids = fileIds.filter(Boolean);
  if (ids.length === 0) return null;
  const tids = typeIds();
  try {
    // 1) Create the Note carrying the file attachments (no association yet).
    //    hs_attachment_ids is a semicolon-delimited list of File IDs.
    const created = await hubspotFetch(`/crm/v3/objects/notes`, {
      method: 'POST',
      body: JSON.stringify({
        properties: {
          hs_timestamp: new Date().toISOString(),
          hs_note_body: noteBody,
          hs_attachment_ids: ids.join(';'),
        },
      }),
    });
    const noteId = String(created?.id || '');
    if (!noteId) {
      console.warn('[attachFiles] note creation returned no id');
      return null;
    }

    // 2) Resolve the note -> inspection association type id, then create the
    //    association using the SAME proven machinery the rest of the app uses
    //    (assocLabelsUrl + batchCreateAssociations). This is what makes the
    //    files show on the record's Attachments card.
    let associated = false;
    try {
      const labels = await hubspotFetch(assocLabelsUrl('notes', tids.inspection));
      const first = (labels.results || [])[0];
      const assocTypeId = first ? Number(first.typeId ?? first.associationTypeId) : NaN;
      if (Number.isFinite(assocTypeId)) {
        const r = await batchCreateAssociations('notes', tids.inspection, assocTypeId, [
          { fromId: noteId, toId: inspectionRecordId },
        ]);
        associated = r.ok > 0;
        if (!associated) console.warn('[attachFiles] association batch reported 0 ok', JSON.stringify(r));
      } else {
        console.warn('[attachFiles] no note->inspection association label found');
      }
    } catch (e) {
      console.warn('[attachFiles] association via labels failed:', e);
    }

    // 3) Fallback: the v4 "default" association endpoint, which creates the
    //    primary/unlabeled association without needing a resolved type id.
    if (!associated) {
      try {
        await hubspotFetch(
          `/crm/v4/objects/notes/${noteId}/associations/default/${tids.inspection}/${inspectionRecordId}`,
          { method: 'PUT' }
        );
        associated = true;
      } catch (e) {
        console.warn('[attachFiles] v4 default association fallback failed:', e);
      }
    }

    if (!associated) {
      console.warn(`[attachFiles] note ${noteId} created but could NOT be associated to inspection ${inspectionRecordId}; it will not show on the record.`);
    }
    return noteId;
  } catch (e) {
    console.warn('[attachFiles] failed (non-fatal):', e);
    return null;
  }
}

/**
 * After uploading a PDF to HubSpot Files, write its URL to the Inspection record's
 * pdf_attachment_url property so it's visible/clickable on the record page.
 *
 * If the pdf_attachment_url property doesn't exist on the Inspection schema yet,
 * we silently fall back to appending the URL to summary_comments. This lets the
 * app work even before you run the schema patch to add the property.
 */
export async function attachPdfUrlToInspection(inspectionRecordId: string, pdfUrl: string): Promise<void> {
  const { inspection: typeId } = typeIds();
  try {
    await hubspotFetch(`/crm/v3/objects/${typeId}/${inspectionRecordId}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties: { pdf_attachment_url: pdfUrl } }),
    });
  } catch (e: any) {
    const msg = String(e.message || e);
    // If the property doesn't exist, fall back to summary_comments
    if (msg.includes('PROPERTY_DOESNT_EXIST') || msg.includes('pdf_attachment_url')) {
      console.warn('pdf_attachment_url property missing; falling back to summary_comments');
      try {
        await hubspotFetch(`/crm/v3/objects/${typeId}/${inspectionRecordId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            properties: { summary_comments: `Inspection PDF: ${pdfUrl}` },
          }),
        });
      } catch (e2: any) {
        console.error('Both pdf_attachment_url and summary_comments fallback failed:', e2);
      }
    } else {
      throw e;
    }
  }
}

// ============================================================================
// Round B lifecycle helpers
// ============================================================================

/**
 * Fetch a single Inspection record by HubSpot record ID.
 */
/**
 * Read an arbitrary set of properties off one inspection record. Returns null
 * on 404. Used for lightweight checks (e.g. the finalize lock) without pulling
 * a full InspectionSummary.
 */
export async function readInspectionProps(
  recordId: string,
  props: string[]
): Promise<Record<string, any> | null> {
  const { inspection: typeId } = typeIds();
  try {
    const qs = props.map((p) => `properties=${encodeURIComponent(p)}`).join('&');
    const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/${recordId}?${qs}`);
    return resp.properties || {};
  } catch (e: any) {
    if (String(e).includes('404')) return null;
    throw e;
  }
}

export async function fetchInspectionById(recordId: string): Promise<InspectionSummary | null> {
  const { inspection: typeId } = typeIds();
  const properties = [
    'inspection_id_external', 'inspection_name', 'template_type', 'status',
    'property_address_snapshot', 'property_id_ref',
    'inspector_name', 'inspector_email',
    'bedrooms_at_inspection', 'bathrooms_at_inspection',
    'started_at', 'completed_at', 'scheduled_date',
    'total_questions_answered', 'pdf_attachment_url', 'hs_createdate',
    'region_snapshot', 'section_list_json',
    'source_rate_card_id', 'source_rate_card_name',
  ];
  try {
    const qs = properties.map((p) => `properties=${encodeURIComponent(p)}`).join('&');
    const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/${recordId}?${qs}`);
    const p = resp.properties || {};
    return {
      recordId: resp.id,
      inspectionIdExternal: p.inspection_id_external || '',
      inspectionName: p.inspection_name || `(Inspection ${resp.id})`,
      templateType: p.template_type || '',
      status: p.status || '',
      propertyAddressSnapshot: p.property_address_snapshot || '',
      propertyRecordId: p.property_id_ref || null,
      inspectorName: p.inspector_name || '',
      inspectorEmail: p.inspector_email || '',
      bedroomsAtInspection: p.bedrooms_at_inspection != null && p.bedrooms_at_inspection !== ''
        ? Number(p.bedrooms_at_inspection) : null,
      bathroomsAtInspection: p.bathrooms_at_inspection != null && p.bathrooms_at_inspection !== ''
        ? Number(p.bathrooms_at_inspection) : null,
      startedAt: p.started_at || null,
      completedAt: p.completed_at || null,
      scheduledDate: p.scheduled_date || null,
      createdAt: p.hs_createdate || null,
      updatedAt: p.last_edited_at || p.hs_lastmodifieddate || null,
      totalQuestionsAnswered: p.total_questions_answered != null && p.total_questions_answered !== ''
        ? Number(p.total_questions_answered) : null,
      pdfUrl: p.pdf_attachment_url || null,
      regionSnapshot: p.region_snapshot || null,
      sectionListJson: p.section_list_json || null,
      pdfMasterUrl: null,
      pdfChargebackUrl: null,
      pdfChargebackXlsxUrl: null,
      pdfVendorUrlsJson: null,
      pdfGeneratedAt: null,
      sourceRateCardId: p.source_rate_card_id || null,
      sourceRateCardName: p.source_rate_card_name || null,
      qcVerdict: null,
      qcOverallNote: null,
      qcPassCount: null,
      qcFailCount: null,
      submittedAt: null,
      submittedByEmail: null,
      approvedByName: null,
      approvedAt: null,
      resolutionTimingJson: null,
      totalClientCost: null,
    };
  } catch (e: any) {
    if (String(e).includes('404')) return null;
    throw e;
  }
}

// ── Compliance Issue tickets (1099 utilities / trash) ───────────────────────
// A HubSpot CRM Ticket (object 0-5) raised when a 1099 Leasing Agent Inspection
// reports a utility OFF or trash bins MISSING. Pipeline + stage are fixed (the
// "Compliance Issues" pipeline, NEW stage) but overridable via env.
const COMPLIANCE_TICKET_PIPELINE_ID = (process.env.HUBSPOT_COMPLIANCE_PIPELINE_ID || '81076231').trim();
const COMPLIANCE_TICKET_STAGE_NEW_ID = (process.env.HUBSPOT_COMPLIANCE_STAGE_NEW_ID || '153077089').trim();
// Per-inspection gate: a datetime stamped on the inspection once its compliance
// tickets have been processed, so re-entering / re-submitting the SAME inspection
// never creates the tickets again.
const COMPLIANCE_STAMP_PROP = 'compliance_tickets_created_at';
// Ticket object identifier for the association + object endpoints. The proven
// note-attach path passes the object NAME (e.g. 'notes'), which HubSpot accepts
// alongside the numeric id ('0-5') — use the name for the same compatibility.
const TICKET_TYPE_ID = 'tickets';

// Resolve a usable Ticket<->Property association and link the records. The
// property link can be EITHER the property_id_ref field OR an inspection→property
// association, and the ticket↔property association type may be exposed under the
// object NAME or the numeric id — so we try numeric id + name, both directions,
// caching the first combo that works. Mirrors the proven inspection→property path.
type TicketAssoc = { fromType: string; toType: string; typeId: number; category: string; reversed: boolean };
let _ticketPropAssoc: TicketAssoc | null = null;

/** Scan association labels; pick the labeled match (when asked) else unlabeled else first. */
async function pickAssocTypeAndCategory(fromType: string, toType: string, preferLabel: string | null): Promise<{ typeId: number; category: string } | null> {
  try {
    const resp = await hubspotFetch(assocLabelsUrl(fromType, toType));
    const results: any[] = resp.results || [];
    if (results.length === 0) return null;
    const byLabel = preferLabel ? results.find((a) => a.label === preferLabel) : undefined;
    const unlabeled = results.find((a) => !a.label);
    const chosen = byLabel || unlabeled || results[0];
    const typeId = Number(chosen.typeId ?? chosen.associationTypeId);
    if (!Number.isFinite(typeId)) return null;
    return { typeId, category: String(chosen.category || 'USER_DEFINED') };
  } catch {
    return null; // this from→to / identifier combo isn't valid; caller tries the next
  }
}

async function tryAssocCreate(a: TicketAssoc, ticketId: string, propertyId: string): Promise<boolean> {
  const pair = a.reversed ? { from: { id: propertyId }, to: { id: ticketId } } : { from: { id: ticketId }, to: { id: propertyId } };
  try {
    const resp = await hubspotFetch(assocBatchCreateUrl(a.fromType, a.toType), {
      method: 'POST',
      body: JSON.stringify({ inputs: [{ ...pair, types: [{ associationCategory: a.category, associationTypeId: a.typeId }] }] }),
    });
    if ((resp.results || []).length > 0) return true;
    if ((resp.numErrors || 0) > 0 || (resp.errors || []).length) console.warn('[compliance-ticket] assoc create returned errors:', JSON.stringify(resp).slice(0, 300));
    return false;
  } catch (e) {
    console.warn(`[compliance-ticket] assoc create threw (${a.fromType}->${a.toType} type ${a.typeId}/${a.category}):`, e);
    return false;
  }
}

/** Associate a ticket to a property, trying id+name and both directions. */
async function associateTicketToProperty(ticketId: string, propertyId: string): Promise<boolean> {
  const { property } = typeIds();
  if (!property) return false;

  // Fast path: reuse the first combo that worked this run.
  if (_ticketPropAssoc) {
    if (await tryAssocCreate(_ticketPropAssoc, ticketId, propertyId)) return true;
    _ticketPropAssoc = null; // stale → re-resolve
  }

  for (const ticket of ['0-5', 'tickets']) {
    // forward: ticket -> property (prefer a "Property" label)
    const fwd = await pickAssocTypeAndCategory(ticket, property, 'Property');
    if (fwd) {
      const a: TicketAssoc = { fromType: ticket, toType: property, ...fwd, reversed: false };
      if (await tryAssocCreate(a, ticketId, propertyId)) { _ticketPropAssoc = a; return true; }
    }
    // reverse: property -> ticket
    const rev = await pickAssocTypeAndCategory(property, ticket, null);
    if (rev) {
      const a: TicketAssoc = { fromType: property, toType: ticket, ...rev, reversed: true };
      if (await tryAssocCreate(a, ticketId, propertyId)) { _ticketPropAssoc = a; return true; }
    }
  }

  // Last resort: create a labeled Ticket->Property type, then link.
  try {
    const created = await hubspotFetch(assocLabelsUrl('0-5', property), {
      method: 'POST',
      body: JSON.stringify({ label: 'Property', name: 'ticket_to_property' }),
    });
    const newId = created?.results?.[0]?.typeId ?? created?.typeId ?? created?.results?.[0]?.associationTypeId;
    if (newId != null) {
      const a: TicketAssoc = { fromType: '0-5', toType: property, typeId: Number(newId), category: 'USER_DEFINED', reversed: false };
      if (await tryAssocCreate(a, ticketId, propertyId)) { _ticketPropAssoc = a; return true; }
    }
  } catch (e) {
    console.warn('[compliance-ticket] could not create Ticket->Property association type:', e);
  }
  console.warn(`[compliance-ticket] all ticket→property association strategies failed (ticket ${ticketId}, property ${propertyId})`);
  return false;
}

/**
 * Resolve the Property record id linked to an inspection: prefer the explicit
 * property_id_ref field, else fall back to the inspection→property association
 * (the property object), so tickets associate even when the field is blank.
 */
export async function resolveInspectionPropertyId(inspectionRecordId: string, knownRef?: string | null): Promise<string | null> {
  const ref = (knownRef || '').toString().trim();
  if (ref) return ref;
  const { inspection, property } = typeIds();
  try {
    const insp = await hubspotFetch(`/crm/v3/objects/${inspection}/${inspectionRecordId}?properties=property_id_ref`);
    const fromField = (insp?.properties?.property_id_ref || '').toString().trim();
    if (fromField) return fromField;
  } catch (e) { console.warn('[compliance-ticket] property_id_ref read failed:', e); }
  if (property) {
    try {
      const resp = await hubspotFetch(`/crm/v4/objects/${inspection}/${inspectionRecordId}/associations/${property}?limit=1`);
      const first = (resp?.results || [])[0];
      const id = first?.toObjectId ?? first?.id;
      if (id != null) return String(id);
    } catch (e) { console.warn('[compliance-ticket] inspection→property association read failed:', e); }
  }
  return null;
}

/**
 * Re-upload a stored photo URL to HubSpot Files and return its File ID, so it can
 * be attached to a ticket note (hs_attachment_ids needs File IDs, not URLs — our
 * answers only keep URLs). RETURN_EXISTING dedupes on re-submit (same name+folder
 * returns the existing file id, no duplicate, no 409). null on any failure.
 */
export async function uploadPhotoUrlForAttachment(photoUrl: string): Promise<string | null> {
  const u = (photoUrl || '').trim();
  if (!u) return null;
  try {
    const r = await fetchWithTimeout(u, {}, FILE_UPLOAD_TIMEOUT_MS);
    if (!r.ok) { console.warn(`[compliance-ticket] photo fetch ${r.status} for ${u}`); return null; }
    const buf = Buffer.from(await r.arrayBuffer());
    const contentType = r.headers.get('content-type') || 'image/jpeg';
    const base = (u.split('?')[0].split('/').pop() || `photo_${Date.now()}.jpg`).replace(/[^a-zA-Z0-9._-]/g, '_');
    const form = new FormData();
    form.append('file', new Blob([buf], { type: contentType }), base);
    form.append('options', JSON.stringify({
      access: 'PUBLIC_INDEXABLE',
      duplicateValidationStrategy: 'RETURN_EXISTING',
      duplicateValidationScope: 'EXACT_FOLDER',
    }));
    form.append('folderPath', '/compliance_ticket_photos');
    const up = await fetchWithTimeout(`${API_BASE}/files/v3/files`, {
      method: 'POST', headers: { Authorization: `Bearer ${token()}` }, body: form,
    }, FILE_UPLOAD_TIMEOUT_MS);
    if (!up.ok) { console.warn(`[compliance-ticket] photo re-upload failed ${up.status}`); return null; }
    const json = await up.json();
    return String(json.id || '') || null;
  } catch (e) {
    console.warn(`[compliance-ticket] photo re-upload error for ${u}:`, e);
    return null;
  }
}

/**
 * Create a Note on a ticket carrying the body text AND (optionally) file
 * attachments, so the note shows in the ticket timeline and the photos appear on
 * the ticket's Attachments card. notes↔tickets is a standard association (the v4
 * default works), with a labeled fallback. Returns the note id (best-effort).
 */
export async function createTicketNoteWithAttachments(ticketId: string, noteBody: string, fileIds: string[] = []): Promise<string | null> {
  const ids = (fileIds || []).filter(Boolean);
  try {
    const props: Record<string, string> = {
      hs_timestamp: new Date().toISOString(),
      hs_note_body: noteBody,
    };
    if (ids.length) props.hs_attachment_ids = ids.join(';');
    const created = await hubspotFetch('/crm/v3/objects/notes', { method: 'POST', body: JSON.stringify({ properties: props }) });
    const noteId = String(created?.id || '');
    if (!noteId) return null;

    let associated = false;
    try {
      await hubspotFetch(`/crm/v4/objects/notes/${noteId}/associations/default/${TICKET_TYPE_ID}/${ticketId}`, { method: 'PUT' });
      associated = true;
    } catch (e) {
      console.warn(`[compliance-ticket] note→ticket v4 default association failed (note ${noteId}):`, e);
    }
    if (!associated) {
      try {
        const labels = await hubspotFetch(assocLabelsUrl('notes', TICKET_TYPE_ID));
        const first = (labels.results || [])[0];
        const assocTypeId = first ? Number(first.typeId ?? first.associationTypeId) : NaN;
        if (Number.isFinite(assocTypeId)) {
          const rr = await batchCreateAssociations('notes', TICKET_TYPE_ID, assocTypeId, [{ fromId: noteId, toId: ticketId }]);
          associated = rr.ok > 0;
        }
      } catch (e) {
        console.warn(`[compliance-ticket] note→ticket labeled association fallback failed (note ${noteId}):`, e);
      }
    }
    if (!associated) console.warn(`[compliance-ticket] note ${noteId} created but NOT associated to ticket ${ticketId}`);
    return noteId;
  } catch (e) {
    console.warn(`[compliance-ticket] note creation for ticket ${ticketId} failed:`, e);
    return null;
  }
}

/**
 * Create a Compliance Issue ticket and associate it to the inspection's Property.
 * Property association is resolved against the portal's Ticket↔Property
 * association schema (labeled type + category + direction). Best-effort on the
 * association: the created ticket is always returned (never lost) even if the
 * link fails (logged). Throws only if the ticket itself can't be created.
 */
export async function createComplianceTicket(args: {
  subject: string;
  content?: string;
  propertyRecordId?: string | null;
}): Promise<{ ticketId: string; associatedProperty: boolean; deduped: boolean }> {
  // Idempotency: the subject encodes property + reason, so an identical OPEN
  // subject in this pipeline means this exact issue was already raised (a
  // double-submit or a reopen→resubmit). Skip creating a duplicate. Best-effort:
  // if the search fails we fall through and create (never block on dedupe).
  try {
    const found = await hubspotFetch('/crm/v3/objects/tickets/search', {
      method: 'POST',
      body: JSON.stringify({
        filterGroups: [{ filters: [
          { propertyName: 'subject', operator: 'EQ', value: args.subject },
          { propertyName: 'hs_pipeline', operator: 'EQ', value: COMPLIANCE_TICKET_PIPELINE_ID },
        ] }],
        properties: ['subject'],
        limit: 1,
      }),
    });
    const existingId = String(found?.results?.[0]?.id || '');
    if (existingId) {
      console.log(`[compliance-ticket] dedupe: "${args.subject}" already exists as #${existingId} — skipping create`);
      return { ticketId: existingId, associatedProperty: true, deduped: true };
    }
  } catch (e) {
    console.warn('[compliance-ticket] dedupe search failed (creating anyway):', e);
  }

  const properties: Record<string, string> = {
    subject: args.subject,
    hs_pipeline: COMPLIANCE_TICKET_PIPELINE_ID,
    hs_pipeline_stage: COMPLIANCE_TICKET_STAGE_NEW_ID,
  };
  if (args.content) properties.content = args.content;

  const created = await hubspotFetch('/crm/v3/objects/tickets', {
    method: 'POST',
    body: JSON.stringify({ properties }),
  });
  const ticketId = String(created?.id || '');
  if (!ticketId) throw new Error('ticket create returned no id');

  let associatedProperty = false;
  const propId = (args.propertyRecordId || '').toString().trim();
  if (propId) {
    associatedProperty = await associateTicketToProperty(ticketId, propId);
  }
  return { ticketId, associatedProperty, deduped: false };
}

/** Read the per-inspection compliance-tickets stamp (null if never processed). */
export async function getComplianceTicketsStamp(inspectionRecordId: string): Promise<string | null> {
  const { inspection } = typeIds();
  try {
    const resp = await hubspotFetch(`/crm/v3/objects/${inspection}/${inspectionRecordId}?properties=${COMPLIANCE_STAMP_PROP}`);
    const v = resp?.properties?.[COMPLIANCE_STAMP_PROP];
    return v ? String(v) : null;
  } catch (e) {
    // If the property doesn't exist yet, treat as "never processed" (the subject
    // dedupe still prevents duplicates). Never block on a read failure.
    return null;
  }
}

async function ensureComplianceStampProperty(): Promise<void> {
  const { inspection } = typeIds();
  try { await hubspotFetch(`/crm/v3/properties/${inspection}/${COMPLIANCE_STAMP_PROP}`); return; } catch { /* missing → create */ }
  try {
    await hubspotFetch(`/crm/v3/properties/${inspection}`, {
      method: 'POST',
      body: JSON.stringify({
        name: COMPLIANCE_STAMP_PROP, label: 'Compliance Tickets Created At', type: 'datetime', fieldType: 'date',
        groupName: 'inspection_results',
        description: 'Set once the 1099 utilities/trash compliance tickets have been created for this inspection — gates re-creation on re-submit.',
      }),
    });
  } catch (e: any) {
    const blob = `${String(e?.message || e)} ${String(e?.detail || '')}`;
    if (!(e?.status === 409 || /already exists|PROPERTY_ALREADY_EXISTS/i.test(blob))) {
      console.warn('[compliance-ticket] could not provision compliance_tickets_created_at:', blob.slice(0, 200));
    }
  }
}

/** Stamp the inspection as compliance-processed (epoch ms). Best-effort; auto-
 *  provisions the property on first use. */
export async function stampComplianceTicketsCreated(inspectionRecordId: string): Promise<void> {
  const { inspection } = typeIds();
  const doWrite = () => hubspotFetch(`/crm/v3/objects/${inspection}/${inspectionRecordId}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties: { [COMPLIANCE_STAMP_PROP]: Date.now() } }),
  });
  try {
    await doWrite();
  } catch (e) {
    if (isMissingPropertyError(e, COMPLIANCE_STAMP_PROP)) {
      await ensureComplianceStampProperty();
      await doWrite().catch((e2) => console.warn('[compliance-ticket] stamp write retry failed:', e2));
    } else {
      console.warn('[compliance-ticket] stamp write failed:', e);
    }
  }
}

// ── 1099 listing-price Slack alert gate ─────────────────────────────────────
// Stamped once a listing-price (Reduce/Increase) Slack alert has been posted for
// an inspection, so re-submitting the same inspection doesn't re-post.
const LISTING_PRICE_ALERT_PROP = 'listing_price_alert_at';

export async function getListingPriceAlertStamp(inspectionRecordId: string): Promise<string | null> {
  const { inspection } = typeIds();
  try {
    const resp = await hubspotFetch(`/crm/v3/objects/${inspection}/${inspectionRecordId}?properties=${LISTING_PRICE_ALERT_PROP}`);
    const v = resp?.properties?.[LISTING_PRICE_ALERT_PROP];
    return v ? String(v) : null;
  } catch { return null; }
}

async function ensureListingPriceAlertProperty(): Promise<void> {
  const { inspection } = typeIds();
  try { await hubspotFetch(`/crm/v3/properties/${inspection}/${LISTING_PRICE_ALERT_PROP}`); return; } catch { /* create */ }
  try {
    await hubspotFetch(`/crm/v3/properties/${inspection}`, {
      method: 'POST',
      body: JSON.stringify({
        name: LISTING_PRICE_ALERT_PROP, label: 'Listing Price Alert Posted At', type: 'datetime', fieldType: 'date',
        groupName: 'inspection_1099',
        description: 'Set once the 1099 listing-price (Reduce/Increase) Slack alert has been posted — gates re-posting on re-submit.',
      }),
    });
  } catch (e: any) {
    const blob = `${String(e?.message || e)} ${String(e?.detail || '')}`;
    if (!(e?.status === 409 || /already exists|PROPERTY_ALREADY_EXISTS/i.test(blob))) {
      console.warn('[listing-price-alert] could not provision listing_price_alert_at:', blob.slice(0, 200));
    }
  }
}

export async function stampListingPriceAlert(inspectionRecordId: string): Promise<void> {
  const { inspection } = typeIds();
  const doWrite = () => hubspotFetch(`/crm/v3/objects/${inspection}/${inspectionRecordId}`, {
    method: 'PATCH', body: JSON.stringify({ properties: { [LISTING_PRICE_ALERT_PROP]: Date.now() } }),
  });
  try {
    await doWrite();
  } catch (e) {
    if (isMissingPropertyError(e, LISTING_PRICE_ALERT_PROP)) {
      await ensureListingPriceAlertProperty();
      await doWrite().catch((e2) => console.warn('[listing-price-alert] stamp write retry failed:', e2));
    } else {
      console.warn('[listing-price-alert] stamp write failed:', e);
    }
  }
}

// ── 1099 grass-fail (PPW dispatch) Slack alert gate ─────────────────────────
// Mirrors the listing-price gate: a datetime stamp set once the alert posts so a
// re-submit doesn't re-post. Self-provisions the property on first write.
const PPW_FAIL_ALERT_PROP = 'ppw_fail_alert_at';

export async function getPpwFailAlertStamp(inspectionRecordId: string): Promise<string | null> {
  const { inspection } = typeIds();
  try {
    const resp = await hubspotFetch(`/crm/v3/objects/${inspection}/${inspectionRecordId}?properties=${PPW_FAIL_ALERT_PROP}`);
    const v = resp?.properties?.[PPW_FAIL_ALERT_PROP];
    return v ? String(v) : null;
  } catch { return null; }
}

async function ensurePpwFailAlertProperty(): Promise<void> {
  const { inspection } = typeIds();
  try { await hubspotFetch(`/crm/v3/properties/${inspection}/${PPW_FAIL_ALERT_PROP}`); return; } catch { /* create */ }
  try {
    await hubspotFetch(`/crm/v3/properties/${inspection}`, {
      method: 'POST',
      body: JSON.stringify({
        name: PPW_FAIL_ALERT_PROP, label: 'PPW Grass-Fail Alert Posted At', type: 'datetime', fieldType: 'date',
        groupName: 'inspection_1099',
        description: 'Set once the 1099 grass-fail (PPW dispatch) Slack alert has been posted — gates re-posting on re-submit.',
      }),
    });
  } catch (e: any) {
    const blob = `${String(e?.message || e)} ${String(e?.detail || '')}`;
    if (!(e?.status === 409 || /already exists|PROPERTY_ALREADY_EXISTS/i.test(blob))) {
      console.warn('[ppw-fail-alert] could not provision ppw_fail_alert_at:', blob.slice(0, 200));
    }
  }
}

export async function stampPpwFailAlert(inspectionRecordId: string): Promise<void> {
  const { inspection } = typeIds();
  const doWrite = () => hubspotFetch(`/crm/v3/objects/${inspection}/${inspectionRecordId}`, {
    method: 'PATCH', body: JSON.stringify({ properties: { [PPW_FAIL_ALERT_PROP]: Date.now() } }),
  });
  try {
    await doWrite();
  } catch (e) {
    if (isMissingPropertyError(e, PPW_FAIL_ALERT_PROP)) {
      await ensurePpwFailAlertProperty();
      await doWrite().catch((e2) => console.warn('[ppw-fail-alert] stamp write retry failed:', e2));
    } else {
      console.warn('[ppw-fail-alert] stamp write failed:', e);
    }
  }
}

/**
 * Also returns the property_id_ref so we can resolve the property record link.
 */
export async function fetchInspectionWithPropertyRef(recordId: string): Promise<{
  inspection: InspectionSummary;
  propertyIdRef: string;
  propertySquareFootage: number | null;
  propertyZip: string | null;
  /** Property's lifecycle status (e.g. "Turnkey", "Vacant", "Unmarketed") —
   *  the same `status` field shown on the property card at create time. Shown
   *  in the inspection header next to the square footage. */
  propertyStatus: string | null;
  /** Property's street-only address (e.g. "5503 Thomas Dr"). Used in
   *  chargeback xlsx Property Address column. */
  propertyAddressStreet: string | null;
  propertyCity: string | null;
  /** 2-letter state code (e.g. "TN"). Used in chargeback xlsx. */
  propertyStateCode: string | null;
  /** Property's `entity_id` (e.g. "RP3TN00010"). Used as the Entity ID
   *  column in chargeback xlsx. */
  propertyEntityId: string | null;
  /** Tenant full name. Used as Primary Tenant First and Last Name in xlsx. */
  propertyLastPrimaryTenant: string | null;
  /** Months the last tenant occupied the home — drives AI-review depreciation.
   *  null when the property has no value (or the field doesn't exist yet);
   *  callers default to 12. */
  propertyLastTenantMonths: number | null;
  /** Numeric Property ID in the ResiCap/Ameritrust Maintenance system
   *  (`hbmm_property_id` on the HubSpot property). Used as `propertyId` when
   *  creating a maintenance ticket. null when unset. */
  propertyHbmmId: string | null;
  /** Final Checklist: confirmed air-filter qty/types (write-back enabled) and
   *  the septic fee that gates the conditional septic question. */
  propertyAirFiltersTotal: number | null;
  propertyGasProvider: string | null;
  propertyAirFiltersType1: string | null;
  propertyAirFiltersType2: string | null;
  propertyAirFiltersType3: string | null;
  propertySepticFee: number | null;
  /** Property's pool_fee — gates the Final Checklist Pool Condition question
   *  (shown only when known and > 0). null when unset. */
  propertyPoolFee: number | null;
  /** Rently smart-lock telemetry from the property — drives the online/offline
   *  ring on the Unlock (lock) icon. `rently_device_type` (e.g. "Smart Home Hub",
   *  "Bluetooth Lock"), and for a hub the two component statuses (each "Online"
   *  when healthy). All null/empty when unset. */
  propertyRentlyDeviceType: string | null;
  propertyRentlyShHubStatus: string | null;
  propertyRentlyShLockStatus: string | null;
  /** Property's team_group_email — preferred finalize CC. */
  propertyTeamGroupEmail: string | null;
  /** True when the property's `pest_control_enrolled` = Yes. Scope header shows
   *  the pest-control mark and PESTL1007 lines default to the Pest Share vendor. */
  propertyPestControlEnrolled: boolean;
  /** True when the property's `last_tenant_pet_count` is known and >= 1. Scope
   *  header shows a pet (dog) mark. */
  propertyTenantHasPet: boolean;
  /** The property's raw `last_tenant_pet_count` (null when unset). The AI review
   *  uses >1 (multiple pets) to prefer carpet REPLACEMENT over cleaning. */
  propertyLastTenantPetCount: number | null;
  /** Frozen listing snapshot JSON (status/price/listed/MIR/move-in) captured at
   *  completion. Empty until the inspection is completed. */
  listingSnapshotJson: string | null;
} | null> {
  const { inspection: typeId, property: propertyTypeId } = typeIds();
  const properties = [
    'inspection_id_external', 'inspection_name', 'template_type', 'status',
    'property_address_snapshot', 'property_id_ref',
    'inspector_name', 'inspector_email',
    'bedrooms_at_inspection', 'bathrooms_at_inspection',
    'started_at', 'completed_at', 'scheduled_date',
    'total_questions_answered', 'pdf_attachment_url', 'hs_createdate',
    'region_snapshot', 'section_list_json',
    // Phase 4 PDF outputs (Rate Card finalize)
    'pdf_master_url', 'pdf_chargeback_url', 'pdf_chargeback_xlsx_url', 'pdf_vendor_urls_json', 'pdf_generated_at',
    'source_rate_card_id', 'source_rate_card_name', 'qc_verdict', 'qc_overall_note', 'qc_pass_count', 'qc_fail_count',
    // Submit/approve stamps + Internal Resolution timing map
    'submitted_at', 'submitted_by_email', 'approved_by_name', 'approved_at', 'resolution_timing_json',
    'total_client_cost', 'property_status_at_completion', 'listing_snapshot_json',
  ];
  try {
    const qs = properties.map((p) => `properties=${encodeURIComponent(p)}`).join('&');
    const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/${recordId}?${qs}`);
    const p = resp.properties || {};
    const propertyIdRef = p.property_id_ref || '';

    // Best-effort fetch property fields used downstream:
    //   square_footage  -> shown in header subtitle
    //   zip / zip_code  -> appended to address in header
    //   address         -> street-only address used in chargeback xlsx
    //   city            -> used in chargeback xlsx
    //   state_code      -> used in chargeback xlsx (2-letter, e.g. "TN")
    //   entity_id       -> used as Entity ID column in chargeback xlsx
    //   last_primary_tenant -> Primary Tenant First and Last Name in xlsx
    // Don't fail the whole request if the property is missing or some fields
    // are absent — these are informational. Each missing field just leaves
    // the corresponding column blank.
    let propertySquareFootage: number | null = null;
    let propertyZip: string | null = null;
    let propertyStatus: string | null = null;
    let propertyAddressStreet: string | null = null;
    let propertyCity: string | null = null;
    let propertyStateCode: string | null = null;
    let propertyEntityId: string | null = null;
    let propertyLastPrimaryTenant: string | null = null;
    let propertyLastTenantMonths: number | null = null;
    let propertyHbmmId: string | null = null;
    let propertyPestControlEnrolled = false;
    let propertyTenantHasPet = false;
    let propertyLastTenantPetCount: number | null = null;
    let propertyAirFiltersTotal: number | null = null;
    let propertyGasProvider: string | null = null;
    let propertyAirFiltersType1: string | null = null;
    let propertyAirFiltersType2: string | null = null;
    let propertyAirFiltersType3: string | null = null;
    let propertySepticFee: number | null = null;
    let propertyPoolFee: number | null = null;
    let propertyRentlyDeviceType: string | null = null;
    let propertyRentlyShHubStatus: string | null = null;
    let propertyRentlyShLockStatus: string | null = null;
    let propertyTeamGroupEmail: string | null = null;
    if (propertyIdRef) {
      // ISOLATED fetch for the (possibly not-yet-created) tenant-occupancy field.
      // Kept separate from the extras batch below so that, if HubSpot 400s on an
      // unknown property, it can't wipe out square_footage/zip/etc. On any
      // error or empty value this stays null and callers default to 12 months.
      try {
        const tQs = `properties=${encodeURIComponent('last_tenant_time_in_home_months')}`;
        const tResp = await hubspotFetch(`/crm/v3/objects/${propertyTypeId}/${propertyIdRef}?${tQs}`);
        const raw = tResp.properties?.last_tenant_time_in_home_months;
        if (raw != null && raw !== '') {
          const n = Number(raw);
          if (Number.isFinite(n) && n > 0) propertyLastTenantMonths = n;
        }
      } catch (e: any) {
        console.warn(`[fetchInspectionWithPropertyRef] last_tenant_time_in_home_months unavailable for ${propertyIdRef} (defaulting to 12):`, String(e).slice(0, 160));
      }
      try {
        const propProps = [
          'square_footage', 'zip', 'zip_code',
          'address', 'city', 'state_code',
          'entity_id', 'last_primary_tenant',
          // Numeric Property ID in the ResiCap/Ameritrust Maintenance system —
          // used as `propertyId` when creating a maintenance ticket at finalize.
          'hbmm_property_id',
          // Final Checklist: air-filter qty/types (write-back enabled) + septic gate.
          'air_filters___total_quantity',
          'air_filters___type__1', 'air_filters___type__2', 'air_filters___type__3',
          'septic_fee',
          'pool_fee',
          // Gas provider — gates the Final Checklist Gas question (hidden on
          // all-electric / unmapped homes).
          'gas_provider',
          // Preferred email CC for finalize (falls back to team{STATE}@resihome.com).
          'team_group_email',
          // Property lifecycle status (Turnkey / Vacant / Unmarketed / …) — shown
          // in the inspection header next to square footage.
          PROPERTY_STATUS_PROPERTY,
          // Pest-control enrollment (Yes/No) — shows the pest-control mark on the
          // Scope header and defaults PESTL1007 lines to the Pest Share vendor.
          'pest_control_enrolled',
          // Last tenant's pet count — shows a pet (dog) mark on the Scope header
          // when known and >= 1.
          'last_tenant_pet_count',
        ];
        const propQs = propProps.map((p) => `properties=${encodeURIComponent(p)}`).join('&');
        const propResp = await hubspotFetch(
          `/crm/v3/objects/${propertyTypeId}/${propertyIdRef}?${propQs}`
        );
        const pp = propResp.properties || {};
        if (pp.square_footage != null && pp.square_footage !== '') {
          const n = Number(pp.square_footage);
          if (Number.isFinite(n)) propertySquareFootage = n;
        }
        const rawZip = (pp.zip_code || pp.zip || '').toString().trim();
        if (rawZip) propertyZip = rawZip;
        propertyAddressStreet = (pp.address || '').toString().trim() || null;
        propertyCity = (pp.city || '').toString().trim() || null;
        propertyStateCode = (pp.state_code || '').toString().trim() || null;
        propertyEntityId = (pp.entity_id || '').toString().trim() || null;
        propertyLastPrimaryTenant = (pp.last_primary_tenant || '').toString().trim() || null;
        propertyHbmmId = (pp.hbmm_property_id || '').toString().trim() || null;
        propertyPestControlEnrolled = /^y/i.test((pp.pest_control_enrolled || '').toString().trim());
        {
          // Guard empty/unset FIRST — Number('') === 0 would report a definite
          // "0 pets" for an UNKNOWN value (the other numeric fields all guard this).
          const petRaw = (pp.last_tenant_pet_count ?? '').toString().trim();
          const petN = petRaw === '' ? NaN : Number(petRaw);
          propertyTenantHasPet = Number.isFinite(petN) && petN >= 1;
          propertyLastTenantPetCount = Number.isFinite(petN) ? petN : null;
        }
        if (pp.air_filters___total_quantity != null && pp.air_filters___total_quantity !== '') {
          const n = Number(pp.air_filters___total_quantity);
          if (Number.isFinite(n)) propertyAirFiltersTotal = n;
        }
        propertyGasProvider = (pp.gas_provider != null && String(pp.gas_provider).trim() !== '') ? String(pp.gas_provider).trim() : null;
        propertyAirFiltersType1 = (pp.air_filters___type__1 || '').toString().trim() || null;
        propertyAirFiltersType2 = (pp.air_filters___type__2 || '').toString().trim() || null;
        propertyAirFiltersType3 = (pp.air_filters___type__3 || '').toString().trim() || null;
        if (pp.septic_fee != null && pp.septic_fee !== '') {
          const n = Number(pp.septic_fee);
          if (Number.isFinite(n)) propertySepticFee = n;
        }
        if (pp.pool_fee != null && pp.pool_fee !== '') {
          const n = Number(pp.pool_fee);
          if (Number.isFinite(n)) propertyPoolFee = n;
        }
        propertyTeamGroupEmail = (pp.team_group_email || '').toString().trim() || null;
        propertyStatus = (pp[PROPERTY_STATUS_PROPERTY] || '').toString().trim() || null;
      } catch (e: any) {
        console.warn(`[fetchInspectionWithPropertyRef] could not fetch property ${propertyIdRef} extras:`, String(e).slice(0, 200));
      }

      // ISOLATED fetch for the Rently smart-lock fields (online/offline ring on
      // the Unlock icon). Kept separate from the extras batch above because a
      // HubSpot GET 400s on any unknown property name — if these aren't
      // provisioned yet they'd otherwise wipe out square_footage/zip/etc. On any
      // error each stays null and the ring simply doesn't render.
      try {
        const rentlyProps = ['rently_device_type', 'rently_sh_hub_status', 'rently_sh_lock_status'];
        const rQs = rentlyProps.map((p) => `properties=${encodeURIComponent(p)}`).join('&');
        const rResp = await hubspotFetch(`/crm/v3/objects/${propertyTypeId}/${propertyIdRef}?${rQs}`);
        const rp = rResp.properties || {};
        propertyRentlyDeviceType = (rp.rently_device_type || '').toString().trim() || null;
        propertyRentlyShHubStatus = (rp.rently_sh_hub_status || '').toString().trim() || null;
        propertyRentlyShLockStatus = (rp.rently_sh_lock_status || '').toString().trim() || null;
      } catch (e: any) {
        console.warn(`[fetchInspectionWithPropertyRef] Rently lock fields unavailable for ${propertyIdRef}:`, String(e).slice(0, 160));
      }
    }

    return {
      inspection: {
        recordId: resp.id,
        inspectionIdExternal: p.inspection_id_external || '',
        inspectionName: p.inspection_name || `(Inspection ${resp.id})`,
        templateType: p.template_type || '',
        status: p.status || '',
        propertyAddressSnapshot: p.property_address_snapshot || '',
        inspectorName: p.inspector_name || '',
        inspectorEmail: p.inspector_email || '',
        bedroomsAtInspection: p.bedrooms_at_inspection != null && p.bedrooms_at_inspection !== ''
          ? Number(p.bedrooms_at_inspection) : null,
        bathroomsAtInspection: p.bathrooms_at_inspection != null && p.bathrooms_at_inspection !== ''
          ? Number(p.bathrooms_at_inspection) : null,
        startedAt: p.started_at || null,
        completedAt: p.completed_at || null,
        scheduledDate: p.scheduled_date || null,
        createdAt: p.hs_createdate || null,
        updatedAt: p.last_edited_at || p.hs_lastmodifieddate || null,
        totalQuestionsAnswered: p.total_questions_answered != null && p.total_questions_answered !== ''
          ? Number(p.total_questions_answered) : null,
        pdfUrl: p.pdf_attachment_url || null,
        regionSnapshot: p.region_snapshot || null,
        sectionListJson: p.section_list_json || null,
        pdfMasterUrl: p.pdf_master_url || null,
        pdfChargebackUrl: p.pdf_chargeback_url || null,
        pdfChargebackXlsxUrl: p.pdf_chargeback_xlsx_url || null,
        pdfVendorUrlsJson: p.pdf_vendor_urls_json || null,
        pdfGeneratedAt: p.pdf_generated_at || null,
        sourceRateCardId: p.source_rate_card_id || null,
        sourceRateCardName: p.source_rate_card_name || null,
        qcVerdict: (p.qc_verdict === 'pass' || p.qc_verdict === 'fail') ? p.qc_verdict : null,
        qcOverallNote: p.qc_overall_note || null,
        qcPassCount: p.qc_pass_count != null && p.qc_pass_count !== '' ? Number(p.qc_pass_count) : null,
        qcFailCount: p.qc_fail_count != null && p.qc_fail_count !== '' ? Number(p.qc_fail_count) : null,
        submittedAt: p.submitted_at || null,
        submittedByEmail: p.submitted_by_email || null,
        approvedByName: p.approved_by_name || null,
        approvedAt: p.approved_at || null,
        resolutionTimingJson: p.resolution_timing_json || null,
        totalClientCost: p.total_client_cost != null && p.total_client_cost !== ''
          ? Number(p.total_client_cost) : null,
        propertyStatusAtCompletion: (p.property_status_at_completion || '').toString().trim() || null,
      },
      propertyIdRef,
      propertySquareFootage,
      propertyZip,
      propertyStatus,
      propertyAddressStreet,
      propertyCity,
      propertyStateCode,
      propertyEntityId,
      propertyLastPrimaryTenant,
      propertyLastTenantMonths,
      propertyHbmmId,
      propertyAirFiltersTotal,
      propertyGasProvider,
      propertyAirFiltersType1,
      propertyAirFiltersType2,
      propertyAirFiltersType3,
      propertySepticFee,
      propertyPoolFee,
      propertyRentlyDeviceType,
      propertyRentlyShHubStatus,
      propertyRentlyShLockStatus,
      propertyTeamGroupEmail,
      propertyPestControlEnrolled,
      propertyTenantHasPet,
      propertyLastTenantPetCount,
      listingSnapshotJson: (p.listing_snapshot_json || '').toString() || null,
    };
  } catch (e: any) {
    if (String(e).includes('404')) return null;
    throw e;
  }
}

// ── Listing lookup (inspection header) ───────────────────────────────────────
// The most-recent ACTIVE listing for a property, used to show the asking price +
// listing date in the inspection header. Preference order:
//   1) most recent PUBLISHED listing; else
//   2) most recent listing in DEPOSIT TAKEN.
// "Most recent" = newest listing_date (falling back to hs_createdate). Everything
// is best-effort: any miss returns null so the header simply omits the line.
//
// Config (env, all optional):
//   HUBSPOT_LISTING_TYPE_ID      listing object type id (default 2-11465597)
//   HUBSPOT_LISTING_STATUS_PROP  status property internal name (auto-discovered if unset)
let _listingTypeId: string | undefined;
function listingTypeId(): string {
  if (!_listingTypeId) _listingTypeId = normalizeTypeId(process.env.HUBSPOT_LISTING_TYPE_ID) || '2-11465597';
  return _listingTypeId;
}

// Discover the listing object's status-like property once (cached). We can't
// blindly request an unknown property (HubSpot 400s), so we read the schema and
// pick the env override, a common name, or any property that looks like a status.
let _listingStatusProp: string | null | undefined;
async function listingStatusProp(): Promise<string | null> {
  if (_listingStatusProp !== undefined) return _listingStatusProp;
  const override = (process.env.HUBSPOT_LISTING_STATUS_PROP || '').trim();
  try {
    const schema = await hubspotFetch(`/crm/v3/schemas/${listingTypeId()}`);
    const props: any[] = schema?.properties || [];
    const names = new Set(props.map((p) => p.name));
    if (override && names.has(override)) { _listingStatusProp = override; return override; }
    const prefer = ['published', 'listing_status', 'status', 'hs_pipeline_stage'];
    let pick = prefer.find((n) => names.has(n));
    if (!pick) pick = props.find((p) => /status|stage|state/i.test(`${p.name} ${p.label || ''}`))?.name;
    _listingStatusProp = pick || null;
  } catch {
    _listingStatusProp = override || null;
  }
  return _listingStatusProp;
}

// Discover the listing object's HUMAN status field — the enumeration whose
// values are Active / Deposit Taken (etc.) — distinct from the `published`
// boolean used to rank active-vs-not above. The published boolean is true/false
// (false on deposit-taken listings, which is why those showed no status); the
// real status lives in its own enum field. We find it by the option set
// (uniquely, it has a "deposit"/"active" option) and cache its value→label map
// so the header shows the proper label. Env override: HUBSPOT_LISTING_DISPLAY_STATUS_PROP.
let _listingDisplayStatus: { prop: string; labels: Record<string, string> } | null | undefined;
async function listingDisplayStatusInfo(): Promise<{ prop: string; labels: Record<string, string> } | null> {
  if (_listingDisplayStatus !== undefined) return _listingDisplayStatus;
  const override = (process.env.HUBSPOT_LISTING_DISPLAY_STATUS_PROP || '').trim();
  const buildLabels = (p: any): Record<string, string> => {
    const m: Record<string, string> = {};
    for (const o of (p?.options || [])) if (o && o.value != null) m[String(o.value).toLowerCase()] = String(o.label ?? o.value);
    return m;
  };
  try {
    const schema = await hubspotFetch(`/crm/v3/schemas/${listingTypeId()}`);
    const props: any[] = schema?.properties || [];
    const byName = new Map<string, any>(props.map((p) => [p.name, p]));
    let chosen: any = null;
    if (override && byName.has(override)) chosen = byName.get(override);
    // The listing's status enum is literally named `status` (fall back to
    // `listing_status`). Prefer these by NAME — an option-set heuristic was
    // matching a different enum that has an "active" option, making everything
    // read "Active".
    if (!chosen) chosen = byName.get('status') || byName.get('listing_status');
    // Last resort: the enumeration that has a "deposit" option (uniquely the
    // listing status). Require "deposit" specifically — "active" alone is too
    // common across other fields.
    if (!chosen) chosen = props.find((p) => Array.isArray(p.options) && p.options.some((o: any) => /deposit/i.test(`${o.label || ''} ${o.value || ''}`)));
    _listingDisplayStatus = chosen ? { prop: chosen.name, labels: buildLabels(chosen) } : null;
  } catch {
    _listingDisplayStatus = override ? { prop: override, labels: {} } : null;
  }
  return _listingDisplayStatus;
}

// Discover the listing object's "Move-in Ready Date" property once (cached).
// The listing's Move-in Ready date property. Confirmed field name; env override
// is supported only in case it differs in another portal.
const LISTING_MIR_PROP = (process.env.HUBSPOT_LISTING_MIR_PROP || '').trim() || 'move_in_ready_date';

// Short M/D/YY (2-digit year) — used for header dates (listing date + MIR).
function formatShortDateYY(raw: any): string | null {
  if (raw == null || raw === '') return null;
  const s = String(raw);
  const t = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
  if (!isFinite(t) || isNaN(t)) return null;
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(-2)}`;
}

// Human-readable listing status for the inspection header (shown in front of the
// listing price). The status property may hold a boolean-ish publish flag or a
// status string; normalize the common cases to "Active" / "Deposit Taken" and
// Title-case anything else. Returns null when there's nothing useful to show.
function formatListingStatus(raw: string | null | undefined): string | null {
  const s = (raw || '').trim();
  if (!s) return null;
  const low = s.toLowerCase();
  if (/deposit/.test(low)) return 'Deposit Taken';
  if (low === 'true' || low === 'yes' || low === '1' || low === 'active' || /publish/.test(low)) return 'Active';
  if (low === 'false' || low === 'no' || low === '0') return null; // unpublished / none → omit
  return s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---- Move-in date from the listing's associated leasing deal -----------------
// On a DEPOSIT-TAKEN listing we surface the tenant's actual move-in (= the deal's
// `lease_start_date`). The listing has many associated deals across pipelines, so
// narrow to: the LEASING pipeline, one of the post-deposit dealstages, and a deal
// that carries an hf_transaction_id (a real, transacted lease) — then take the
// most-recently-created match. All ids are env-overridable in case the portal
// renumbers them.
const LEASING_PIPELINE_ID = (process.env.HUBSPOT_LEASING_PIPELINE_ID || '').trim() || '24505349';
const LEASING_MOVEIN_DEALSTAGES = new Set(
  (((process.env.HUBSPOT_LEASING_MOVEIN_DEALSTAGES || '').trim())
    || '93711524,93679033,1345950475,57133602,57133603')
    .split(',').map((s) => s.trim()).filter(Boolean),
);
let _dealsTypeId: string | undefined;
function dealsTypeId(): string {
  if (!_dealsTypeId) _dealsTypeId = normalizeTypeId(process.env.HUBSPOT_DEALS_TYPE_ID) || '0-3';
  return _dealsTypeId;
}

async function fetchListingMoveInDate(listingRecordId: string): Promise<string | null> {
  if (!listingRecordId) return null;
  try {
    const lid = listingTypeId();
    const did = dealsTypeId();
    // 1) Deals associated to this listing.
    const ids: string[] = [];
    let after: string | undefined;
    let pages = 0;
    do {
      const qs = new URLSearchParams({ limit: '100' });
      if (after) qs.set('after', after);
      const resp = await hubspotFetch(`/crm/v4/objects/${lid}/${listingRecordId}/associations/${did}?${qs.toString()}`);
      for (const r of resp.results || []) { const id = r.toObjectId ?? r.id; if (id != null) ids.push(String(id)); }
      after = resp.paging?.next?.after;
    } while (after && ++pages < 20);
    if (!ids.length) return null;

    // 2) Batch-read deal props; keep only qualifying deals (leasing pipeline +
    //    post-deposit dealstage + a known hf_transaction_id).
    const wantProps = ['pipeline', 'dealstage', 'hf_transaction_id', 'lease_start_date', 'createdate', 'hs_createdate'];
    const candidates: Array<{ lease: any; created: number }> = [];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const resp = await hubspotFetch(`/crm/v3/objects/${did}/batch/read`, {
        method: 'POST',
        body: JSON.stringify({ properties: wantProps, inputs: chunk.map((id) => ({ id })) }),
      });
      for (const rec of resp.results || []) {
        const p = rec.properties || {};
        if (String(p.pipeline ?? '') !== LEASING_PIPELINE_ID) continue;
        if (!LEASING_MOVEIN_DEALSTAGES.has(String(p.dealstage ?? ''))) continue;
        if (!String(p.hf_transaction_id ?? '').trim()) continue;
        const createdMs = Date.parse(String(p.createdate || p.hs_createdate || ''));
        candidates.push({ lease: p.lease_start_date ?? null, created: isNaN(createdMs) ? 0 : createdMs });
      }
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.created - a.created); // most recently created first
    return formatShortDateYY(candidates[0].lease);
  } catch (e) {
    console.warn('[listing] move-in deal lookup failed:', e);
    return null;
  }
}

// ── Rules Engine "Deal Stage" criterion (leasing pipeline) ──────────────────
// The stages of the LEASING deal pipeline, for the enroll/stop stage dropdowns.
// Cached ~10 min. Value = HubSpot stage id (matches a deal's `dealstage`).
let _leasingStages: { at: number; list: { value: string; label: string }[] } | null = null;
export async function fetchLeasingDealStages(): Promise<{ value: string; label: string }[]> {
  if (_leasingStages && Date.now() - _leasingStages.at < 10 * 60_000) return _leasingStages.list;
  try {
    const resp = await hubspotFetch(`/crm/v3/pipelines/deals`);
    const pipes: any[] = resp?.results || [];
    const lp = pipes.find((p) => String(p.id) === LEASING_PIPELINE_ID) || null;
    const stages = lp ? (lp.stages || []) : [];
    const list = stages
      .slice()
      .sort((a: any, b: any) => (a.displayOrder || 0) - (b.displayOrder || 0))
      .map((s: any) => ({ value: String(s.id), label: String(s.label || s.id) }));
    _leasingStages = { at: Date.now(), list };
    return list;
  } catch (e) {
    console.warn('[deal-stages] leasing pipeline fetch failed:', e);
    return _leasingStages?.list || [];
  }
}

// Per-property CURRENT leasing-deal stage ids, via Property → Listing → Deal.
// Returns propertyId → Set<stageId>. Only called when a rule uses a Deal Stage
// criterion; capped to keep the nightly run bounded (each property costs a
// couple of association calls). Best-effort — a property that errors is skipped.
export async function fetchPropertyLeasingDealStages(propertyIds: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const did = dealsTypeId();
  const lid = listingTypeId();
  const { property } = typeIds();
  const CAP = 800;
  const ids = propertyIds.slice(0, CAP);
  for (const propId of ids) {
    try {
      const la = await hubspotFetch(`/crm/v4/objects/${property}/${propId}/associations/${lid}?limit=100`);
      const listingIds: string[] = (la.results || []).map((r: any) => String(r.toObjectId ?? r.id)).filter(Boolean);
      if (!listingIds.length) continue;
      const dealIds = new Set<string>();
      for (const listingId of listingIds) {
        const da = await hubspotFetch(`/crm/v4/objects/${lid}/${listingId}/associations/${did}?limit=100`);
        for (const r of da.results || []) { const id = r.toObjectId ?? r.id; if (id != null) dealIds.add(String(id)); }
      }
      if (!dealIds.size) continue;
      const stages = new Set<string>();
      const arr = [...dealIds];
      for (let i = 0; i < arr.length; i += 100) {
        const resp = await hubspotFetch(`/crm/v3/objects/${did}/batch/read`, {
          method: 'POST', body: JSON.stringify({ properties: ['pipeline', 'dealstage'], inputs: arr.slice(i, i + 100).map((id) => ({ id })) }),
        });
        for (const rec of resp.results || []) {
          const p = rec.properties || {};
          if (String(p.pipeline ?? '') === LEASING_PIPELINE_ID && p.dealstage) stages.add(String(p.dealstage));
        }
      }
      if (stages.size) out.set(propId, stages);
    } catch { /* skip this property */ }
  }
  if (propertyIds.length > CAP) console.warn(`[deal-stages] capped at ${CAP} of ${propertyIds.length} properties`);
  return out;
}

export interface ListingInfo {
  listingPrice: number | null;
  listingDate: string | null;
  listingStatus: string | null;
  moveInReadyDate: string | null;
  moveInDate: string | null;
  /** Property marks frozen alongside the listing at completion (Scope header):
   *  pest-control enrollment and whether the last tenant had a pet. */
  pestControlEnrolled?: boolean;
  tenantHasPet?: boolean;
}

/** Parse the frozen `listing_snapshot_json` (written at completion) back into a
 *  ListingInfo. Returns null when absent/malformed so callers fall back to the
 *  live lookup (e.g. inspections completed before the snapshot existed). */
export function parseListingSnapshot(json: string | null | undefined): ListingInfo | null {
  if (!json) return null;
  try {
    const o = JSON.parse(json) || {};
    const listingStatus = o.listingStatus ?? null;
    // Mirror the live path: deposit-taken / leased always show a move-in, falling
    // back to "TBD" when the frozen value is empty (e.g. captured before a lease
    // start existed) — so completed inspections never hide the field.
    let moveInDate: string | null = o.moveInDate ?? null;
    if (!moveInDate && /deposit|leas/i.test(listingStatus || '')) moveInDate = 'TBD';
    return {
      listingPrice: typeof o.listingPrice === 'number' ? o.listingPrice : null,
      listingDate: o.listingDate ?? null,
      listingStatus,
      moveInReadyDate: o.moveInReadyDate ?? null,
      moveInDate,
      pestControlEnrolled: o.pestControlEnrolled === true,
      tenantHasPet: o.tenantHasPet === true,
    };
  } catch { return null; }
}

/** Diagnostic: dump every deal associated to a listing with the exact fields the
 *  move-in lookup filters on, and whether each one qualifies. Used by
 *  /api/admin/debug-listing-deals to root-cause a missing Move-In date. */
export async function debugListingDeals(listingRecordId: string): Promise<any> {
  const lid = listingTypeId();
  const did = dealsTypeId();
  const ids: string[] = [];
  let after: string | undefined;
  let pages = 0;
  do {
    const qs = new URLSearchParams({ limit: '100' });
    if (after) qs.set('after', after);
    const resp = await hubspotFetch(`/crm/v4/objects/${lid}/${listingRecordId}/associations/${did}?${qs.toString()}`);
    for (const r of resp.results || []) { const id = r.toObjectId ?? r.id; if (id != null) ids.push(String(id)); }
    after = resp.paging?.next?.after;
  } while (after && ++pages < 20);
  const wantProps = ['pipeline', 'dealstage', 'hf_transaction_id', 'lease_start_date', 'createdate', 'hs_createdate'];
  const deals: any[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const resp = await hubspotFetch(`/crm/v3/objects/${did}/batch/read`, {
      method: 'POST', body: JSON.stringify({ properties: wantProps, inputs: chunk.map((id) => ({ id })) }),
    });
    for (const rec of resp.results || []) {
      const p = rec.properties || {};
      const pipelineOk = String(p.pipeline ?? '') === LEASING_PIPELINE_ID;
      const stageOk = LEASING_MOVEIN_DEALSTAGES.has(String(p.dealstage ?? ''));
      const hfOk = !!String(p.hf_transaction_id ?? '').trim();
      deals.push({
        id: rec.id, pipeline: p.pipeline ?? null, dealstage: p.dealstage ?? null,
        hf_transaction_id: p.hf_transaction_id ?? null, lease_start_date: p.lease_start_date ?? null,
        createdate: p.createdate || p.hs_createdate || null,
        qualifies: pipelineOk && stageOk && hfOk, checks: { pipelineOk, stageOk, hfOk },
      });
    }
  }
  return {
    listingTypeId: lid, dealsTypeId: did, leasingPipeline: LEASING_PIPELINE_ID,
    allowedDealstages: Array.from(LEASING_MOVEIN_DEALSTAGES),
    associatedDealCount: ids.length, computedMoveInDate: await fetchListingMoveInDate(listingRecordId), deals,
  };
}

/** Diagnostic: resolve an inspection → its property → associated listings, and
 *  run debugListingDeals on each. */
export async function debugInspectionListings(inspectionRecordId: string): Promise<any> {
  const tids = typeIds();
  const lid = listingTypeId();
  const insp = await hubspotFetch(`/crm/v3/objects/${tids.inspection}/${inspectionRecordId}?properties=${encodeURIComponent('property_id_ref')}`);
  const propertyIdRef = (insp.properties?.property_id_ref || '').toString().trim();
  if (!propertyIdRef) return { error: 'inspection has no property_id_ref' };
  const ids: string[] = [];
  let after: string | undefined;
  let pages = 0;
  do {
    const qs = new URLSearchParams({ limit: '100' });
    if (after) qs.set('after', after);
    const resp = await hubspotFetch(`/crm/v4/objects/${tids.property}/${propertyIdRef}/associations/${lid}?${qs.toString()}`);
    for (const r of resp.results || []) { const id = r.toObjectId ?? r.id; if (id != null) ids.push(String(id)); }
    after = resp.paging?.next?.after;
  } while (after && ++pages < 20);
  const listings: any[] = [];
  for (const id of ids) listings.push({ listingId: id, ...(await debugListingDeals(id)) });
  return { propertyIdRef, listingIds: ids, listings };
}

export async function fetchActiveListingForProperty(
  propertyRecordId: string
): Promise<ListingInfo | null> {
  if (!propertyRecordId) return null;
  const tids = typeIds();
  const lid = listingTypeId();
  try {
    // 1) Listing records associated to this property.
    const ids: string[] = [];
    let after: string | undefined;
    let pages = 0;
    do {
      const qs = new URLSearchParams({ limit: '100' });
      if (after) qs.set('after', after);
      const resp = await hubspotFetch(
        `/crm/v4/objects/${tids.property}/${propertyRecordId}/associations/${lid}?${qs.toString()}`
      );
      for (const r of resp.results || []) { const id = r.toObjectId ?? r.id; if (id != null) ids.push(String(id)); }
      after = resp.paging?.next?.after;
    } while (after && ++pages < 20);
    if (!ids.length) return null;

    // 2) Batch-read price/date/status for each listing.
    const statusProp = await listingStatusProp();
    const displayInfo = await listingDisplayStatusInfo();
    const mirProp = LISTING_MIR_PROP;
    const wantProps = ['listing_price', 'listing_date', 'hs_createdate'];
    if (statusProp) wantProps.push(statusProp);
    if (displayInfo?.prop && !wantProps.includes(displayInfo.prop)) wantProps.push(displayInfo.prop);
    if (mirProp && !wantProps.includes(mirProp)) wantProps.push(mirProp);
    type Row = { id: string; price: number | null; date: any; created: number; status: string; displayRaw: string; mir: any };
    const rows: Row[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const resp = await hubspotFetch(`/crm/v3/objects/${lid}/batch/read`, {
        method: 'POST',
        body: JSON.stringify({ properties: wantProps, inputs: chunk.map((id) => ({ id })) }),
      });
      for (const rec of resp.results || []) {
        const p = rec.properties || {};
        const priceRaw = p.listing_price;
        const price = priceRaw != null && priceRaw !== '' && isFinite(Number(priceRaw)) ? Number(priceRaw) : null;
        const createdMs = p.hs_createdate ? Date.parse(p.hs_createdate) : 0;
        rows.push({
          id: String(rec.id),
          price,
          date: p.listing_date ?? null,
          created: isNaN(createdMs) ? 0 : createdMs,
          status: statusProp ? String(p[statusProp] ?? '') : '',
          displayRaw: displayInfo?.prop ? String(p[displayInfo.prop] ?? '') : '',
          mir: mirProp ? (p[mirProp] ?? null) : null,
        });
      }
    }
    if (!rows.length) return null;

    const recency = (r: Row) => {
      if (r.date != null && r.date !== '') {
        const s = String(r.date);
        const t = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
        if (isFinite(t) && !isNaN(t)) return t;
      }
      return r.created;
    };
    // `published` is the status field. It may be a boolean ("true"/"false") or a
    // status string — treat any of those as published.
    const isPublished = (v: string) => {
      const s = v.trim().toLowerCase();
      return s === 'true' || s === 'yes' || s === '1' || /publish/i.test(s);
    };
    const byRecencyDesc = (a: Row, b: Row) => recency(b) - recency(a);
    const published = rows.filter((r) => isPublished(r.status)).sort(byRecencyDesc);
    const rest = rows.filter((r) => !isPublished(r.status)).sort(byRecencyDesc);
    // Most recent published listing; otherwise the most recent un-published one
    // (in practice the deposit-taken / pending listings).
    const pick = published[0] || rest[0];
    if (!pick) return null;
    // Display status: prefer the HUMAN status field (Active / Deposit Taken),
    // mapping the stored enum value to its label; fall back to the published
    // boolean (true → Active). This is why deposit-taken listings now show a
    // status instead of nothing.
    const displayLabel = displayInfo && pick.displayRaw
      ? (displayInfo.labels[pick.displayRaw.toLowerCase()] || pick.displayRaw)
      : '';
    const listingStatus = formatListingStatus(displayLabel) || formatListingStatus(pick.status);
    // Deposit-taken AND leased listings always show a move-in (the lease start on
    // the associated leasing deal). When the deal has no lease_start_date yet (or
    // no qualifying deal exists), still surface the field as "TBD" rather than
    // hiding it. Other statuses (Active, etc.) omit it entirely (null).
    const moveInDate = /deposit|leas/i.test(listingStatus || '')
      ? ((await fetchListingMoveInDate(pick.id)) || 'TBD')
      : null;
    return {
      listingPrice: pick.price,
      listingDate: formatShortDateYY(pick.date),
      listingStatus,
      moveInReadyDate: formatShortDateYY(pick.mir),
      moveInDate,
    };
  } catch (e) {
    console.warn('[listing] lookup failed:', e);
    return null;
  }
}

/**
 * Fetch all Answer records associated with an Inspection.
 * Uses the date-based associations API to find linked answers, then batch-reads
 * the answer properties.
 */
export interface SavedAnswer {
  recordId: string;
  answerIdExternal: string;
  questionIdExternal: string;
  questionHubspotRecordId: string | null;
  answerType: string;
  section: string;
  location: string;
  /** Human-readable summary "{section} {label} / {questionText}" — used to match
   *  a question by text without a separate question fetch (e.g. 1099 stamping). */
  answerSummary: string;
  answerValue: string;
  note: string;
  quantity: number | null;
  /** Dependent numeric input (1099 recommended rent), from `recommended_amount`. */
  recommendedAmount: number | null;
  assignedTo: string;
  photoUrls: string[];
  // AFTER photos for Internal Resolution rate-card lines (proof the in-house
  // work was done). Stored in the `after_photo_urls` property; empty otherwise.
  afterPhotoUrls: string[];
  // QC Turn Re-Inspect: per-line result ('pass'|'fail'|'') and photo phase
  // ('after' for QC after-photos). Empty/absent on non-QC answers.
  passFail?: 'pass' | 'fail' | '';
  photoPhase?: string;
  // QC Turn Re-Inspect: the inspector's explanation when a line is failed
  // (required on fail) — surfaced to the vendor/MC. Stored in qc_failure_note.
  qcFailureNote?: string;
  // Present only when answerType === 'rate_card_line'. Holds the raw inputs
  // + last stored totals so the form can hydrate without re-running the math
  // client-side.
  rateCardLine?: {
    lineItemCode: string;
    quantityDecimal: number;
    tenantBillBackPercent: number;
    isCustomPriced: boolean;
    customLaborRate: number | null;
    customAdjustedMaterialCost: number | null;
    customVendorCost: number | null;
    customLaborFullDescription: string | null;
    vendorCost: number | null;
    clientCost: number | null;
    tenantCost: number | null;
  };
}

// Whether the `after_photo_urls` property exists on the Answer object yet. Gates
// (a) requesting it in batch reads (HubSpot 400s on unknown props), (b) the
// after-photo finalize requirement, and (c) PDF rendering. Delegates to
// answerHasProperty so it uses the SELF-HEALING cache (positive cached forever; a
// negative re-checked after a short TTL). The old standalone cache poisoned a
// permanent `false` on ANY error — a single transient 429/timeout on an
// instance's first check silently disabled the after-photo READ + gate + PDF for
// that whole serverless instance, so a "Complete Now" Internal Resolution line
// could be finalized with NO after-photos (and they'd never appear on the report).
export async function answerHasAfterPhotoProperty(): Promise<boolean> {
  return answerHasProperty('after_photo_urls');
}

// Generic, cached "does the Answer object have this property?" guard — same
// fail-safe pattern as answerHasAfterPhotoProperty (batch read 400s on an
// unknown property). Used to conditionally request newer optional fields.
//
// A positive result is cached forever (a property won't disappear); a NEGATIVE
// result is re-checked after a short TTL, so a property provisioned via
// /admin/setup is picked up within minutes on every warm instance — without a
// cold start (otherwise a QC failure note could silently miss the PDF).
const _answerPropCache = new Map<string, { exists: boolean; at: number }>();
const ANSWER_PROP_NEG_TTL_MS = 5 * 60 * 1000;
export async function answerHasProperty(name: string): Promise<boolean> {
  const cached = _answerPropCache.get(name);
  if (cached && (cached.exists || Date.now() - cached.at < ANSWER_PROP_NEG_TTL_MS)) return cached.exists;
  try {
    const { answer } = typeIds();
    await hubspotFetch(`/crm/v3/properties/${answer}/${encodeURIComponent(name)}`);
    _answerPropCache.set(name, { exists: true, at: Date.now() });
    return true;
  } catch (e: any) {
    // Only cache a NEGATIVE for a GENUINE "property does not exist" (404). A
    // transient 429/timeout/5xx must NOT be cached — otherwise it disables the
    // property's read/gate/PDF for the whole negative TTL (the poison-cache class
    // that hid after_photo_urls). On a transient error, return the last-known
    // value and leave the cache untouched so the next call re-checks.
    if (isMissingPropertyError(e, name)) {
      _answerPropCache.set(name, { exists: false, at: Date.now() });
      return false;
    }
    return cached?.exists ?? false;
  }
}

// The Answer photo fields to scan for migration/reclaim/remaining tallies. MUST
// include after_photo_urls whenever it exists — a stale per-instance "property
// missing" cache would otherwise make the migrator silently skip photos the
// remaining-counter still reports ("N left but can't migrate"). So we probe the
// field DIRECTLY (cache-free) with a tiny search and only drop it on a genuine
// PROPERTY_DOESNT_EXIST; a transient error keeps it (skipping data is worse than
// a rare wasted request). All three scanners use this so they can't diverge.
async function answerPhotoScanFields(typeId: string): Promise<string[]> {
  const withAfter = ['photo_urls', 'after_photo_urls'];
  try {
    await hubspotFetch(`/crm/v3/objects/${typeId}/search`, { method: 'POST', body: JSON.stringify({ limit: 1, properties: withAfter }) });
    return withAfter;
  } catch (e: any) {
    if (isMissingPropertyError(e, 'after_photo_urls')) return ['photo_urls'];
    return withAfter;   // transient → assume it exists rather than skip real photos
  }
}

export async function fetchAnswersForInspection(inspectionRecordId: string): Promise<SavedAnswer[]> {
  const tids = typeIds();
  // Step 1: read the associations to find linked Answer record IDs. Use the
  // paginated v4 single-object endpoint (limit 500, follow paging.next.after)
  // so inspections with >100 answers — a Rate Card with many line items plus
  // section photos easily exceeds that — don't silently drop records, which
  // would corrupt finalize totals, PDFs, reopen, and QC copy.
  const answerIds: string[] = [];
  let after: string | undefined;
  // Runaway guard: 500/page × 200 pages = 100k answers — orders of magnitude
  // beyond any real inspection. This bounds a pathological record AND a
  // misbehaving paging cursor that never returns null (which would otherwise
  // loop forever). If we ever hit it, log loudly — we do NOT silently drop
  // answers (that would corrupt finalize/PDFs); the cap just stops the runaway.
  const MAX_ASSOC_PAGES = 200;
  let pageCount = 0;
  do {
    const qs = new URLSearchParams({ limit: '500' });
    if (after) qs.set('after', after);
    const assocResp = await hubspotFetch(
      `/crm/v4/objects/${tids.inspection}/${inspectionRecordId}/associations/${tids.answer}?${qs.toString()}`
    );
    for (const r of assocResp.results || []) {
      const id = r.toObjectId ?? r.id;
      if (id != null) answerIds.push(String(id));
    }
    after = assocResp.paging?.next?.after;
    if (++pageCount >= MAX_ASSOC_PAGES && after) {
      console.error(`[fetchAnswersForInspection] ${inspectionRecordId}: stopped after ${MAX_ASSOC_PAGES} association pages (${answerIds.length} ids) — unexpected volume or a runaway paging cursor. Investigate.`);
      break;
    }
  } while (after);
  if (answerIds.length === 0) return [];

  // Step 2: batch-read answer properties. HubSpot batch read limit is 100.
  // Includes rate card fields so the same fetch hydrates Scope answers AND
  // Rate Card line answers from one response.
  const properties = [
    'answer_id_external', 'question_id_external', 'answer_type',
    'section', 'location', 'answer_summary', 'answer_value',
    'note', 'quantity', 'assigned_to', 'photo_urls', 'photo_count',
    // Rate card line fields
    'rate_card_line_item_code', 'quantity_decimal', 'tenant_bill_back_percent',
    'is_custom_priced',
    'custom_labor_rate', 'custom_adjusted_material_cost', 'custom_vendor_cost',
    // Stored totals (so the client can show numbers without re-running math)
    'vendor_cost', 'client_cost', 'tenant_cost',
    // QC Turn Re-Inspect
    'pass_fail', 'photo_phase',
  ];
  // Only request after_photo_urls once the property exists — HubSpot batch read
  // 400s on an unknown property, which would break this (widely-used) fetch.
  if (await answerHasAfterPhotoProperty()) properties.push('after_photo_urls');
  if (await answerHasProperty('qc_failure_note')) properties.push('qc_failure_note');
  if (await answerHasProperty('recommended_amount')) properties.push('recommended_amount');
  const out: SavedAnswer[] = [];
  for (let i = 0; i < answerIds.length; i += 100) {
    const chunk = answerIds.slice(i, i + 100);
    const resp = await hubspotFetch(`/crm/v3/objects/${tids.answer}/batch/read`, {
      method: 'POST',
      body: JSON.stringify({
        properties,
        inputs: chunk.map((id) => ({ id })),
      }),
    });
    for (const r of resp.results || []) {
      const p = r.properties || {};
      const ans: SavedAnswer = {
        recordId: r.id,
        answerIdExternal: p.answer_id_external || '',
        questionIdExternal: p.question_id_external || '',
        questionHubspotRecordId: null, // will be looked up later if needed
        answerType: p.answer_type || 'qa',
        section: p.section || '',
        location: p.location || '',
        answerSummary: p.answer_summary || '',
        answerValue: p.answer_value || '',
        note: p.note || '',
        quantity: p.quantity != null && p.quantity !== '' ? Number(p.quantity) : null,
        recommendedAmount: p.recommended_amount != null && p.recommended_amount !== '' ? Number(p.recommended_amount) : null,
        assignedTo: p.assigned_to || '',
        // photo_urls is stored comma-separated by rate-card-lines.ts and
        // semicolon-separated by some Scope code paths. Handle both.
        photoUrls: (p.photo_urls || '').split(/[,;]/).map((s: string) => s.trim()).filter(Boolean),
        afterPhotoUrls: (p.after_photo_urls || '').split(/[,;]/).map((s: string) => s.trim()).filter(Boolean),
        passFail: (p.pass_fail === 'pass' || p.pass_fail === 'fail') ? p.pass_fail : '',
        photoPhase: p.photo_phase || '',
        qcFailureNote: p.qc_failure_note || '',
      };
      // Attach rate card fields when present (won't be on Scope/QA answers)
      if (ans.answerType === 'rate_card_line') {
        // answer_value holds the description shown to the user: either the
        // inspector's custom override or the catalog labor short description.
        // We can't tell which one it is until the client compares it to the
        // catalog (which we don't have access to here), so we surface both
        // pieces of info and let the client decide:
        //   - savedDescription: whatever's in answer_value
        //   - customLaborFullDescription: same value (null if catalog match)
        // The client resolves the comparison on hydration.
        ans.rateCardLine = {
          lineItemCode: p.rate_card_line_item_code || '',
          quantityDecimal: p.quantity_decimal != null && p.quantity_decimal !== ''
            ? Number(p.quantity_decimal) : (ans.quantity ?? 1),
          tenantBillBackPercent: p.tenant_bill_back_percent != null && p.tenant_bill_back_percent !== ''
            ? Number(p.tenant_bill_back_percent) : 100,
          isCustomPriced: p.is_custom_priced === 'true',
          customLaborRate: p.custom_labor_rate != null && p.custom_labor_rate !== ''
            ? Number(p.custom_labor_rate) : null,
          customAdjustedMaterialCost: p.custom_adjusted_material_cost != null && p.custom_adjusted_material_cost !== ''
            ? Number(p.custom_adjusted_material_cost) : null,
          customVendorCost: p.custom_vendor_cost != null && p.custom_vendor_cost !== ''
            ? Number(p.custom_vendor_cost) : null,
          customLaborFullDescription: ans.answerValue || null,
          vendorCost: p.vendor_cost != null && p.vendor_cost !== '' ? Number(p.vendor_cost) : null,
          clientCost: p.client_cost != null && p.client_cost !== '' ? Number(p.client_cost) : null,
          tenantCost: p.tenant_cost != null && p.tenant_cost !== '' ? Number(p.tenant_cost) : null,
        };
      }
      out.push(ans);
    }
  }
  return out;
}

/**
 * One-time cleanup: rewrite inspection_answer records whose photo_urls /
 * after_photo_urls hold duplicate URLs (from the old autosave + attach-outbox
 * dual write) down to their de-duplicated set, fixing photo_count to match.
 * Dry-run by default; `apply` performs the PATCHes. Scope to one inspection with
 * `inspectionId`, else scans all answers that have photos (paged). Idempotent —
 * only records that actually have dupes are touched.
 */
export interface DedupePhotosReport {
  mode: 'dry-run' | 'apply';
  scanned: number; withDupes: number; rewritten: number; errors: number;
  removedUrls: number;
  samples: { recordId: string; field: string; before: number; after: number }[];
  truncated: boolean;
}
export async function dedupeAnswerPhotos(opts: { apply: boolean; inspectionId?: string; limit?: number }): Promise<DedupePhotosReport> {
  const { apply, inspectionId } = opts;
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 100000;
  const { answer: answerType } = typeIds();
  const hasAfter = await answerHasProperty('after_photo_urls').catch(() => false);
  const fields = ['photo_urls', ...(hasAfter ? ['after_photo_urls'] : [])];
  const report: DedupePhotosReport = { mode: apply ? 'apply' : 'dry-run', scanned: 0, withDupes: 0, rewritten: 0, errors: 0, removedUrls: 0, samples: [], truncated: false };

  const splitUrls = (raw: any): string[] => String(raw || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean);

  const processRecord = async (recordId: string, p: Record<string, any>) => {
    report.scanned++;
    const patch: Record<string, any> = {};
    for (const field of fields) {
      const urls = splitUrls(p[field]);
      if (!urls.length) continue;
      const deduped = Array.from(new Set(urls));
      if (deduped.length < urls.length) {
        patch[field] = deduped.join(PHOTO_URL_DELIMITER);
        if (field === 'photo_urls') patch.photo_count = deduped.length;
        report.removedUrls += urls.length - deduped.length;
        if (report.samples.length < 25) report.samples.push({ recordId, field, before: urls.length, after: deduped.length });
      }
    }
    if (!Object.keys(patch).length) return;
    report.withDupes++;
    if (apply) {
      try {
        await hubspotFetch(`/crm/v3/objects/${answerType}/${recordId}`, { method: 'PATCH', body: JSON.stringify({ properties: patch }) });
        report.rewritten++;
        await new Promise((r) => setTimeout(r, 60)); // gentle on the API
      } catch (e) { report.errors++; console.warn('[dedupeAnswerPhotos] patch failed', recordId, e); }
    }
  };

  if (inspectionId) {
    const answers = await fetchAnswersForInspection(inspectionId);
    for (const a of answers) {
      if (report.scanned >= limit) { report.truncated = true; break; }
      await processRecord(a.recordId, {
        photo_urls: (a.photoUrls || []).join(PHOTO_URL_DELIMITER),
        after_photo_urls: (a.afterPhotoUrls || []).join(PHOTO_URL_DELIMITER),
      });
    }
    return report;
  }

  let after: string | undefined;
  do {
    const resp = await hubspotFetch(`/crm/v3/objects/${answerType}/search`, {
      method: 'POST',
      body: JSON.stringify({ limit: 100, after, properties: fields, filterGroups: [{ filters: [{ propertyName: 'photo_urls', operator: 'HAS_PROPERTY' }] }] }),
    });
    for (const r of resp.results || []) {
      if (report.scanned >= limit) { report.truncated = true; break; }
      await processRecord(String(r.id), r.properties || {});
    }
    after = report.truncated ? undefined : resp.paging?.next?.after;
  } while (after);
  return report;
}

/**
 * Read-only inventory for the HubSpot Files → Vercel Blob photo backfill: counts
 * how many photos on inspection_answer records still live in HubSpot Files (would
 * migrate), how many are already on Blob, and how many are other/external. Writes
 * nothing and downloads nothing (unlike the standalone script's dry run, which
 * also measures bytes). Scope to one inspection with `inspectionId`, else scans
 * all answers with photos (paged).
 */
const isHubspotFileUrl = (u: string) => /hubspotusercontent|hubfs|hs-fs\./i.test(String(u || ''));
const isBlobFileUrl = (u: string) => /\.blob\.vercel-storage\.com/i.test(String(u || ''));
export interface BackfillDryRunReport {
  mode: 'dry-run'; scanned: number; answersWithHubspotPhotos: number;
  hubspotPhotos: number; alreadyOnBlob: number; otherExternal: number;
  samples: { recordId: string; hubspot: number; blob: number }[]; truncated: boolean;
}
export async function backfillPhotosDryRun(opts: { inspectionId?: string; limit?: number }): Promise<BackfillDryRunReport> {
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 100000;
  const { answer: answerType } = typeIds();
  const hasAfter = await answerHasProperty('after_photo_urls').catch(() => false);
  const fields = ['photo_urls', ...(hasAfter ? ['after_photo_urls'] : [])];
  const report: BackfillDryRunReport = { mode: 'dry-run', scanned: 0, answersWithHubspotPhotos: 0, hubspotPhotos: 0, alreadyOnBlob: 0, otherExternal: 0, samples: [], truncated: false };
  const split = (raw: any): string[] => String(raw || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  const proc = (recordId: string, p: Record<string, any>) => {
    report.scanned++;
    let hs = 0; let blob = 0;
    for (const f of fields) for (const u of split(p[f])) {
      if (isHubspotFileUrl(u)) hs++;
      else if (isBlobFileUrl(u)) blob++;
      else report.otherExternal++;
    }
    report.hubspotPhotos += hs; report.alreadyOnBlob += blob;
    if (hs > 0) { report.answersWithHubspotPhotos++; if (report.samples.length < 25) report.samples.push({ recordId, hubspot: hs, blob }); }
  };
  if (opts.inspectionId) {
    const answers = await fetchAnswersForInspection(opts.inspectionId);
    for (const a of answers) {
      if (report.scanned >= limit) { report.truncated = true; break; }
      proc(a.recordId, { photo_urls: (a.photoUrls || []).join(PHOTO_URL_DELIMITER), after_photo_urls: (a.afterPhotoUrls || []).join(PHOTO_URL_DELIMITER) });
    }
    return report;
  }
  let after: string | undefined;
  do {
    const resp = await hubspotFetch(`/crm/v3/objects/${answerType}/search`, {
      method: 'POST',
      body: JSON.stringify({ limit: 100, after, properties: fields, filterGroups: [{ filters: [{ propertyName: 'photo_urls', operator: 'HAS_PROPERTY' }] }] }),
    });
    for (const r of resp.results || []) {
      if (report.scanned >= limit) { report.truncated = true; break; }
      proc(String(r.id), r.properties || {});
    }
    after = report.truncated ? undefined : resp.paging?.next?.after;
  } while (after);
  return report;
}

/**
 * Copy one inspection's HubSpot-hosted answer photos into Vercel Blob and rewrite
 * the answer references (photo_urls / after_photo_urls) to the new public Blob
 * URLs. Verified per photo (re-download + byte match). Does NOT delete from
 * HubSpot — reclaim is a separate, deliberate step (the standalone script's
 * --delete). Idempotent + resumable: already-on-Blob URLs are skipped, so a
 * re-run after a timeout continues cleanly. `apply:false` counts only.
 */
export interface BackfillCopyReport {
  mode: 'apply' | 'dry-run'; inspectionId: string;
  hubspotPhotos: number; copied: number; verified: number; skippedAlreadyBlob: number;
  recordsUpdated: number; errors: number; errorSamples: string[]; truncated: boolean;
}
export async function backfillPhotosCopyForInspection(opts: { inspectionId: string; apply: boolean; limit?: number }): Promise<BackfillCopyReport> {
  const { inspectionId, apply } = opts;
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 100000;
  const { answer: answerType } = typeIds();
  const report: BackfillCopyReport = { mode: apply ? 'apply' : 'dry-run', inspectionId, hubspotPhotos: 0, copied: 0, verified: 0, skippedAlreadyBlob: 0, recordsUpdated: 0, errors: 0, errorSamples: [], truncated: false };
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN || '';
  if (apply && !blobToken) throw new Error('BLOB_READ_WRITE_TOKEN is not set — cannot copy to Blob.');
  const hasAfter = await answerHasProperty('after_photo_urls').catch(() => false);
  const answers = await fetchAnswersForInspection(inspectionId);

  const urlMap = new Map<string, string>();   // old HubSpot URL → new Blob URL (this run)
  const migrate = async (url: string): Promise<string> => {
    if (urlMap.has(url)) return urlMap.get(url)!;
    const res = await fetch(url.split('#')[0]);
    if (!res.ok) throw new Error(`download ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const name = decodeURIComponent(url.split('#')[0].split('?')[0].split('/').pop() || `photo_${Date.now()}.jpg`);
    const m = /idbph_(\d+)__/.exec(name);
    const key = `inspections/${m ? m[1] : inspectionId}/${name}`;
    const putRes = await put(key, buf, { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: res.headers.get('content-type') || 'image/jpeg', token: blobToken });
    report.copied++;
    const vr = await fetch(putRes.url);   // verify: re-download + byte match
    if (!vr.ok) throw new Error(`verify ${vr.status}`);
    const vbuf = Buffer.from(await vr.arrayBuffer());
    if (vbuf.length !== buf.length) throw new Error(`size mismatch ${vbuf.length}!=${buf.length}`);
    report.verified++;
    urlMap.set(url, putRes.url);
    return putRes.url;
  };

  for (const a of answers) {
    if (report.hubspotPhotos >= limit) { report.truncated = true; break; }
    const fields: { key: string; urls: string[] }[] = [
      { key: 'photo_urls', urls: a.photoUrls || [] },
      ...(hasAfter ? [{ key: 'after_photo_urls', urls: a.afterPhotoUrls || [] }] : []),
    ];
    const patch: Record<string, any> = {};
    for (const f of fields) {
      let touched = false;
      const nextUrls: string[] = [];
      for (const u of f.urls) {
        if (isBlobFileUrl(u)) { report.skippedAlreadyBlob++; nextUrls.push(u); continue; }
        if (!isHubspotFileUrl(u)) { nextUrls.push(u); continue; }
        report.hubspotPhotos++;
        if (!apply) { nextUrls.push(u); touched = true; continue; }
        try { nextUrls.push(await migrate(u)); touched = true; }
        catch (e: any) { report.errors++; if (report.errorSamples.length < 10) report.errorSamples.push(`${u.slice(0, 60)}: ${String(e?.message || e).slice(0, 80)}`); nextUrls.push(u); }
      }
      if (apply && touched) {
        const finalUrls = Array.from(new Set(nextUrls));   // also dedupes in the same pass
        patch[f.key] = finalUrls.join(PHOTO_URL_DELIMITER);
        if (f.key === 'photo_urls') patch.photo_count = finalUrls.length;
      }
    }
    if (apply && Object.keys(patch).length) {
      try { await hubspotFetch(`/crm/v3/objects/${answerType}/${a.recordId}`, { method: 'PATCH', body: JSON.stringify({ properties: patch }) }); report.recordsUpdated++; }
      catch (e: any) { report.errors++; if (report.errorSamples.length < 10) report.errorSamples.push(`patch ${a.recordId}: ${String(e?.message || e).slice(0, 80)}`); }
    }
  }
  return report;
}

/**
 * ONE time-budgeted batch of the HubSpot Files → Vercel Blob photo migration,
 * for a browser-driven admin loop with visible progress. Covers BOTH photo
 * homes: inspection_answer records (photo_urls / after_photo_urls) and Service
 * Work Orders (before/after/pet_before/pet_after_photo_urls).
 *
 * Each call processes one search page under a time + photo budget, copies each
 * HubSpot-hosted photo to Blob (verified by re-download + byte match), rewrites
 * the reference in place (deduping), and PATCHes the record. Does NOT delete
 * from HubSpot. Idempotent + resumable: already-on-Blob URLs are skipped, and if
 * the budget trips mid-page the SAME `after` is returned so the next call
 * re-scans that page (done records skip fast) and continues. `done:true` when
 * that object's pages are exhausted. Errors are counted + sampled, never fatal.
 */
export type MigratePhotoObject = 'answer' | 'service';
export interface MigratePhotoBatch {
  object: MigratePhotoObject; after: string | null; done: boolean;
  scanned: number; hubspotSeen: number; copied: number; verified: number;
  recordsUpdated: number; errors: number; errorSamples: string[]; configured: boolean;
}
export async function migratePhotosBatch(opts: { object: MigratePhotoObject; after?: string; apply: boolean; budgetMs?: number; photoCap?: number }): Promise<MigratePhotoBatch> {
  const start = Date.now();
  const budgetMs = opts.budgetMs ?? 45000;
  const photoCap = opts.photoCap ?? 60;
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN || '';
  if (opts.apply && !blobToken) throw new Error('BLOB_READ_WRITE_TOKEN is not set — cannot copy to Blob.');
  const rep: MigratePhotoBatch = { object: opts.object, after: opts.after ?? null, done: false, scanned: 0, hubspotSeen: 0, copied: 0, verified: 0, recordsUpdated: 0, errors: 0, errorSamples: [], configured: true };
  const split = (raw: any): string[] => String(raw || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  const err = (m: string) => { rep.errors++; if (rep.errorSamples.length < 10) rep.errorSamples.push(m.slice(0, 100)); };

  let typeId: string; let fields: string[]; let filterGroups: any[] | undefined; let keyBase: string;
  if (opts.object === 'answer') {
    typeId = typeIds().answer;
    fields = await answerPhotoScanFields(typeId);
    filterGroups = fields.map((f) => ({ filters: [{ propertyName: f, operator: 'HAS_PROPERTY' }] }));
    keyBase = 'inspections';
  } else {
    typeId = (process.env.HUBSPOT_SERVICE_TYPE_ID || '').trim();
    if (!typeId) return { ...rep, done: true, configured: false };
    fields = ['before_photo_urls', 'after_photo_urls', 'pet_before_photo_urls', 'pet_after_photo_urls'];
    filterGroups = undefined; // service set is small — scan all, check every photo field
    keyBase = 'services';
  }

  const urlMap = new Map<string, string>();
  // Hard timeouts are CRITICAL: a bare fetch() with no timeout will hang forever
  // if a HubSpot download stalls (common once HubSpot throttles at volume). A hung
  // download freezes the whole batch — the 40s soft budget is only checked BETWEEN
  // photos, never during an in-flight fetch — until Vercel hard-kills the function
  // at 300s with no progress saved. The watchdog then resumes, hits the SAME photo,
  // and wedges the job on it forever (the "stalled at N copied" symptom).
  const DL_TIMEOUT_MS = 25000, VERIFY_TIMEOUT_MS = 20000;
  const migrate = async (url: string, prefixId: string): Promise<string> => {
    if (urlMap.has(url)) return urlMap.get(url)!;
    const src = url.split('#')[0];
    // Download with a timeout + one retry, so a transient stall/throttle doesn't
    // permanently fail (or wedge) the photo.
    let res: Response;
    try {
      res = await fetchWithTimeout(src, {}, DL_TIMEOUT_MS);
      if (!res.ok) throw new Error(`download ${res.status}`);
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
      res = await fetchWithTimeout(src, {}, DL_TIMEOUT_MS);
      if (!res.ok) throw new Error(`download ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const name = decodeURIComponent(src.split('?')[0].split('/').pop() || `photo_${Date.now()}.jpg`);
    const m = /idbph_(\d+)__/.exec(name);
    const key = `${keyBase}/${(opts.object === 'answer' && m) ? m[1] : prefixId}/${name}`;
    const putRes = await put(key, buf, { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: res.headers.get('content-type') || 'image/jpeg', token: blobToken });
    rep.copied++;
    const vr = await fetchWithTimeout(putRes.url, {}, VERIFY_TIMEOUT_MS);
    if (!vr.ok) throw new Error(`verify ${vr.status}`);
    if (Buffer.from(await vr.arrayBuffer()).length !== buf.length) throw new Error('size mismatch');
    rep.verified++;
    urlMap.set(url, putRes.url);
    return putRes.url;
  };

  const body: any = { limit: 100, after: opts.after || undefined, properties: fields };
  if (filterGroups) body.filterGroups = filterGroups;
  const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search`, { method: 'POST', body: JSON.stringify(body) });
  const results = resp.results || [];
  const nextAfter: string | null = resp.paging?.next?.after || null;
  const overBudget = () => Date.now() - start > budgetMs || rep.copied >= photoCap;

  let budgetHit = false;
  for (const r of results) {
    if (overBudget()) { budgetHit = true; break; }
    rep.scanned++;
    const p = r.properties || {};
    const patch: Record<string, any> = {};
    let anyChange = false;
    for (const field of fields) {
      const urls = split(p[field]);
      if (!urls.length) continue;
      const next: string[] = [];
      let touched = false;
      for (const u of urls) {
        if (isBlobFileUrl(u) || !isHubspotFileUrl(u)) { next.push(u); continue; }
        rep.hubspotSeen++;
        if (!opts.apply) { next.push(u); touched = true; continue; }
        if (overBudget()) { next.push(u); budgetHit = true; continue; }
        try { next.push(await migrate(u, String(r.id))); touched = true; }
        catch (e: any) { err(`${u.slice(0, 50)}: ${String(e?.message || e)}`); next.push(u); }
      }
      if (opts.apply && touched) {
        const finalUrls = Array.from(new Set(next));
        patch[field] = finalUrls.join(PHOTO_URL_DELIMITER);
        if (field === 'photo_urls') patch.photo_count = finalUrls.length;
        anyChange = true;
      }
    }
    if (opts.apply && anyChange && Object.keys(patch).length) {
      try { await hubspotFetch(`/crm/v3/objects/${typeId}/${r.id}`, { method: 'PATCH', body: JSON.stringify({ properties: patch }) }); rep.recordsUpdated++; }
      catch (e: any) { err(`patch ${r.id}: ${String(e?.message || e)}`); }
    }
    if (budgetHit) break;
  }

  if (budgetHit) { rep.after = opts.after ?? null; rep.done = false; }   // re-scan this page next call
  else { rep.after = nextAfter; rep.done = !nextAfter; }
  return rep;
}

// ─── Reclaim HubSpot space: delete photos that are now safely on Blob ──────────
// The migration rewrote each record's reference to the Blob URL, leaving the
// HubSpot original orphaned. This deletes those originals — but SAFE-BY-DESIGN:
// a file is removed ONLY if its exact URL is absent from the COMPLETE set of URLs
// still referenced by any record (so an un-migrated photo is never touched), and
// ONLY within the app's /inspection_photos folder (never other portal files).

const normFileUrl = (u: string) => String(u || '').split('#')[0].split('?')[0].trim();

/** DELETE one HubSpot file by id. */
export async function deleteHubspotFileById(id: string): Promise<void> {
  await hubspotFetch(`/files/v3/files/${id}`, { method: 'DELETE' });
}

// Read-only tally of what's LEFT to migrate: records that still reference at
// least one HubSpot-hosted photo (i.e. not yet moved to Blob), plus the photo
// count. Fully paginated. Answers "how many more inspections to migrate?".
export interface MigrationRemaining {
  inspections: { records: number; photos: number };
  services: { records: number; photos: number };
  configured: boolean;
}
export async function migrationRemainingCounts(): Promise<MigrationRemaining> {
  const split = (raw: any): string[] => String(raw || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  const tally = async (typeId: string, fields: string[], filter: boolean) => {
    let records = 0, photos = 0; let after: string | undefined;
    do {
      const body: any = { limit: 100, after, properties: fields };
      if (filter) body.filterGroups = fields.map((f) => ({ filters: [{ propertyName: f, operator: 'HAS_PROPERTY' }] }));
      const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search`, { method: 'POST', body: JSON.stringify(body) });
      for (const r of resp.results || []) {
        let n = 0;
        for (const f of fields) for (const u of split(r.properties?.[f])) if (isHubspotFileUrl(u)) n++;
        if (n > 0) { records++; photos += n; }
      }
      after = resp.paging?.next?.after || undefined;
    } while (after);
    return { records, photos };
  };
  const inspections = await tally(typeIds().answer, await answerPhotoScanFields(typeIds().answer), true);
  const svcType = (process.env.HUBSPOT_SERVICE_TYPE_ID || '').trim();
  const services = svcType
    ? await tally(svcType, ['before_photo_urls', 'after_photo_urls', 'pet_before_photo_urls', 'pet_after_photo_urls'], false)
    : { records: 0, photos: 0 };
  return { inspections, services, configured: true };
}

/**
 * Diagnose the exact answer records still holding HubSpot photo URLs, and
 * (apply=true) migrate them directly — one record at a time, bypassing the
 * batch/cursor machinery — so a straggler set that the normal migration keeps
 * reporting-but-not-touching gets resolved. For each straggler URL it downloads,
 * copies to Blob, and rewrites the reference; a URL that no longer exists in
 * HubSpot (dead 404/410) is reported and, with prune=true, dropped from the
 * record so the "remaining" count can reach 0. Returns per-URL outcomes.
 */
export interface StragglerReport {
  scannedRecords: number; stragglerRecords: number; stragglerUrls: number;
  migrated: number; pruned: number; dead: number; errors: number;
  samples: Array<{ recordId: string; field: string; url: string; outcome: string }>;
}
export async function reconcileStragglerPhotos(opts: { apply: boolean; prune: boolean; max?: number }): Promise<StragglerReport> {
  const max = opts.max ?? 500;
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN || '';
  if (opts.apply && !blobToken) throw new Error('BLOB_READ_WRITE_TOKEN is not set — cannot copy to Blob.');
  const split = (raw: any): string[] => String(raw || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  const rep: StragglerReport = { scannedRecords: 0, stragglerRecords: 0, stragglerUrls: 0, migrated: 0, pruned: 0, dead: 0, errors: 0, samples: [] };
  const answerType = typeIds().answer;
  const fields = await answerPhotoScanFields(answerType);
  const addSample = (recordId: string, field: string, url: string, outcome: string) => {
    if (rep.samples.length < 40) rep.samples.push({ recordId, field, url: url.slice(0, 160), outcome });
  };

  let after: string | undefined;
  outer: do {
    const body: any = { limit: 100, after, properties: fields, filterGroups: fields.map((f) => ({ filters: [{ propertyName: f, operator: 'HAS_PROPERTY' }] })) };
    const resp = await hubspotFetch(`/crm/v3/objects/${answerType}/search`, { method: 'POST', body: JSON.stringify(body) });
    for (const r of resp.results || []) {
      rep.scannedRecords++;
      const p = r.properties || {};
      let recordHadStraggler = false;
      const patch: Record<string, any> = {};
      for (const field of fields) {
        const urls = split(p[field]);
        if (!urls.length) continue;
        const next: string[] = [];
        let changed = false;
        for (const u of urls) {
          if (isBlobFileUrl(u) || !isHubspotFileUrl(u)) { next.push(u); continue; }
          // A HubSpot straggler.
          rep.stragglerUrls++; recordHadStraggler = true;
          if (!opts.apply) { addSample(String(r.id), field, u, 'found'); next.push(u); continue; }
          try {
            const dl = await fetchWithTimeout(u.split('#')[0], {}, 25000);
            if (dl.status === 404 || dl.status === 410) {   // file gone from HubSpot
              rep.dead++;
              if (opts.prune) { changed = true; addSample(String(r.id), field, u, 'pruned-dead'); /* drop */ }
              else { next.push(u); addSample(String(r.id), field, u, `dead ${dl.status}`); }
              continue;
            }
            if (!dl.ok) { rep.errors++; next.push(u); addSample(String(r.id), field, u, `download ${dl.status}`); continue; }
            const buf = Buffer.from(await dl.arrayBuffer());
            const name = decodeURIComponent(u.split('#')[0].split('?')[0].split('/').pop() || `photo_${Date.now()}.jpg`);
            const m = /idbph_(\d+)__/.exec(name);
            const key = `inspections/${m ? m[1] : String(r.id)}/${name}`;
            const putRes = await put(key, buf, { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: dl.headers.get('content-type') || 'image/jpeg', token: blobToken });
            next.push(putRes.url); changed = true; rep.migrated++;
            addSample(String(r.id), field, u, 'migrated');
          } catch (e: any) {
            rep.errors++; next.push(u); addSample(String(r.id), field, u, `error ${String(e?.message || e).slice(0, 40)}`);
          }
        }
        if (opts.apply && changed) {
          const finalUrls = Array.from(new Set(next)).filter((x) => x !== '');
          patch[field] = finalUrls.join(PHOTO_URL_DELIMITER);
          if (field === 'photo_urls') patch.photo_count = finalUrls.length;
        }
      }
      if (recordHadStraggler) rep.stragglerRecords++;
      if (opts.apply && Object.keys(patch).length) {
        try { await hubspotFetch(`/crm/v3/objects/${answerType}/${r.id}`, { method: 'PATCH', body: JSON.stringify({ properties: patch }) }); }
        catch (e: any) { rep.errors++; addSample(String(r.id), '(patch)', '', `patch ${String(e?.message || e).slice(0, 40)}`); }
      }
      if (rep.stragglerUrls >= max) break outer;
    }
    after = resp.paging?.next?.after || undefined;
  } while (after);

  // pruned = dead URLs actually dropped (only when prune requested)
  rep.pruned = opts.prune ? rep.dead : 0;
  return rep;
}

// COMPLETE set of HubSpot photo URLs still referenced by any inspection answer or
// service record. FULLY paginated (never budget-cut) so the orphan check can't
// false-positive and delete a live photo. Cached briefly for batch reuse.
let _referencedHsPhotos: { at: number; urls: Set<string> } | null = null;
async function referencedHubspotPhotoUrls(force = false): Promise<Set<string>> {
  if (!force && _referencedHsPhotos && Date.now() - _referencedHsPhotos.at < 5 * 60 * 1000) return _referencedHsPhotos.urls;
  const urls = new Set<string>();
  const split = (raw: any): string[] => String(raw || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  const scan = async (typeId: string, fields: string[], filter: boolean) => {
    let after: string | undefined;
    do {
      const body: any = { limit: 100, after, properties: fields };
      if (filter) body.filterGroups = fields.map((f) => ({ filters: [{ propertyName: f, operator: 'HAS_PROPERTY' }] }));
      const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search`, { method: 'POST', body: JSON.stringify(body) });
      for (const r of resp.results || []) for (const f of fields) for (const u of split(r.properties?.[f])) if (isHubspotFileUrl(u)) urls.add(normFileUrl(u));
      after = resp.paging?.next?.after || undefined;
    } while (after);
  };
  await scan(typeIds().answer, await answerPhotoScanFields(typeIds().answer), true);
  // Final Checklist photos are NOT in photo_urls — they're embedded in the `note`
  // JSON of the fc__all qa record. Scan those too, or the reclaim treats them as
  // orphans and deletes them (this is the bug that lost FC photos). Fail-closed:
  // this scan throwing aborts the whole delete (safe), same as the others.
  {
    let after: string | undefined;
    do {
      const body: any = {
        limit: 100, after, properties: ['note'],
        filterGroups: [{ filters: [{ propertyName: 'question_id_external', operator: 'EQ', value: 'fc__all' }] }],
      };
      const resp = await hubspotFetch(`/crm/v3/objects/${typeIds().answer}/search`, { method: 'POST', body: JSON.stringify(body) });
      for (const r of resp.results || []) for (const u of finalChecklistPhotos(parseFcAnswers(r.properties?.note))) if (isHubspotFileUrl(u)) urls.add(normFileUrl(u));
      after = resp.paging?.next?.after || undefined;
    } while (after);
  }
  const svcType = (process.env.HUBSPOT_SERVICE_TYPE_ID || '').trim();
  if (svcType) await scan(svcType, ['before_photo_urls', 'after_photo_urls', 'pet_before_photo_urls', 'pet_after_photo_urls'], false);
  _referencedHsPhotos = { at: Date.now(), urls };
  return urls;
}

export interface DeleteMigratedBatch {
  after: string | null; done: boolean; referencedCount: number;
  listed: number; appPhotos: number; skippedNonApp: number;
  orphaned: number; referencedKept: number; deleted: number; errors: number; errorSamples: string[];
  capped?: boolean;   // scan stopped early on a HubSpot list error (e.g. the ~10k scroll cap)
  tooNew?: number;    // orphan-looking files skipped by the age guard (kept, not deleted)
}

// Never reclaim a file younger than this — a just-uploaded photo may be in flight
// (its answer record not yet patched with the URL, or missing from a slightly
// stale referenced snapshot). Deleting it was the shape of the prior FC-photo-loss
// incident; the age guard closes that window regardless of cache/scan timing.
const MIN_RECLAIM_AGE_MS = 48 * 60 * 60 * 1000;

/**
 * List one page of files via the SEARCH endpoint (the bare collection path only
 * accepts POST/upload → GET 405). PREFER a folder-scoped query (path=/inspection_
 * photos): HubSpot caps a single paginated scroll at ~10k results, so scanning the
 * whole portal (app photos + every other file) 400s partway; scoping to our photo
 * folder keeps the scroll to just app photos (~thousands), well under the cap. One
 * retry for a transient blip; fall back to an unscoped query if `path` is rejected.
 */
async function listHubspotFilesPage(after?: string): Promise<{ results: any[]; next: string | null }> {
  const build = (scoped: boolean) => {
    const qs = new URLSearchParams({ limit: '100' });
    if (after) qs.set('after', after);
    if (scoped) qs.set('path', '/inspection_photos');
    return `/files/v3/files/search?${qs.toString()}`;
  };
  const call = async (scoped: boolean) => {
    const r = await hubspotFetch(build(scoped));
    return { results: r.results || [], next: r.paging?.next?.after || null };
  };
  try { return await call(true); }               // folder-scoped (preferred)
  catch (e1: any) {
    try { return await call(true); }             // one retry — transient blip
    catch {
      try { return await call(false); }          // `path` unsupported → unscoped
      catch { throw e1; }                        // give the caller the original error
    }
  }
}

/**
 * ONE page of the "delete migrated originals from HubSpot" sweep. Dry-run unless
 * apply=true. Lists HubSpot files, keeps only the app's /inspection_photos, and
 * deletes those whose URL is NOT in the (complete) referenced set. Client loops
 * with the returned `after` until done. A hard list failure ends the run
 * gracefully (done + capped) so gathered counts survive instead of erroring out.
 */
// Reclaim kill-switch. Was disabled during the FC-photo-loss incident. RE-ENABLED
// after: (1) FC photos restored from trash + migrated to Blob (verify shows
// hubspot:0), and (2) referencedHubspotPhotoUrls proven exhaustive — it now scans
// answer photo_urls/after_photo_urls, the fc__all note JSON via finalChecklistPhotos
// (which includes pool photos), AND service photos. So a referenced HubSpot photo
// can no longer be seen as an orphan. Deletion only removes /inspection_photos
// files that NO record references.
const RECLAIM_DELETE_DISABLED = false;

export async function deleteMigratedHubspotPhotosBatch(opts: { apply: boolean; after?: string }): Promise<DeleteMigratedBatch> {
  // Force dry-run while the kill-switch is on — never delete.
  const apply = opts.apply && !RECLAIM_DELETE_DISABLED;
  const rep: DeleteMigratedBatch = { after: opts.after ?? null, done: false, referencedCount: 0, listed: 0, appPhotos: 0, skippedNonApp: 0, orphaned: 0, referencedKept: 0, deleted: 0, errors: 0, errorSamples: [] };
  // On the FIRST page of an apply run, force a FRESH referenced-set snapshot (don't
  // trust the up-to-5-min cache) so a photo referenced since the last scan isn't
  // treated as an orphan. Subsequent pages reuse it within the run.
  const referenced = await referencedHubspotPhotoUrls(apply && !opts.after);
  rep.referencedCount = referenced.size;
  const nowMs = Date.now();

  let results: any[];
  try {
    const page = await listHubspotFilesPage(opts.after);
    results = page.results;
    rep.after = page.next;
    rep.done = !page.next;
  } catch (e: any) {
    // Couldn't list this page even after retry/fallback (HubSpot ~10k scroll cap
    // or an outage). Stop cleanly: keep what we counted, flag it, don't throw.
    rep.done = true; rep.capped = true; rep.after = null;
    rep.errorSamples.push(`list: ${String(e?.message || e).slice(0, 80)}`);
    return rep;
  }

  for (const f of results) {
    rep.listed++;
    const path = String(f.path || '');
    const rawUrl = String(f.url || '');
    // ONLY the app's photo folder — /inspection_photos — which holds BOTH
    // inspection and service photos (services reuse the same uploader; there is
    // no separate service folder). HARD DENY the app's other folders (report PDFs,
    // compliance-ticket photos) and every non-app portal file: match the folder as
    // a real PATH SEGMENT (authoritative `path`), with a segment-anchored URL
    // fallback only when `path` is absent. Nothing outside this folder is ever
    // deleted — it's counted as skippedNonApp and left untouched.
    const inOtherAppFolder = /(^|\/)(inspection_pdfs|compliance_ticket_photos)(\/|$)/i.test(path);
    const isAppPhoto = !inOtherAppFolder && (
      /(^|\/)inspection_photos(\/|$)/i.test(path) ||
      (!path && /\/inspection_photos\//i.test(rawUrl))
    );
    if (!isAppPhoto) { rep.skippedNonApp++; continue; }
    rep.appPhotos++;
    if (referenced.has(normFileUrl(rawUrl))) { rep.referencedKept++; continue; } // still in use → keep
    // Age guard: never delete a recently-uploaded file (or one whose createdAt we
    // can't read) — it may be an in-flight photo not yet referenced. Kept, retried
    // on a later run once it has aged past the window and (if still unused) is safe.
    const createdMs = Date.parse(String(f.createdAt || '')) || 0;
    if (!createdMs || (nowMs - createdMs) < MIN_RECLAIM_AGE_MS) { rep.tooNew = (rep.tooNew || 0) + 1; continue; }
    rep.orphaned++;
    if (!apply) continue;
    // Process the WHOLE page (≤100) before advancing the cursor — deleting mid-
    // page and then advancing would skip the rest. 100 deletes fit the budget.
    try { await deleteHubspotFileById(String(f.id)); rep.deleted++; }
    catch (e: any) { rep.errors++; if (rep.errorSamples.length < 10) rep.errorSamples.push(`${f.id}: ${String(e?.message || e).slice(0, 80)}`); }
  }
  return rep;
}

/**
 * Read-only diagnostic: for one inspection (by record id, or the first match of a
 * search query like an address), report what photos each of its answer records
 * actually holds — classified as HubSpot-hosted, Vercel Blob, offline draft
 * (blob:/data:), or other — so a "report saved but photos missing" incident can
 * be triaged (records with 0 photos where photos were expected = the photos
 * never made it off the device; drafts persisted = stuck, still recoverable).
 */
export interface PhotoAuditAnswer { recordId: string; type: string; section: string; total: number; hubspot: number; blob: number; draft: number; other: number; live?: number; dead?: number; }
export interface PhotoAuditReport { inspectionId: string | null; found: boolean; answers: PhotoAuditAnswer[]; totals: { answers: number; photos: number; hubspot: number; blob: number; draft: number; other: number; live?: number; dead?: number; checked?: number }; deadSamples?: string[]; }

/** HEAD-ish liveness check for a stored photo URL. Range 0-0 avoids downloading
 *  the whole image; any 2xx = live, anything else (or a network throw) = dead.
 *  Returns the HTTP status (or 0 on a network error) for dead-sample reporting. */
async function checkUrlLive(url: string): Promise<{ ok: boolean; status: number }> {
  const clean = url.split('#')[0];
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(clean, { method: 'GET', headers: { Range: 'bytes=0-0' }, signal: ctrl.signal });
    // Drain a tiny body so the socket can be reused; ignore errors.
    try { await r.arrayBuffer(); } catch { /* ignore */ }
    return { ok: r.ok || r.status === 206, status: r.status };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(t);
  }
}

export async function auditInspectionPhotos(opts: { inspectionId?: string; query?: string; verify?: boolean }): Promise<PhotoAuditReport> {
  let id = (opts.inspectionId || '').trim();
  if (!id && opts.query) {
    const matches = await fetchInspections({ search: opts.query }).catch(() => []);
    id = matches[0]?.recordId || '';
  }
  const empty: PhotoAuditReport = { inspectionId: id || null, found: false, answers: [], totals: { answers: 0, photos: 0, hubspot: 0, blob: 0, draft: 0, other: 0 } };
  if (!id) return empty;
  const answers = await fetchAnswersForInspection(id).catch(() => []);
  const t = { answers: 0, photos: 0, hubspot: 0, blob: 0, draft: 0, other: 0, live: 0, dead: 0, checked: 0 };
  const rows: PhotoAuditAnswer[] = [];
  const deadSamples: string[] = [];
  const CHECK_CAP = 500;     // bound the liveness sweep to stay within maxDuration

  for (const a of answers) {
    // Final Checklist photos are NOT in photo_urls — they live inside the FC
    // JSON blob (a `qa` record whose `note` is a serialized FcAnswers map). Pull
    // them out explicitly so the audit (and the reclaim referenced-set, which
    // ALSO only reads photo_urls) doesn't miss them.
    const isFcBlob = a.answerType === 'qa'
      && (/^fc__/.test(a.questionIdExternal || '') || /^final.?checklist$/i.test((a.answerValue || '').trim()));
    const urls = isFcBlob
      ? finalChecklistPhotos(parseFcAnswers(a.note))
      : [...(a.photoUrls || []), ...(a.afterPhotoUrls || [])];
    if (!urls.length && a.answerType !== 'section_photo') continue;
    const row: PhotoAuditAnswer = { recordId: a.recordId, type: isFcBlob ? 'final_checklist' : (a.answerType || ''), section: isFcBlob ? 'Final Checklist' : (a.section || ''), total: urls.length, hubspot: 0, blob: 0, draft: 0, other: 0 };
    for (const u of urls) {
      if (/^(blob:|data:)/.test(u)) row.draft++;
      else if (isBlobFileUrl(u)) row.blob++;
      else if (isHubspotFileUrl(u)) row.hubspot++;
      else row.other++;
    }

    if (opts.verify) {
      // Check remote URLs (blob/hubspot/http) for liveness — a draft can't be
      // fetched here (device-local), so it's neither live nor dead. Concurrency
      // of 10 keeps 391 photos well inside the 60s function budget.
      row.live = 0; row.dead = 0;
      const remote = urls.filter((u) => !/^(blob:|data:)/.test(u));
      for (let i = 0; i < remote.length && t.checked < CHECK_CAP; i += 10) {
        const chunk = remote.slice(i, i + 10);
        const results = await Promise.all(chunk.map((u) => checkUrlLive(u).then((res) => ({ u, res }))));
        for (const { u, res } of results) {
          t.checked++;
          if (res.ok) { row.live!++; t.live++; }
          else {
            row.dead!++; t.dead++;
            if (deadSamples.length < 8) {
              try { const p = new URL(u.split('#')[0]); deadSamples.push(`${res.status || 'ERR'} ${p.host}${p.pathname}`); }
              catch { deadSamples.push(`${res.status || 'ERR'} ${u.slice(0, 80)}`); }
            }
          }
        }
      }
    }

    t.answers++; t.photos += row.total; t.hubspot += row.hubspot; t.blob += row.blob; t.draft += row.draft; t.other += row.other;
    rows.push(row);
  }
  return { inspectionId: id, found: true, answers: rows, totals: t, ...(opts.verify ? { deadSamples } : {}) };
}

/**
 * BLAST-RADIUS scan for the Final Checklist photo loss. Enumerates every fc__all
 * blob across ALL inspections (paginated; the FC blob is one qa record per
 * inspection), extracts its embedded photos, and classifies them HubSpot / Blob /
 * draft. With verify=1 it also HEAD-checks the HubSpot ones for liveness so we can
 * count how many FC photos are actually GONE (404) vs still recoverable. Budgeted
 * + cursor-resumable so the admin can loop it. Read-only.
 */
export interface FcScanBatch {
  after: string | null; done: boolean;
  fcRecords: number; recordsWithHubspot: number;
  fcPhotos: number; hubspot: number; blob: number; draft: number; other: number;
  live?: number; dead?: number; checked?: number;
  deadRecordIds?: string[];   // sample FC answer-record ids that have dead photos
  deadSamples?: string[];
  hubspotUrls?: string[];     // full deduped list of HubSpot FC URLs (for a restore request)
}
export async function scanFinalChecklistPhotos(opts: { after?: string; verify?: boolean; budgetMs?: number; dumpUrls?: boolean }): Promise<FcScanBatch> {
  const start = Date.now();
  const budgetMs = opts.budgetMs ?? 45000;
  const verify = opts.verify && !opts.dumpUrls;   // dump is classification-only (fast) so it can cover ALL records in one call
  const answerType = typeIds().answer;
  const dumped = new Set<string>();
  const rep: FcScanBatch = {
    after: opts.after ?? null, done: false, fcRecords: 0, recordsWithHubspot: 0,
    fcPhotos: 0, hubspot: 0, blob: 0, draft: 0, other: 0,
    ...(verify ? { live: 0, dead: 0, checked: 0, deadRecordIds: [], deadSamples: [] } : {}),
  };
  let after = opts.after || undefined;
  do {
    const body: any = {
      limit: 100, after, properties: ['note'],
      filterGroups: [{ filters: [{ propertyName: 'question_id_external', operator: 'EQ', value: 'fc__all' }] }],
    };
    const resp = await hubspotFetch(`/crm/v3/objects/${answerType}/search`, { method: 'POST', body: JSON.stringify(body) });
    for (const r of resp.results || []) {
      rep.fcRecords++;
      const photos = finalChecklistPhotos(parseFcAnswers(r.properties?.note));
      let recHubspot = 0, recDead = 0;
      for (const u of photos) {
        rep.fcPhotos++;
        if (/^(blob:|data:)/.test(u)) rep.draft++;
        else if (isBlobFileUrl(u)) rep.blob++;
        else if (isHubspotFileUrl(u)) { rep.hubspot++; recHubspot++; if (opts.dumpUrls) dumped.add(normFileUrl(u)); }
        else rep.other++;
      }
      if (recHubspot) rep.recordsWithHubspot++;
      if (verify && recHubspot) {
        const hs = photos.filter((u) => isHubspotFileUrl(u));
        for (let i = 0; i < hs.length; i += 8) {
          const chunk = hs.slice(i, i + 8);
          const results = await Promise.all(chunk.map((u) => checkUrlLive(u)));
          results.forEach((res, j) => {
            rep.checked!++;
            if (res.ok) rep.live!++;
            else {
              rep.dead!++; recDead++;
              if (rep.deadSamples!.length < 10) {
                try { const p = new URL(chunk[j].split('#')[0]); rep.deadSamples!.push(`${res.status || 'ERR'} ${p.host}${p.pathname}`); }
                catch { rep.deadSamples!.push(`${res.status || 'ERR'}`); }
              }
            }
          });
        }
        if (recDead && rep.deadRecordIds!.length < 100) rep.deadRecordIds!.push(String(r.id));
      }
    }
    after = resp.paging?.next?.after || undefined;
    if (!opts.dumpUrls && Date.now() - start > budgetMs) break;   // budget hit → return cursor to resume (dump runs to completion)
  } while (after);
  rep.after = after || null;
  rep.done = !after;
  if (opts.dumpUrls) rep.hubspotUrls = Array.from(dumped);
  return rep;
}

/**
 * Move Final Checklist photos from HubSpot → Vercel Blob and RECONNECT them.
 *
 * For each fc__all blob: download every HubSpot-hosted FC photo (must be LIVE —
 * i.e. already restored from the HubSpot trash), copy it to Blob (verified by
 * re-download + byte match), then rewrite the fc__all `note` JSON so the record
 * points at the Blob copy (via remapFcAnswerUrls — nothing else in the answer is
 * touched). Photos that are still 404 (not yet restored) are counted as
 * `skippedDead` and left untouched so a later pass can pick them up. Does NOT
 * delete the HubSpot originals — once records point to Blob those originals are
 * orphaned and the (now FC-aware) reclaim removes them safely. Budgeted +
 * cursor-resumable; dry-run unless apply=true.
 */
export interface FcMigrateBatch {
  after: string | null; done: boolean;
  fcRecords: number; hubspotSeen: number; copied: number; verified: number;
  recordsUpdated: number; skippedDead: number; errors: number; errorSamples: string[];
}
export async function migrateFinalChecklistPhotosBatch(opts: { after?: string; apply: boolean; budgetMs?: number }): Promise<FcMigrateBatch> {
  const start = Date.now();
  const budgetMs = opts.budgetMs ?? 45000;
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN || '';
  if (opts.apply && !blobToken) throw new Error('BLOB_READ_WRITE_TOKEN is not set — cannot copy to Blob.');
  const answerType = typeIds().answer;
  const rep: FcMigrateBatch = { after: opts.after ?? null, done: false, fcRecords: 0, hubspotSeen: 0, copied: 0, verified: 0, recordsUpdated: 0, skippedDead: 0, errors: 0, errorSamples: [] };
  const err = (m: string) => { rep.errors++; if (rep.errorSamples.length < 10) rep.errorSamples.push(m.slice(0, 120)); };
  const norm = (u: string) => u.split('#')[0].split('?')[0].trim();
  const DL_TIMEOUT_MS = 25000, VERIFY_TIMEOUT_MS = 20000;

  let after = opts.after || undefined;
  do {
    const body: any = {
      limit: 25, after, properties: ['note'],
      filterGroups: [{ filters: [{ propertyName: 'question_id_external', operator: 'EQ', value: 'fc__all' }] }],
    };
    const resp = await hubspotFetch(`/crm/v3/objects/${answerType}/search`, { method: 'POST', body: JSON.stringify(body) });
    for (const r of resp.results || []) {
      rep.fcRecords++;
      const fc = parseFcAnswers(r.properties?.note);
      const hsUrls = Array.from(new Set(finalChecklistPhotos(fc).filter((u) => isHubspotFileUrl(u)).map(norm)));
      if (!hsUrls.length) continue;
      const urlMap = new Map<string, string>();
      for (const u of hsUrls) {
        rep.hubspotSeen++;
        if (!opts.apply) continue;
        try {
          let res = await fetchWithTimeout(u, {}, DL_TIMEOUT_MS).catch(() => null as any);
          if (!res || !res.ok) {
            // 404 = still in the trash (not restored yet) → skip, don't fail. Any
            // other miss also just defers this photo to a later pass.
            rep.skippedDead++; continue;
          }
          const buf = Buffer.from(await res.arrayBuffer());
          const name = decodeURIComponent(u.split('?')[0].split('/').pop() || `fc_photo.jpg`);
          const m = /idbph_(\d+)__/.exec(name);
          const key = `inspections/${m ? m[1] : r.id}/${name}`;
          const putRes = await put(key, buf, { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: res.headers.get('content-type') || 'image/jpeg', token: blobToken });
          rep.copied++;
          const vr = await fetchWithTimeout(putRes.url, {}, VERIFY_TIMEOUT_MS);
          if (!vr.ok || Buffer.from(await vr.arrayBuffer()).length !== buf.length) throw new Error('verify failed');
          rep.verified++;
          urlMap.set(u, putRes.url);
        } catch (e: any) { err(`${u.slice(0, 50)}: ${String(e?.message || e).slice(0, 60)}`); }
      }
      if (opts.apply && urlMap.size) {
        const { answers: nextFc, swapped } = remapFcAnswerUrls(fc, urlMap);
        if (swapped) {
          try {
            await hubspotFetch(`/crm/v3/objects/${answerType}/${r.id}`, { method: 'PATCH', body: JSON.stringify({ properties: { note: JSON.stringify(nextFc) } }) });
            rep.recordsUpdated++;
          } catch (e: any) { err(`patch ${r.id}: ${String(e?.message || e).slice(0, 60)}`); }
        }
      }
    }
    after = resp.paging?.next?.after || undefined;
    if (Date.now() - start > budgetMs) break;
  } while (after);
  rep.after = after || null;
  rep.done = !after;
  return rep;
}

/**
 * Update an Inspection record's properties (status, etc.).
 */
/**
 * List the HubSpot record ids of every COMPLETED scope (pm_scope_rate_card)
 * inspection. Used by the bulk "regenerate PDFs" admin tool to retrofit the
 * photo-gallery links into existing PDFs (by re-finalizing each).
 */
export async function listRegenerableScopeInspectionIds(): Promise<Array<{ id: string; status: string }>> {
  const { inspection: typeId } = typeIds();
  const out: Array<{ id: string; status: string }> = [];
  let after: string | undefined;
  do {
    const body: any = {
      filterGroups: [{
        filters: [
          // Reports whose PDFs can be (re)generated: submitted, pending approval,
          // and completed scope inspections. The /admin/regenerate-pdfs tool runs
          // these in regenerate-only mode, which refreshes the PDFs in place
          // WITHOUT changing status or sending any email/ticket.
          { propertyName: 'status', operator: 'IN', values: ['submitted', 'pending_approval', 'completed'] },
          { propertyName: 'template_type', operator: 'EQ', value: 'pm_scope_rate_card' },
        ],
      }],
      properties: ['inspection_id_external', 'status'],
      limit: 100,
    };
    if (after) body.after = after;
    const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search?archived=false`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    for (const r of resp.results || []) out.push({ id: String(r.id), status: String(r.properties?.status || '') });
    after = resp.paging?.next?.after;
  } while (after);
  return out;
}

export async function updateInspection(recordId: string, props: Record<string, any>): Promise<void> {
  const { inspection: typeId } = typeIds();
  await hubspotFetch(`/crm/v3/objects/${typeId}/${recordId}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties: props }),
  });
}

/**
 * Find an inspection's HubSpot record id by its `inspection_id_external`, or null.
 * Used to make /api/inspections/create idempotent for offline-started ("deferred
 * create") inspections: the client generates the external id, so a retried create
 * (after a partial success the client never saw) returns the EXISTING record
 * instead of minting a duplicate.
 */
export async function findInspectionIdByExternalId(externalId: string): Promise<string | null> {
  if (!externalId) return null;
  const { inspection: typeId } = typeIds();
  try {
    const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search?archived=false`, {
      method: 'POST',
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: 'inspection_id_external', operator: 'EQ', value: externalId }] }],
        properties: ['inspection_id_external'],
        limit: 1,
      }),
    });
    const hit = resp.results?.[0];
    return hit ? String(hit.id) : null;
  } catch {
    return null; // treat a lookup failure as "not found" → create proceeds
  }
}

/**
 * Update a Property record's properties. Used by the Final Checklist to write
 * back the confirmed air-filter quantity/types onto the property object.
 */
export async function updateProperty(recordId: string, props: Record<string, any>): Promise<void> {
  const { property: typeId } = typeIds();
  await hubspotFetch(`/crm/v3/objects/${typeId}/${recordId}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties: props }),
  });
}

/**
 * Read the enumeration (dropdown) option labels defined on a Property field —
 * used to populate the air-filter size scroll-wheels straight from HubSpot so
 * they stay in sync with the field's configured options. Returns [] on any
 * error so the caller can fall back gracefully.
 */
// Property dropdown options are global schema metadata (e.g. air-filter sizes),
// identical for every user and rarely changed — but were read from HubSpot on
// every inspection-detail load (3 reads per open). Cache them so hundreds of
// concurrent opens don't each re-read the schema; a short-ish TTL keeps the
// scroll-wheels in sync after an admin edits the field.
const _propFieldOptionsCache = new Map<string, { opts: string[]; at: number }>();
const PROP_FIELD_OPTIONS_TTL_MS = 30 * 60 * 1000;
export async function fetchPropertyFieldOptions(fieldName: string): Promise<string[]> {
  const cached = _propFieldOptionsCache.get(fieldName);
  if (cached && Date.now() - cached.at < PROP_FIELD_OPTIONS_TTL_MS) return cached.opts;
  const { property: typeId } = typeIds();
  try {
    const resp = await hubspotFetch(`/crm/v3/properties/${typeId}/${encodeURIComponent(fieldName)}`);
    const options = Array.isArray(resp.options) ? resp.options : [];
    const opts = options
      .filter((o: any) => o && o.hidden !== true)
      .map((o: any) => String(o.label ?? o.value ?? '').trim())
      .filter(Boolean);
    _propFieldOptionsCache.set(fieldName, { opts, at: Date.now() });
    return opts;
  } catch (e: any) {
    console.warn(`[fetchPropertyFieldOptions] ${fieldName} unavailable:`, String(e).slice(0, 160));
    return cached?.opts ?? []; // serve stale on a transient error rather than blanking the wheel
  }
}

/**
 * Resolve the canonical custom-object type IDs the app depends on. Throws (with
 * a precise message) if a required *_TYPE_ID env var is missing. Used by the
 * config-check endpoint to validate the environment is wired correctly.
 */
export function resolvedTypeIds(): { inspection: string; question: string; answer: string; property: string } {
  return typeIds();
}

/**
 * List the internal names of every property defined on a HubSpot object type.
 * Used by config validation to detect missing inspection properties that would
 * otherwise make finalize silently degrade (its PROPERTY_DOESNT_EXIST fallbacks
 * drop PDFs / status writes without surfacing the misconfiguration).
 */
export async function listObjectPropertyNames(typeId: string): Promise<string[]> {
  const resp = await hubspotFetch(`/crm/v3/properties/${typeId}`);
  return (resp.results || []).map((p: any) => String(p.name)).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Billing-field sync (for clean billing reports)
//
// On schedule/creation we copy billing fields onto the inspection from the
// related Property + the Agent object (2-13064238), matched by HubSpot owner:
//   entity_id, full_address          ← Property
//   broker_code, vendor/client cost  ← Agent owned by the inspector's owner
// Owner is resolved from the inspector's email (Owners API). Best-effort — never
// throws; missing properties are reported so the create-script can be run.
// ---------------------------------------------------------------------------

function agentTypeId(): string {
  return normalizeTypeId(process.env.HUBSPOT_AGENT_TYPE_ID) || '2-13064238';
}

/** Resolve a HubSpot owner id from an email via the Owners API. */
async function resolveOwnerIdByEmail(email: string): Promise<string | null> {
  const e = (email || '').trim();
  if (!e) return null;
  try {
    const resp = await hubspotFetch(`/crm/v3/owners/?email=${encodeURIComponent(e)}&limit=1`);
    const o = (resp.results || [])[0];
    return o?.id ? String(o.id) : null;
  } catch (e2) {
    console.warn('[billing] owner lookup failed:', e2);
    return null;
  }
}

/** Find the Agent record owned by `ownerId` and read its billing fields. */
async function fetchAgentBillingByOwner(ownerId: string): Promise<{ brokerCode: string; vendorCost: string; clientCost: string } | null> {
  if (!ownerId) return null;
  // The agent property that holds the owner id (default the standard owner field).
  const matchProp = (process.env.HUBSPOT_AGENT_OWNER_MATCH_PROP || 'hubspot_owner_id').trim();
  try {
    const resp = await hubspotFetch(`/crm/v3/objects/${agentTypeId()}/search?archived=false`, {
      method: 'POST',
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: matchProp, operator: 'EQ', value: ownerId }] }],
        properties: ['broker_code', 'inspection_vendor_cost', 'inspection_client_cost', 'name'],
        limit: 1,
      }),
    });
    const a = (resp.results || [])[0];
    if (!a) return null;
    const p = a.properties || {};
    return {
      brokerCode: (p.broker_code ?? '').toString().trim(),
      vendorCost: (p.inspection_vendor_cost ?? '').toString().trim(),
      clientCost: (p.inspection_client_cost ?? '').toString().trim(),
    };
  } catch (e) {
    console.warn('[billing] agent lookup failed:', e);
    return null;
  }
}

/**
 * W2 agents (owners) for the approval-routing pickers: name + Slack ID (from the
 * agent's `slack_user_id`). The "type" + slack property names are env-overridable;
 * the W2 filter is applied CLIENT-SIDE (an unknown property in a Search `filters`
 * clause is a hard 400, while the projection silently ignores unknowns). If no
 * candidate type field is present on ANY agent, we can't filter — return every
 * named agent and flag typeFieldFound=false so the UI can say so.
 */
export interface AgentOwnerOption { name: string; slackId: string; }
const AGENT_TYPE_CANDIDATE_PROPS = (() => {
  const configured = (process.env.HUBSPOT_AGENT_TYPE_PROP || '').trim();
  return Array.from(new Set([
    configured, 'agent_type', 'type', 'employment_type', 'worker_type', 'employee_type', 'classification', 'w2_1099',
  ].filter(Boolean)));
})();
function agentSlackProp(): string { return (process.env.HUBSPOT_AGENT_SLACK_PROP || 'slack_user_id').trim(); }
function isW2Value(v: unknown): boolean {
  return String(v ?? '').replace(/[^a-z0-9]/gi, '').toUpperCase().includes('W2');
}

export async function fetchW2Agents(): Promise<{ owners: AgentOwnerOption[]; typeFieldFound: boolean }> {
  const slackProp = agentSlackProp();
  const properties = Array.from(new Set(['name', 'firstname', 'lastname', slackProp, ...AGENT_TYPE_CANDIDATE_PROPS]));
  const all: { name: string; slackId: string; typeVals: unknown[] }[] = [];
  let after: string | undefined;
  let pages = 0;
  const MAX_PAGES = 25; // 2,500 agents — far beyond any realistic staff roster
  do {
    const body: any = { filterGroups: [], properties, limit: 100 };
    if (after) body.after = after;
    let resp: any;
    try {
      resp = await hubspotFetch(`/crm/v3/objects/${agentTypeId()}/search?archived=false`, { method: 'POST', body: JSON.stringify(body) });
    } catch (e) {
      console.warn('[approval-routing] agent search failed:', e);
      break;
    }
    for (const r of resp.results || []) {
      const p = r.properties || {};
      let name = String(p.name || '').trim();
      if (!name) name = `${String(p.firstname || '').trim()} ${String(p.lastname || '').trim()}`.trim();
      if (!name) continue;
      all.push({ name, slackId: String(p[slackProp] || '').trim(), typeVals: AGENT_TYPE_CANDIDATE_PROPS.map((tp) => p[tp]) });
    }
    after = resp.paging?.next?.after;
  } while (after && ++pages < MAX_PAGES);

  const typeFieldFound = all.some((a) => a.typeVals.some((v) => v != null && String(v).trim() !== ''));
  const picked = typeFieldFound ? all.filter((a) => a.typeVals.some(isW2Value)) : all;
  const seen = new Set<string>();
  const owners: AgentOwnerOption[] = [];
  for (const a of picked.sort((x, y) => x.name.localeCompare(y.name))) {
    const key = a.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    owners.push({ name: a.name, slackId: a.slackId });
  }
  return { owners, typeFieldFound };
}

// ---------------------------------------------------------------------------
// AI Knowledge Base (live-camera operator notes)
//
// Inspectors "teach" the live in-camera call-out model via voice; their
// approved tips persist as a JSON array on ONE property of the admin's Agent
// record (no new custom object), keyed by AI_KNOWLEDGE_ADMIN_EMAIL (default
// hwoods@resihome.com). The live scan endpoint reads these and appends them to
// its system prompt so call-outs/edits learn from field feedback over time.
// ---------------------------------------------------------------------------
const AI_KB_PROP = 'ai_knowledge_base_json';

// ── ResiWalk - Services settings (Form Builder + AI checks) ─────────────────
// Persisted as JSON on the SAME admin Agent record as the AI knowledge base —
// no new custom object. The properties self-provision on first write. These make
// the Form Builder + service AI-review checks editable AND live: the completion
// screen reads the forms, the AI review reads the checks.
const SERVICE_FORMS_PROP = 'service_forms_json';
const SERVICE_CHECKS_PROP = 'service_ai_checks_json';
const SERVICE_TAXONOMY_PROP = 'service_taxonomy_json';

async function ensureAgentProp(prop: string, label: string): Promise<string | null> {
  const recId = await resolveKnowledgeAgentRecordId();
  if (!recId) return null;
  const typeId = agentTypeId();
  try {
    const props = await hubspotFetch(`/crm/v3/properties/${typeId}`).catch(() => ({ results: [] }));
    const have = new Set((props.results || []).map((p: any) => p.name));
    if (!have.has(prop)) {
      const group = await ensurePropertyGroup(typeId, 'service_settings');
      await createProperty(typeId, { name: prop, label, type: 'string', fieldType: 'textarea' }, group);
    }
  } catch (e) { console.warn('[services] ensure agent prop failed:', e); }
  return recId;
}

async function readAgentJson<T>(prop: string): Promise<T | null> {
  const recId = await resolveKnowledgeAgentRecordId();
  if (!recId) return null;
  try {
    const resp = await hubspotFetch(`/crm/v3/objects/${agentTypeId()}/${recId}?properties=${prop}`);
    const raw = resp?.properties?.[prop];
    return raw ? (JSON.parse(String(raw)) as T) : null;
  } catch (e) { console.warn(`[services] read ${prop} failed:`, e); return null; }
}

async function writeAgentJson(prop: string, label: string, value: any): Promise<boolean> {
  const recId = await ensureAgentProp(prop, label);
  if (!recId) return false;
  await hubspotFetch(`/crm/v3/objects/${agentTypeId()}/${recId}`, {
    method: 'PATCH', body: JSON.stringify({ properties: { [prop]: JSON.stringify(value) } }),
  });
  return true;
}

// Concurrency-safe read-modify-write for a single agent-record JSON property.
// The plain read-then-write pattern lost-updates when two writers race (worst on
// the every-sign-in login_activity blob). This SERIALIZES read-modify-write per
// property on this instance (eliminates the same-instance interleave — the common
// case) and re-reads just before the PATCH to detect a cross-instance change and
// recompute (bounded retries). HubSpot has no conditional write, so a tiny
// cross-instance window remains; a KV-backed lock would close it fully.
const _agentWriteChains = new Map<string, Promise<unknown>>();
async function mutateAgentJson<T>(prop: string, label: string, mutator: (cur: T | null) => T): Promise<boolean> {
  const run = async (): Promise<boolean> => {
    const recId = await ensureAgentProp(prop, label);
    if (!recId) return false;
    const base = `/crm/v3/objects/${agentTypeId()}/${recId}`;
    const readVer = async (): Promise<{ cur: T | null; ver: string }> => {
      const resp = await hubspotFetch(`${base}?properties=${prop}`);
      const raw = resp?.properties?.[prop];
      return { cur: raw ? (JSON.parse(String(raw)) as T) : null, ver: String(resp?.updatedAt || resp?.properties?.hs_lastmodifieddate || '') };
    };
    for (let attempt = 0; attempt < 4; attempt++) {
      const { cur, ver } = await readVer();
      const next = mutator(cur);
      if (attempt < 3) {
        const again = await readVer();          // did anyone write since we read?
        if (again.ver && again.ver !== ver) continue;  // yes → recompute from fresh state
      }
      await hubspotFetch(base, { method: 'PATCH', body: JSON.stringify({ properties: { [prop]: JSON.stringify(next) } }) });
      return true;
    }
    return false;
  };
  const prev = _agentWriteChains.get(prop) || Promise.resolve();
  const p = prev.then(run, run);
  _agentWriteChains.set(prop, p.catch(() => false));
  return p as Promise<boolean>;
}

/** Service completion forms, keyed by `worktype:subtype` → question array. Null when unset/unreachable. */
export function readServiceForms(): Promise<Record<string, any[]> | null> { return readAgentJson<Record<string, any[]>>(SERVICE_FORMS_PROP); }
export function writeServiceForms(forms: Record<string, any[]>): Promise<boolean> { return writeAgentJson(SERVICE_FORMS_PROP, 'Service Forms (JSON)', forms); }

/** Service AI-review checks (array). Null when unset/unreachable. */
export function readServiceAiChecks(): Promise<any[] | null> { return readAgentJson<any[]>(SERVICE_CHECKS_PROP); }
export function writeServiceAiChecks(checks: any[]): Promise<boolean> { return writeAgentJson(SERVICE_CHECKS_PROP, 'Service AI Checks (JSON)', checks); }

/** Admin-added work types / subtypes (array of custom worktype defs). Null when unset. */
export function readServiceTaxonomy(): Promise<any[] | null> { return readAgentJson<any[]>(SERVICE_TAXONOMY_PROP); }
export function writeServiceTaxonomy(taxonomy: any[]): Promise<boolean> { return writeAgentJson(SERVICE_TAXONOMY_PROP, 'Service Taxonomy (JSON)', taxonomy); }

/** Per-user email notification preferences: a map of lowercased email →
 *  { [notificationKey]: boolean }. Absent keys default to ON. Null when unset. */
export function readNotificationPrefsRaw(): Promise<Record<string, Record<string, boolean>> | null> {
  return readAgentJson<Record<string, Record<string, boolean>>>('notification_prefs_json');
}
export function writeNotificationPrefsRaw(map: Record<string, Record<string, boolean>>): Promise<boolean> {
  return writeAgentJson('notification_prefs_json', 'Notification Preferences (JSON)', map);
}
/** Concurrency-safe update of one user's notification prefs (no lost-update race). */
export function mutateNotificationPrefsRaw(mutator: (cur: Record<string, Record<string, boolean>>) => Record<string, Record<string, boolean>>): Promise<boolean> {
  return mutateAgentJson<Record<string, Record<string, boolean>>>('notification_prefs_json', 'Notification Preferences (JSON)', (cur) => mutator(cur || {}));
}

/** Login activity: lowercased email → { lastAt (ISO), count, name }. Stamped at
 *  every sign-in (see lib/loginActivity). Null when unset. */
export function readLoginActivityRaw(): Promise<Record<string, { lastAt: string; count?: number; name?: string }> | null> {
  return readAgentJson<Record<string, { lastAt: string; count?: number; name?: string }>>('login_activity_json');
}
export function writeLoginActivityRaw(map: Record<string, { lastAt: string; count?: number; name?: string }>): Promise<boolean> {
  return writeAgentJson('login_activity_json', 'Login Activity (JSON)', map);
}
// Cap the login-activity blob so it can't outgrow HubSpot's ~64KB property limit
// at tens of thousands of users (keep the most recently active).
const LOGIN_ACTIVITY_MAX = 8000;
/** Concurrency-safe login-activity stamp (no lost-update on concurrent sign-ins),
 *  with a size cap that prunes the oldest entries. */
export function mutateLoginActivityRaw(mutator: (cur: Record<string, { lastAt: string; count?: number; name?: string }>) => Record<string, { lastAt: string; count?: number; name?: string }>): Promise<boolean> {
  return mutateAgentJson<Record<string, { lastAt: string; count?: number; name?: string }>>('login_activity_json', 'Login Activity (JSON)', (cur) => {
    const next = mutator(cur || {});
    const keys = Object.keys(next);
    if (keys.length > LOGIN_ACTIVITY_MAX) {
      // Keep the most-recently-active LOGIN_ACTIVITY_MAX entries.
      const sorted = keys.sort((a, b) => String(next[b]?.lastAt || '').localeCompare(String(next[a]?.lastAt || '')));
      const pruned: typeof next = {};
      for (const k of sorted.slice(0, LOGIN_ACTIVITY_MAX)) pruned[k] = next[k];
      return pruned;
    }
    return next;
  });
}

/** Background photo-migration job state (single shared record) — see
 *  /api/admin/migrate-photos-bg. Null when never started. */
export function readPhotoMigrationState<T = any>(): Promise<T | null> { return readAgentJson<T>('photo_migration_state_json'); }
export function writePhotoMigrationState(state: any): Promise<boolean> { return writeAgentJson('photo_migration_state_json', 'Photo Migration State (JSON)', state); }

/** Background photo-RECLAIM job state (deletes migrated HubSpot originals) — see
 *  /api/admin/reclaim-photos-bg. Separate record from the migration job. */
export function readPhotoReclaimState<T = any>(): Promise<T | null> { return readAgentJson<T>('photo_reclaim_state_json'); }
export function writePhotoReclaimState(state: any): Promise<boolean> { return writeAgentJson('photo_reclaim_state_json', 'Photo Reclaim State (JSON)', state); }

/** Background FC-photo-migration job state (moves restored Final Checklist photos
 *  HubSpot → Blob + reconnects) — see /api/admin/fc-migrate-bg. Own record. */
export function readFcMigrateState<T = any>(): Promise<T | null> { return readAgentJson<T>('fc_migrate_state_json'); }
export function writeFcMigrateState(state: any): Promise<boolean> { return writeAgentJson('fc_migrate_state_json', 'FC Migrate State (JSON)', state); }

/** A learned service-check candidate produced by the review-learning loop. */
export interface AutoServiceCheckCandidate {
  signature: string;
  check: string;
  worktype?: string;
  subtype?: string;
  meta?: { samples?: number; decision?: string; examples?: string[] };
}

/**
 * Merge synthesized AUTO service checks into the stored set and RETURN the full
 * merged array (the Services AI Knowledge tab edits/bulk-saves the whole array,
 * so it adopts what we return). Refreshes an existing auto check in place (same
 * signature) and never touches admin-authored checks. Auto checks are capped.
 */
export async function upsertAutoServiceChecks(candidates: AutoServiceCheckCandidate[]): Promise<{ checks: any[]; added: number; refreshed: number }> {
  const checks = (await readServiceAiChecks()) || [];
  const bySig = new Map<string, any>();
  for (const c of checks) if (c && c.source === 'auto' && c.signature) bySig.set(String(c.signature), c);

  let added = 0, refreshed = 0;
  for (const cand of candidates) {
    const existing = bySig.get(cand.signature);
    if (existing) {
      if (existing.status === 'dismissed') continue; // admin deleted it — don't resurrect
      existing.check = cand.check.slice(0, 600);
      existing.worktype = cand.worktype || '';
      existing.subtype = cand.subtype || '';
      existing.meta = cand.meta;
      refreshed++;
    } else {
      checks.unshift({
        id: `svc-auto-${cand.signature}`.slice(0, 80),
        check: cand.check.slice(0, 600),
        worktype: cand.worktype || '', subtype: cand.subtype || '',
        active: true, source: 'auto', signature: cand.signature, meta: cand.meta,
      });
      added++;
    }
  }

  // Cap auto checks (newest kept); keep every admin/human check.
  const humans = checks.filter((c) => c.source !== 'auto');
  const autos = checks.filter((c) => c.source === 'auto').slice(0, 100);
  const merged = [...autos, ...humans];
  await writeServiceAiChecks(merged);
  return { checks: merged, added, refreshed };
}

export interface AiKnowledgeEntry {
  id: string;
  text: string;
  addedByEmail: string;
  addedByName?: string;
  createdAt: number;   // epoch ms
  updatedAt?: number;  // epoch ms (set when an admin edits)
  // Provenance. Absent ⇒ 'inspector' (legacy + inspector/admin-submitted). 'auto'
  // entries are synthesized by the self-improvement loop from captured feedback;
  // they live in the same store and feed the same prompt, but admins can review,
  // edit (which ADOPTS them as 'admin'-owned), or delete (which DISMISSES them).
  source?: 'inspector' | 'admin' | 'auto';
  // 'dismissed' tombstones a deleted AUTO entry so the loop won't re-add it; such
  // entries are hidden from the UI and excluded from the AI prompt.
  status?: 'active' | 'dismissed';
  // Stable fingerprint of the learned signal, so regenerating refreshes the same
  // entry in place rather than duplicating it (auto entries only).
  signature?: string;
  // Entry kind. 'rule' (default) = a free-text house rule. 'example' = a worked
  // utterance→action pair (few-shot): `text` is what the inspector says and
  // `expected` is the correct action. Examples are the "gold list" the operator
  // curates here; they're injected into EVERY AI as worked examples.
  kind?: 'rule' | 'example';
  expected?: string;
  // Template scope: which inspection template this rule applies to. '' / absent =
  // ALL templates. The knowledge feeds the Scope Rate Card camera AI, so a rule
  // scoped to a specific template only applies when that template is in context.
  template?: string;
  // On/Off. Absent/true ⇒ the AI uses this entry; false ⇒ excluded from the prompt
  // (kept in the store so it can be toggled back on).
  active?: boolean;
  // Why the loop wrote this (sample size, example phrases, catalog code) — shown
  // to admins for context. Auto entries only.
  meta?: Record<string, string | number | string[] | undefined>;
}

// The knowledge base feeds the Scope Rate Card camera AI — the template a rule is
// evaluated in. Rules scoped to another template stay dormant until that template
// has a consumer.
export const KB_CONSUMER_TEMPLATE = 'pm_scope_rate_card';

const MAX_AUTO_ENTRIES = 150; // cap auto entries so they never crowd out human ones

// The admin Agent record id is resolved once and cached (5 min) — it never
// changes within a deploy, and resolving it costs an Owners + Search round-trip.
let _kbAgentIdCache: { id: string | null; at: number } | null = null;
// Parsed entries cached briefly so the live camera (polls every couple seconds)
// doesn't read HubSpot on every tick. Invalidated on any write.
let _kbEntriesCache: { entries: AiKnowledgeEntry[]; at: number } | null = null;

/** Resolve the Agent record id that stores the knowledge base. */
export async function resolveKnowledgeAgentRecordId(): Promise<string | null> {
  const override = (process.env.AI_KNOWLEDGE_AGENT_RECORD_ID || '').trim();
  if (override) return override;
  if (_kbAgentIdCache && Date.now() - _kbAgentIdCache.at < 5 * 60 * 1000) return _kbAgentIdCache.id;
  const email = (process.env.AI_KNOWLEDGE_ADMIN_EMAIL || 'hwoods@resihome.com').trim();
  let id: string | null = null;
  const ownerId = await resolveOwnerIdByEmail(email);
  if (ownerId) {
    const matchProp = (process.env.HUBSPOT_AGENT_OWNER_MATCH_PROP || 'hubspot_owner_id').trim();
    try {
      const resp = await hubspotFetch(`/crm/v3/objects/${agentTypeId()}/search?archived=false`, {
        method: 'POST',
        body: JSON.stringify({
          filterGroups: [{ filters: [{ propertyName: matchProp, operator: 'EQ', value: ownerId }] }],
          properties: ['name'],
          limit: 1,
        }),
      });
      const a = (resp.results || [])[0];
      if (a?.id) id = String(a.id);
    } catch (e) { console.warn('[ai-kb] agent lookup failed:', e); }
  }
  _kbAgentIdCache = { id, at: Date.now() };
  return id;
}

/** All knowledge entries (newest first). Best-effort: returns [] on any error. */
export async function readKnowledgeEntries(): Promise<AiKnowledgeEntry[]> {
  const recId = await resolveKnowledgeAgentRecordId();
  if (!recId) return [];
  try {
    const resp = await hubspotFetch(`/crm/v3/objects/${agentTypeId()}/${recId}?properties=${AI_KB_PROP}`);
    const raw = resp?.properties?.[AI_KB_PROP];
    if (!raw) return [];
    const parsed = JSON.parse(String(raw));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e) => e && typeof e.text === 'string') as AiKnowledgeEntry[];
  } catch (e) {
    console.warn('[ai-kb] read failed:', e);
    return [];
  }
}

async function writeKnowledgeEntries(entries: AiKnowledgeEntry[]): Promise<void> {
  const recId = await resolveKnowledgeAgentRecordId();
  if (!recId) {
    throw new Error('AI knowledge agent record not found — set AI_KNOWLEDGE_AGENT_RECORD_ID, or ensure the admin (AI_KNOWLEDGE_ADMIN_EMAIL) is a HubSpot owner with an Agent record.');
  }
  await hubspotFetch(`/crm/v3/objects/${agentTypeId()}/${recId}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties: { [AI_KB_PROP]: JSON.stringify(entries) } }),
  });
  _kbEntriesCache = null; // invalidate the live-camera cache
}

/** Append a new entry (inspector-submitted). Goes live immediately. Pass
 *  `expected` to record a worked EXAMPLE (utterance → correct action). */
export async function addKnowledgeEntry(input: { text: string; addedByEmail: string; addedByName?: string; expected?: string; template?: string }): Promise<AiKnowledgeEntry> {
  const text = (input.text || '').trim();
  if (!text) throw new Error('Empty knowledge text.');
  const expected = (input.expected || '').trim();
  const entries = await readKnowledgeEntries();
  const entry: AiKnowledgeEntry = {
    id: `kb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text: text.slice(0, 1000),
    addedByEmail: input.addedByEmail || '',
    addedByName: input.addedByName || '',
    createdAt: Date.now(),
    active: true,
    ...(input.template ? { template: String(input.template) } : {}),
    ...(expected ? { kind: 'example' as const, expected: expected.slice(0, 1000) } : {}),
  };
  entries.unshift(entry);
  await writeKnowledgeEntries(entries.slice(0, 500)); // hard cap to keep the property small
  return entry;
}

/**
 * Import a set of worked EXAMPLES (the curated "gold list") into the knowledge
 * base. Idempotent: skips any example whose utterance is already present, so it
 * can be re-run safely. Seeded examples are admin-owned (the learning loop won't
 * overwrite them). Used by the "Import starter examples" admin action.
 */
export async function seedKnowledgeExamples(
  seed: Array<{ utterance: string; expected: string }>,
  addedByEmail: string,
): Promise<{ added: number; skipped: number }> {
  const entries = await readKnowledgeEntries();
  const existing = new Set(
    entries.filter((e) => e.kind === 'example').map((e) => String(e.text).trim().toLowerCase()),
  );
  let added = 0, skipped = 0;
  for (const s of seed) {
    const text = String(s?.utterance || '').trim();
    const expected = String(s?.expected || '').trim();
    if (!text || !expected) { skipped++; continue; }
    if (existing.has(text.toLowerCase())) { skipped++; continue; }
    entries.unshift({
      id: `kb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: text.slice(0, 1000),
      expected: expected.slice(0, 1000),
      kind: 'example',
      source: 'admin',
      addedByEmail: addedByEmail || '',
      createdAt: Date.now(),
    });
    existing.add(text.toLowerCase());
    added++;
  }
  if (added) await writeKnowledgeEntries(entries.slice(0, 500));
  return { added, skipped };
}

/** Admin: edit an entry's text. Editing an AUTO entry ADOPTS it as admin-owned
 *  so the self-improvement loop won't overwrite the curated wording. */
export async function updateKnowledgeEntry(id: string, patch: { text?: string; expected?: string; template?: string; active?: boolean }): Promise<void> {
  const entries = await readKnowledgeEntries();
  const i = entries.findIndex((e) => e.id === id);
  if (i < 0) throw new Error('Entry not found.');
  const adopt = entries[i].source === 'auto' ? { source: 'admin' as const } : {};
  const textPatch = patch.text !== undefined ? { text: patch.text.trim().slice(0, 1000) } : {};
  // When `expected` is provided, update the worked-example action too.
  const expectedPatch = patch.expected !== undefined ? { expected: patch.expected.trim().slice(0, 1000) } : {};
  const templatePatch = patch.template !== undefined ? { template: String(patch.template) } : {};
  const activePatch = patch.active !== undefined ? { active: !!patch.active } : {};
  entries[i] = { ...entries[i], updatedAt: Date.now(), ...adopt, ...textPatch, ...expectedPatch, ...templatePatch, ...activePatch };
  await writeKnowledgeEntries(entries);
}

/** Admin: delete an entry. Deleting an AUTO entry DISMISSES it (a tombstone) so
 *  the loop won't regenerate it; human entries are removed outright. */
export async function deleteKnowledgeEntry(id: string): Promise<void> {
  const entries = await readKnowledgeEntries();
  const i = entries.findIndex((e) => e.id === id);
  if (i < 0) return;
  if (entries[i].source === 'auto') {
    entries[i] = { ...entries[i], status: 'dismissed', updatedAt: Date.now() };
    await writeKnowledgeEntries(entries);
  } else {
    await writeKnowledgeEntries(entries.filter((e) => e.id !== id));
  }
}

/** A learned-knowledge candidate produced by the self-improvement loop. */
export interface AutoKnowledgeCandidate {
  signature: string;                 // stable fingerprint of the signal
  text: string;                      // human-readable guidance
  meta?: AiKnowledgeEntry['meta'];
}

/**
 * Merge synthesized AUTO knowledge into the store. Refreshes an existing auto
 * entry in place (same signature), respects dismissals, and never touches human
 * or adopted ('admin') entries. Auto entries are capped so they can't crowd out
 * human knowledge. Best-effort caller; throws only if the agent record is
 * missing (so the cron can log it).
 */
export async function upsertAutoKnowledgeEntries(candidates: AutoKnowledgeCandidate[]): Promise<{ added: number; refreshed: number; skipped: number }> {
  const entries = await readKnowledgeEntries();
  const autoBySig = new Map<string, AiKnowledgeEntry>();
  for (const e of entries) if (e.source === 'auto' && e.signature) autoBySig.set(e.signature, e);

  let added = 0, refreshed = 0, skipped = 0;
  const now = Date.now();
  for (const c of candidates) {
    const existing = autoBySig.get(c.signature);
    if (existing) {
      if (existing.status === 'dismissed') { skipped++; continue; } // admin rejected it
      existing.text = c.text.slice(0, 1000);
      existing.meta = c.meta;
      existing.updatedAt = now;
      refreshed++;
    } else {
      entries.unshift({
        id: `auto-${c.signature}`,
        text: c.text.slice(0, 1000),
        addedByEmail: 'ai@resiwalk',
        addedByName: 'AI · auto-learned',
        createdAt: now,
        source: 'auto',
        status: 'active',
        signature: c.signature,
        meta: c.meta,
      });
      added++;
    }
  }

  // Keep every human/adopted entry; cap auto entries (newest kept) so the store
  // stays bounded and human knowledge is never dropped.
  const humans = entries.filter((e) => (e.source || 'inspector') !== 'auto');
  const autos = entries.filter((e) => e.source === 'auto').slice(0, MAX_AUTO_ENTRIES);
  await writeKnowledgeEntries([...autos, ...humans]);
  return { added, refreshed, skipped };
}

/**
 * Compact bullet list of the knowledge entries for injection into the live scan
 * system prompt. Cached ~60s so the high-frequency camera polling doesn't hit
 * HubSpot every tick. Never throws.
 */
export async function getKnowledgeBasePromptText(maxChars = 4000): Promise<string> {
  if (_kbEntriesCache && Date.now() - _kbEntriesCache.at < 60_000) {
    // fallthrough below to format from cache
  } else {
    try {
      const entries = await readKnowledgeEntries();
      _kbEntriesCache = { entries, at: Date.now() };
    } catch {
      _kbEntriesCache = { entries: [], at: Date.now() };
    }
  }
  const entries = (_kbEntriesCache?.entries || []).filter((e) =>
    e.status !== 'dismissed'
    && e.active !== false                                              // On/Off: skip disabled
    && (!e.template || e.template === KB_CONSUMER_TEMPLATE),           // template scope
  );
  if (!entries.length) return '';
  const clean = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();
  // Rules render as bullets; curated examples render as a worked few-shot block.
  // Both flow into the SAME knowledge text injected into every AI.
  const rules = entries.filter((e) => e.kind !== 'example');
  const examples = entries.filter((e) => e.kind === 'example' && clean(e.expected));
  const parts: string[] = [];
  if (rules.length) parts.push(rules.map((e) => `- ${clean(e.text)}`).join('\n'));
  if (examples.length) {
    parts.push(
      'WORKED EXAMPLES — when the inspector says the left, the correct action is on the right. Follow these literally:\n'
      + examples.map((e) => `- "${clean(e.text)}" → ${clean(e.expected)}`).join('\n'),
    );
  }
  return parts.join('\n\n').slice(0, maxChars);
}

// ---------------------------------------------------------------------------
// App admins — the dynamic admin allowlist, stored as JSON on the SAME admin
// Agent record as the AI knowledge base. Granted capabilities: AI Knowledge
// curation, the form builder, and admin management. A small seed list (in
// lib/adminAccess.ts) is always admin so the system can never lock itself out.
// ---------------------------------------------------------------------------
const APP_ADMINS_PROP = 'app_admins_json';

export interface AppAdminRecord {
  email: string;
  addedByEmail?: string;
  addedAt: number;       // epoch ms
}

/** Read the dynamic admin list. Best-effort: [] on any error (caller falls back to seed). */
export async function readAppAdmins(): Promise<AppAdminRecord[]> {
  const recId = await resolveKnowledgeAgentRecordId();
  if (!recId) return [];
  try {
    const resp = await hubspotFetch(`/crm/v3/objects/${agentTypeId()}/${recId}?properties=${APP_ADMINS_PROP}`);
    const raw = resp?.properties?.[APP_ADMINS_PROP];
    if (!raw) return [];
    const parsed = JSON.parse(String(raw));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((a) => a && typeof a.email === 'string')
      .map((a) => ({ email: String(a.email).trim().toLowerCase(), addedByEmail: a.addedByEmail, addedAt: Number(a.addedAt) || Date.now() }));
  } catch (e) {
    console.warn('[app-admins] read failed:', e);
    return [];
  }
}

/** Best-effort: create the app_admins_json property if it's missing (needs the
 *  token to have schema-write scope; otherwise the caller's write surfaces a
 *  clear error and an admin runs scripts/admins/add_admins_property.py). */
async function ensureAppAdminsProperty(): Promise<void> {
  try {
    await hubspotFetch(`/crm/v3/properties/${agentTypeId()}/${APP_ADMINS_PROP}`);
    return; // exists
  } catch { /* fall through to create */ }
  try {
    await hubspotFetch(`/crm/v3/properties/${agentTypeId()}`, {
      method: 'POST',
      body: JSON.stringify({
        name: APP_ADMINS_PROP, label: 'App Admins (JSON)', type: 'string', fieldType: 'textarea',
        groupName: 'ai_knowledge', // group created by the AI-knowledge setup script
        description: 'ResiWalk app admin allowlist (managed by the app).',
      }),
    });
  } catch (e) {
    console.warn('[app-admins] could not auto-create property (run scripts/admins/add_admins_property.py):', String((e as any)?.message || e).slice(0, 160));
  }
}

export async function writeAppAdmins(admins: AppAdminRecord[]): Promise<void> {
  const recId = await resolveKnowledgeAgentRecordId();
  if (!recId) throw new Error('Admin Agent record not found — set AI_KNOWLEDGE_AGENT_RECORD_ID, or ensure the admin (AI_KNOWLEDGE_ADMIN_EMAIL) is a HubSpot owner with an Agent record.');
  const doWrite = () => hubspotFetch(`/crm/v3/objects/${agentTypeId()}/${recId}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties: { [APP_ADMINS_PROP]: JSON.stringify(admins) } }),
  });
  try {
    await doWrite();
  } catch (e: any) {
    if (isMissingPropertyError(e, APP_ADMINS_PROP)) {
      await ensureAppAdminsProperty();
      await doWrite(); // retry once after creating the property
    } else {
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// Insights-Only users — a SEPARATE allowlist (not admins) for the ResiWalk
// Insights analytics portal (/insights). Stored as JSON on the SAME admin Agent
// record as app_admins_json. The gate is canViewInsights = isAppAdmin OR
// isInsightsUser (see lib/insightsAccess), so admins NEVER need to be in this
// list. These users can view dashboards only — no admin capabilities.
// ---------------------------------------------------------------------------
const APP_INSIGHTS_USERS_PROP = 'app_insights_users_json';

export interface InsightsUserRecord {
  email: string;
  addedByEmail?: string;
  addedAt: number;       // epoch ms
}

/** Read the Insights-Only user list. Best-effort: [] on any error. */
export async function readInsightsUsers(): Promise<InsightsUserRecord[]> {
  const recId = await resolveKnowledgeAgentRecordId();
  if (!recId) return [];
  try {
    const resp = await hubspotFetch(`/crm/v3/objects/${agentTypeId()}/${recId}?properties=${APP_INSIGHTS_USERS_PROP}`);
    const raw = resp?.properties?.[APP_INSIGHTS_USERS_PROP];
    if (!raw) return [];
    const parsed = JSON.parse(String(raw));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((a) => a && typeof a.email === 'string')
      .map((a) => ({ email: String(a.email).trim().toLowerCase(), addedByEmail: a.addedByEmail, addedAt: Number(a.addedAt) || Date.now() }));
  } catch (e) {
    console.warn('[insights-users] read failed:', e);
    return [];
  }
}

/** Does this hubspotFetch error indicate the property simply doesn't exist yet?
 *  hubspotFetch sanitizes e.message to "Upstream request failed (400)" and keeps
 *  the real HubSpot body on e.detail — so we MUST inspect e.detail (the old code
 *  only checked e.message, so the auto-create retry never fired and the generic
 *  400 leaked to the UI). */
function isMissingPropertyError(e: any, propName: string): boolean {
  const blob = `${String(e?.message || e)} ${String(e?.detail || '')}`;
  return blob.includes('PROPERTY_DOESNT_EXIST')
    || /property .*does(?:n.t| not) exist/i.test(blob)
    || (e?.status === 400 && blob.includes(propName)); // a 400 naming the property → not provisioned
}

/** Best-effort: create app_insights_users_json if missing (mirrors ensureAppAdminsProperty).
 *  Throws a CLEAR, actionable error if provisioning fails (e.g. the token lacks
 *  CRM schema-write scope) so the admin sees the real blocker, not a generic 400. */
async function ensureInsightsUsersProperty(): Promise<void> {
  try {
    await hubspotFetch(`/crm/v3/properties/${agentTypeId()}/${APP_INSIGHTS_USERS_PROP}`);
    return; // exists
  } catch { /* fall through to create */ }
  try {
    await hubspotFetch(`/crm/v3/properties/${agentTypeId()}`, {
      method: 'POST',
      body: JSON.stringify({
        name: APP_INSIGHTS_USERS_PROP, label: 'Insights-Only Users (JSON)', type: 'string', fieldType: 'textarea',
        groupName: 'ai_knowledge',
        description: 'ResiWalk Insights view-only user allowlist (managed by the app).',
      }),
    });
  } catch (e: any) {
    // 409 = the property already exists (race / created between the GET and POST) → fine.
    const blob = `${String(e?.message || e)} ${String(e?.detail || '')}`;
    if (e?.status === 409 || /already exists|PROPERTY_ALREADY_EXISTS/i.test(blob)) return;
    throw new Error(
      'Insights-Only storage is not provisioned: the property “app_insights_users_json” is missing on the '
      + 'Agent object and auto-create failed. The HubSpot token likely lacks CRM schema-write scope '
      + '(crm.schemas.custom.write). Grant that scope, or create the textarea property manually. '
      + 'Detail: ' + blob.slice(0, 200),
    );
  }
}

export async function writeInsightsUsers(users: InsightsUserRecord[]): Promise<void> {
  const recId = await resolveKnowledgeAgentRecordId();
  if (!recId) throw new Error('Admin Agent record not found — set AI_KNOWLEDGE_AGENT_RECORD_ID, or ensure the admin (AI_KNOWLEDGE_ADMIN_EMAIL) is a HubSpot owner with an Agent record.');
  const doWrite = () => hubspotFetch(`/crm/v3/objects/${agentTypeId()}/${recId}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties: { [APP_INSIGHTS_USERS_PROP]: JSON.stringify(users) } }),
  });
  try {
    await doWrite();
  } catch (e: any) {
    if (isMissingPropertyError(e, APP_INSIGHTS_USERS_PROP)) {
      await ensureInsightsUsersProperty(); // throws a clear error if it can't provision
      await doWrite();                      // retry once after creating the property
    } else {
      // Admin-only route — surface the real HubSpot detail so the blocker is diagnosable.
      const detail = String(e?.detail || '').slice(0, 200);
      throw new Error(`Could not save Insights-Only users (HubSpot ${e?.status || ''}).${detail ? ' ' + detail : ''}`.trim());
    }
  }
}

// ---------------------------------------------------------------------------
// Approval routing config — PODs → Regions (PM/Sr.PM) + RM + Directors, used to
// decide who to @-mention on Slack when a rate-card scope goes to pending
// approval. Stored as one JSON blob on the same admin Agent record.
// ---------------------------------------------------------------------------
const APP_APPROVAL_ROUTING_PROP = 'app_approval_routing_json';

/** Read the approval routing config. Best-effort: a normalized empty config on any error. */
export async function readApprovalRouting(): Promise<ApprovalRoutingConfig> {
  const recId = await resolveKnowledgeAgentRecordId();
  if (!recId) return normalizeApprovalRouting(null);
  try {
    const resp = await hubspotFetch(`/crm/v3/objects/${agentTypeId()}/${recId}?properties=${APP_APPROVAL_ROUTING_PROP}`);
    const raw = resp?.properties?.[APP_APPROVAL_ROUTING_PROP];
    if (!raw) return normalizeApprovalRouting(null);
    return normalizeApprovalRouting(JSON.parse(String(raw)));
  } catch (e) {
    console.warn('[approval-routing] read failed:', e);
    return normalizeApprovalRouting(null);
  }
}

async function ensureApprovalRoutingProperty(): Promise<void> {
  try {
    await hubspotFetch(`/crm/v3/properties/${agentTypeId()}/${APP_APPROVAL_ROUTING_PROP}`);
    return; // exists
  } catch { /* fall through to create */ }
  try {
    await hubspotFetch(`/crm/v3/properties/${agentTypeId()}`, {
      method: 'POST',
      body: JSON.stringify({
        name: APP_APPROVAL_ROUTING_PROP, label: 'Approval routing config (JSON)', type: 'string', fieldType: 'textarea',
        groupName: 'ai_knowledge',
        description: 'ResiWALK approval routing — PODs/Regions/RM/Directors for Slack approval tagging (managed by the app).',
      }),
    });
  } catch (e: any) {
    const blob = `${String(e?.message || e)} ${String(e?.detail || '')}`;
    if (e?.status === 409 || /already exists|PROPERTY_ALREADY_EXISTS/i.test(blob)) return;
    throw new Error(
      'Approval-routing storage is not provisioned: the property “app_approval_routing_json” is missing on the Agent '
      + 'object and auto-create failed — the HubSpot token likely lacks CRM schema-write scope. Detail: ' + blob.slice(0, 200),
    );
  }
}

/** Persist the approval routing config (normalized to the canonical shape). */
export async function writeApprovalRouting(config: ApprovalRoutingConfig): Promise<void> {
  const recId = await resolveKnowledgeAgentRecordId();
  if (!recId) throw new Error('Admin Agent record not found — set AI_KNOWLEDGE_AGENT_RECORD_ID, or ensure the admin is a HubSpot owner with an Agent record.');
  const clean = normalizeApprovalRouting(config);
  const doWrite = () => hubspotFetch(`/crm/v3/objects/${agentTypeId()}/${recId}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties: { [APP_APPROVAL_ROUTING_PROP]: JSON.stringify(clean) } }),
  });
  try {
    await doWrite();
  } catch (e: any) {
    if (isMissingPropertyError(e, APP_APPROVAL_ROUTING_PROP)) {
      await ensureApprovalRoutingProperty();
      await doWrite();
    } else {
      const detail = String(e?.detail || '').slice(0, 200);
      throw new Error(`Could not save approval routing (HubSpot ${e?.status || ''}).${detail ? ' ' + detail : ''}`.trim());
    }
  }
}


// ── Scope-approval Slack notifications (ported from the HubSpot workflows) ──
// Read arbitrary inspection / property properties by id (forgiving projection —
// HubSpot ignores unknown names), used by the scope notification port.
export async function fetchInspectionProperties(inspectionRecordId: string, props: string[]): Promise<Record<string, any>> {
  const { inspection } = typeIds();
  const qs = props.map((p) => `properties=${encodeURIComponent(p)}`).join('&');
  const resp = await hubspotFetch(`/crm/v3/objects/${inspection}/${inspectionRecordId}?${qs}`);
  return resp?.properties || {};
}

/** Write the Slack permalink back onto the inspection (slackmessagelink). */
export async function writeInspectionSlackLink(inspectionRecordId: string, permalink: string): Promise<void> {
  try {
    await updateInspection(inspectionRecordId, { slackmessagelink: permalink });
  } catch (e) {
    console.warn('[scope-slack] writeback to slackmessagelink failed:', e);
  }
}

// ── Slack-notification admin config (on/off + sandbox), JSON on the Agent record ──
const APP_SLACK_NOTIFS_PROP = 'app_slack_notifications_json';
export type SlackNotifConfigMap = Record<string, { enabled?: boolean; sandbox?: boolean; sandboxChannel?: string; channel?: string }>;

export async function readSlackNotifConfig(): Promise<SlackNotifConfigMap> {
  const recId = await resolveKnowledgeAgentRecordId();
  if (!recId) return {};
  try {
    const resp = await hubspotFetch(`/crm/v3/objects/${agentTypeId()}/${recId}?properties=${APP_SLACK_NOTIFS_PROP}`);
    const raw = resp?.properties?.[APP_SLACK_NOTIFS_PROP];
    if (!raw) return {};
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    console.warn('[slack-notif] config read failed:', e);
    return {};
  }
}

async function ensureSlackNotifProperty(): Promise<void> {
  try { await hubspotFetch(`/crm/v3/properties/${agentTypeId()}/${APP_SLACK_NOTIFS_PROP}`); return; } catch { /* create */ }
  try {
    await hubspotFetch(`/crm/v3/properties/${agentTypeId()}`, {
      method: 'POST',
      body: JSON.stringify({
        name: APP_SLACK_NOTIFS_PROP, label: 'Slack Notifications config (JSON)', type: 'string', fieldType: 'textarea',
        groupName: 'ai_knowledge', description: 'Per-notification on/off + sandbox routing for ResiWalk Slack notifications.',
      }),
    });
  } catch (e: any) {
    const blob = `${String(e?.message || e)} ${String(e?.detail || '')}`;
    if (!(e?.status === 409 || /already exists|PROPERTY_ALREADY_EXISTS/i.test(blob))) {
      console.warn('[slack-notif] could not provision app_slack_notifications_json:', blob.slice(0, 200));
    }
  }
}

export async function writeSlackNotifConfig(map: SlackNotifConfigMap): Promise<void> {
  const recId = await resolveKnowledgeAgentRecordId();
  if (!recId) throw new Error('Admin Agent record not found.');
  const doWrite = () => hubspotFetch(`/crm/v3/objects/${agentTypeId()}/${recId}`, {
    method: 'PATCH', body: JSON.stringify({ properties: { [APP_SLACK_NOTIFS_PROP]: JSON.stringify(map || {}) } }),
  });
  try { await doWrite(); }
  catch (e) {
    if (isMissingPropertyError(e, APP_SLACK_NOTIFS_PROP)) { await ensureSlackNotifProperty(); await doWrite(); }
    else { const detail = String((e as any)?.detail || '').slice(0, 200); throw new Error(`Could not save Slack notification config.${detail ? ' ' + detail : ''}`.trim()); }
  }
}

/**
 * One-click provisioning of the HubSpot properties the new admin features need
 * (so an admin can run it from /admin/setup instead of the Python scripts).
 * Idempotent: existing properties are reported as 'exists'. Requires the app's
 * HubSpot token to have schema-write scope; per-property errors are returned
 * (never thrown) so the UI can show exactly what succeeded.
 */
export async function provisionAppProperties(): Promise<Record<string, string>> {
  const results: Record<string, string> = {};
  const agent = agentTypeId();
  const { question, answer, inspection } = typeIds();

  const ensureGroup = async (objType: string, name: string, label: string) => {
    try { await hubspotFetch(`/crm/v3/properties/${objType}/groups`, { method: 'POST', body: JSON.stringify({ name, label }) }); }
    catch { /* already exists or no perm — property create will report the real error */ }
  };
  const ensureProp = async (objType: string, name: string, def: Record<string, any>) => {
    try { await hubspotFetch(`/crm/v3/properties/${objType}/${name}`); results[name] = 'exists'; return; }
    catch { /* missing → create */ }
    try { await hubspotFetch(`/crm/v3/properties/${objType}`, { method: 'POST', body: JSON.stringify(def) }); results[name] = 'created'; }
    catch (e: any) {
      // hubspotFetch sanitizes the thrown message but keeps the real body on .detail.
      const detail = (e?.detail && String(e.detail)) || String(e?.message || e);
      results[name] = 'error: ' + detail.slice(0, 160);
    }
  };

  await ensureGroup(agent, 'ai_knowledge', 'AI');
  await ensureProp(agent, 'app_admins_json', { name: 'app_admins_json', label: 'App Admins (JSON)', type: 'string', fieldType: 'textarea', groupName: 'ai_knowledge' });
  await ensureProp(agent, 'app_templates_json', { name: 'app_templates_json', label: 'App Templates (JSON)', type: 'string', fieldType: 'textarea', groupName: 'ai_knowledge' });
  await ensureGroup(question, 'inspection_question_info', 'Question Info');
  // Boolean properties REQUIRE explicit true/false options, or HubSpot 400s.
  const boolOpts = [
    { label: 'Yes', value: 'true', displayOrder: 0, hidden: false },
    { label: 'No', value: 'false', displayOrder: 1, hidden: false },
  ];
  await ensureProp(question, 'is_enabled', {
    name: 'is_enabled', label: 'Enabled', type: 'bool', fieldType: 'booleancheckbox', groupName: 'inspection_question_info', options: boolOpts,
  });
  await ensureProp(question, 'requires_photo', {
    name: 'requires_photo', label: 'Requires Photo', type: 'bool', fieldType: 'booleancheckbox', groupName: 'inspection_question_info', options: boolOpts,
  });
  await ensureProp(question, 'requires_note', {
    name: 'requires_note', label: 'Requires Note', type: 'bool', fieldType: 'booleancheckbox', groupName: 'inspection_question_info', options: boolOpts,
  });

  // QC failure note on the Answer object (required when a QC line is failed).
  await ensureGroup(answer, 'inspection_answer_info', 'Answer Info');
  await ensureProp(answer, 'qc_failure_note', {
    name: 'qc_failure_note', label: 'QC Failure Note', type: 'string', fieldType: 'textarea', groupName: 'inspection_answer_info',
  });
  // Internal Resolution AFTER photos (proof the in-house work was completed),
  // separate from photo_urls. WITHOUT this property, after-photos silently fail to
  // save (the line save drops them and the durable attach 502s) — the "completion
  // photos aren't saving, only scoping photos" report. Once it exists, the app
  // enables after-photo capture + the finalize requirement.
  await ensureProp(answer, 'after_photo_urls', {
    name: 'after_photo_urls', label: 'After Photo URLs', type: 'string', fieldType: 'textarea', groupName: 'inspection_answer_info',
  });
  // Dependent numeric input (1099 "Evaluate Listing Price" recommended new rent).
  await ensureProp(answer, 'recommended_amount', {
    name: 'recommended_amount', label: 'Recommended Amount', type: 'number', fieldType: 'number', groupName: 'inspection_answer_info',
  });

  // Property status frozen at completion (Inspection object). Stamped at
  // finalize/submit so completed reports keep the historical property status.
  await ensureGroup(inspection, 'inspection_results', 'Inspection Results');
  await ensureProp(inspection, 'property_status_at_completion', {
    name: 'property_status_at_completion', label: 'Property Status at Completion', type: 'string', fieldType: 'text', groupName: 'inspection_results',
  });
  // First / last photo capture time — stamped at submit from the client's capture
  // window; completion time is measured as (last − first) for the Insights metric.
  await ensureProp(inspection, 'first_photo_at', {
    name: 'first_photo_at', label: 'First Photo At', type: 'datetime', fieldType: 'date', groupName: 'inspection_results',
  });
  await ensureProp(inspection, 'last_photo_at', {
    name: 'last_photo_at', label: 'Last Photo At', type: 'datetime', fieldType: 'date', groupName: 'inspection_results',
  });
  // Reference coordinates stamped at creation so the calendar map plots the pin
  // without a live geocode (falls back to client geocoding when absent).
  await ensureProp(inspection, 'latitude', {
    name: 'latitude', label: 'Latitude', type: 'number', fieldType: 'number', groupName: 'inspection_results',
  });
  await ensureProp(inspection, 'longitude', {
    name: 'longitude', label: 'Longitude', type: 'number', fieldType: 'number', groupName: 'inspection_results',
  });
  // Sortable property-status snapshot (seeded at create, kept fresh by the home
  // list enrichment, frozen at completion). Powers the "Property Status" sort.
  await ensureProp(inspection, 'property_status_snapshot', {
    name: 'property_status_snapshot', label: 'Property Status (Snapshot)', type: 'string', fieldType: 'text', groupName: 'inspection_results',
  });
  // Listing snapshot frozen at completion — the listing status/price/listed date,
  // Move-in Ready date, and lease-start (move-in) as they were at the time of
  // inspection. Stored as JSON so completed reports/headers don't drift when the
  // live listing changes later. Long text (a small JSON object).
  await ensureProp(inspection, 'listing_snapshot_json', {
    name: 'listing_snapshot_json', label: 'Listing Snapshot (JSON)', type: 'string', fieldType: 'textarea', groupName: 'inspection_results',
  });
  // QC Turn Re-Inspect: the overall failure comment (why the re-inspect failed),
  // stamped at qc-finalize so completed QCs can show it in-app (and the PDF
  // regenerator can reproduce it).
  await ensureProp(inspection, 'qc_overall_note', {
    name: 'qc_overall_note', label: 'QC Overall Failure Comment', type: 'string', fieldType: 'textarea', groupName: 'inspection_results',
  });
  // Per-inspection gate so re-submitting a 1099 never re-creates its utilities/
  // trash compliance tickets (also auto-provisioned at first write).
  await ensureProp(inspection, 'compliance_tickets_created_at', {
    name: 'compliance_tickets_created_at', label: 'Compliance Tickets Created At', type: 'datetime', fieldType: 'date', groupName: 'inspection_results',
  });
  // HBMM ticket ids created at Scope finalize — stored for visibility, idempotency
  // (no double-create on retry/re-finalize), and background document-upload
  // retries. Up to three per Scope: Turnkey, Evictions, CapEx.
  await ensureProp(inspection, 'hbmm_ticket_id', {
    name: 'hbmm_ticket_id', label: 'HBMM Maintenance Ticket ID', type: 'string', fieldType: 'text', groupName: 'inspection_results',
  });
  await ensureProp(inspection, 'hbmm_eviction_ticket_id', {
    name: 'hbmm_eviction_ticket_id', label: 'HBMM Eviction Ticket ID', type: 'string', fieldType: 'text', groupName: 'inspection_results',
  });
  await ensureProp(inspection, 'hbmm_capex_ticket_id', {
    name: 'hbmm_capex_ticket_id', label: 'HBMM CapEx Ticket ID', type: 'string', fieldType: 'text', groupName: 'inspection_results',
  });

  // 1099 Leasing Agent report fields — stamped onto the inspection at completion
  // from the inspector's answers, for downstream reporting.
  await ensureGroup(inspection, 'inspection_1099', '1099 Leasing Agent');
  await ensureProp(inspection, 'listing_price_response_1099', {
    name: 'listing_price_response_1099', label: '1099 Listing Price Response', type: 'string', fieldType: 'text', groupName: 'inspection_1099',
  });
  await ensureProp(inspection, 'listing_price_recommendation_1099', {
    name: 'listing_price_recommendation_1099', label: '1099 Listing Price Recommendation', type: 'number', fieldType: 'number', groupName: 'inspection_1099',
  });
  await ensureProp(inspection, 'listing_price_feedback_1099', {
    name: 'listing_price_feedback_1099', label: '1099 Listing Price Feedback', type: 'string', fieldType: 'textarea', groupName: 'inspection_1099',
  });
  // Gate: set once the listing-price (Reduce/Increase) Slack alert has posted.
  await ensureProp(inspection, 'listing_price_alert_at', {
    name: 'listing_price_alert_at', label: 'Listing Price Alert Posted At', type: 'datetime', fieldType: 'date', groupName: 'inspection_1099',
  });
  await ensureProp(inspection, 'landscaping_response_1099', {
    name: 'landscaping_response_1099', label: '1099 Landscaping Response', type: 'string', fieldType: 'text', groupName: 'inspection_1099',
  });
  await ensureProp(inspection, 'landscaping_feedback_1099', {
    name: 'landscaping_feedback_1099', label: '1099 Landscaping Feedback', type: 'string', fieldType: 'textarea', groupName: 'inspection_1099',
  });

  // Utilities (from the Final Checklist) — the selected answer is stamped onto
  // the inspection at completion for reporting. Values: On / Off / N/A (or
  // Present / Missing / N/A for Trash Bins).
  await ensureGroup(inspection, 'inspection_utilities', 'Utilities');
  await ensureProp(inspection, 'electric', {
    name: 'electric', label: 'Electric', type: 'string', fieldType: 'text', groupName: 'inspection_utilities',
  });
  await ensureProp(inspection, 'water', {
    name: 'water', label: 'Water', type: 'string', fieldType: 'text', groupName: 'inspection_utilities',
  });
  await ensureProp(inspection, 'gas', {
    name: 'gas', label: 'Gas', type: 'string', fieldType: 'text', groupName: 'inspection_utilities',
  });
  await ensureProp(inspection, 'trash_bins', {
    name: 'trash_bins', label: 'Trash Bins', type: 'string', fieldType: 'text', groupName: 'inspection_utilities',
  });
  // Pool Condition (Final Checklist, conditional on the property's pool_fee > 0):
  // Pass/Fail, plus the required feedback note on Fail. Stamped at completion.
  await ensureProp(inspection, 'pool_condition', {
    name: 'pool_condition', label: 'Pool Condition', type: 'string', fieldType: 'text', groupName: 'inspection_utilities',
  });
  await ensureProp(inspection, 'pool_feedback', {
    name: 'pool_feedback', label: 'Pool Feedback', type: 'string', fieldType: 'textarea', groupName: 'inspection_utilities',
  });
  // Pool photo(s) from the Final Checklist (required on Fail). Stamped as a
  // newline-joined list of HubSpot file URLs so they're accessible directly on
  // the inspection record (the originals also live in the fc__all blob).
  await ensureProp(inspection, 'pool_photo_urls', {
    name: 'pool_photo_urls', label: 'Pool Photo URLs', type: 'string', fieldType: 'textarea', groupName: 'inspection_utilities',
  });

  // Smart Home Tech (from the Final Checklist) — stamped onto the inspection at
  // completion: Device Installed = the "Did you install a new lock/hub?" answer
  // (Yes/No); Serial Number = the device serial (Bluetooth Lock always; Smart
  // Home Hub only when a new hub was installed).
  await ensureGroup(inspection, 'inspection_smart_home', 'Smart Home Tech');
  await ensureProp(inspection, 'device_type', {
    name: 'device_type', label: 'Device Type', type: 'string', fieldType: 'text', groupName: 'inspection_smart_home',
  });
  await ensureProp(inspection, 'device_installed', {
    name: 'device_installed', label: 'Device Installed', type: 'string', fieldType: 'text', groupName: 'inspection_smart_home',
  });
  await ensureProp(inspection, 'serial_number', {
    name: 'serial_number', label: 'Serial Number', type: 'string', fieldType: 'text', groupName: 'inspection_smart_home',
  });

  // Drop the "does this property exist?" cache so the just-provisioned fields
  // (incl. after_photo_urls, now checked via answerHasProperty) are picked up by
  // this warm instance without waiting for a cold start.
  _answerPropCache.clear();

  return results;
}

// ---------------------------------------------------------------------------
// Custom inspection templates — admin-created question-driven templates, stored
// as JSON on the same admin Agent record. They appear in the form builder and
// the New-Inspection picker. (Built-in templates stay in code; Scope/QC are
// never custom.) See lib/formTemplates + the form builder.
// ---------------------------------------------------------------------------
const APP_TEMPLATES_PROP = 'app_templates_json';

export interface AppTemplateRecord {
  id: string;            // e.g. 'custom_move_out_walkthrough'
  label: string;
  createdByEmail?: string;
  createdAt: number;
}

export async function readAppTemplates(): Promise<AppTemplateRecord[]> {
  const recId = await resolveKnowledgeAgentRecordId();
  if (!recId) return [];
  try {
    const resp = await hubspotFetch(`/crm/v3/objects/${agentTypeId()}/${recId}?properties=${APP_TEMPLATES_PROP}`);
    const raw = resp?.properties?.[APP_TEMPLATES_PROP];
    if (!raw) return [];
    const parsed = JSON.parse(String(raw));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t) => t && typeof t.id === 'string' && typeof t.label === 'string')
      .map((t) => ({ id: String(t.id), label: String(t.label), createdByEmail: t.createdByEmail, createdAt: Number(t.createdAt) || Date.now() }));
  } catch (e) {
    console.warn('[app-templates] read failed:', e);
    return [];
  }
}

async function ensureAppTemplatesProperty(): Promise<void> {
  try { await hubspotFetch(`/crm/v3/properties/${agentTypeId()}/${APP_TEMPLATES_PROP}`); return; } catch { /* create */ }
  try {
    await hubspotFetch(`/crm/v3/properties/${agentTypeId()}`, {
      method: 'POST',
      body: JSON.stringify({ name: APP_TEMPLATES_PROP, label: 'App Templates (JSON)', type: 'string', fieldType: 'textarea', groupName: 'ai_knowledge', description: 'Admin-created inspection templates (managed by the app).' }),
    });
  } catch (e) {
    console.warn('[app-templates] could not auto-create property (run scripts/forms/add_template_props.py):', String((e as any)?.message || e).slice(0, 160));
  }
}

export async function writeAppTemplates(templates: AppTemplateRecord[]): Promise<void> {
  const recId = await resolveKnowledgeAgentRecordId();
  if (!recId) throw new Error('Admin Agent record not found — set AI_KNOWLEDGE_AGENT_RECORD_ID.');
  const doWrite = () => hubspotFetch(`/crm/v3/objects/${agentTypeId()}/${recId}`, {
    method: 'PATCH', body: JSON.stringify({ properties: { [APP_TEMPLATES_PROP]: JSON.stringify(templates) } }),
  });
  try {
    await doWrite();
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (msg.includes('PROPERTY_DOESNT_EXIST') || (msg.includes('Property') && msg.includes('does not exist'))) {
      await ensureAppTemplatesProperty();
      await doWrite();
    } else { throw e; }
  }
}

// ---------------------------------------------------------------------------
// SFTP watch queue — a small singleton JSON array (on the same admin Agent
// record as the AI knowledge base) of in-flight Tenant Chargeback uploads the
// background cron is watching for a processed/errored result. Low volume: only
// entries inside their ~10-minute window live here.
// ---------------------------------------------------------------------------
const SFTP_WATCH_PROP = 'sftp_watch_queue_json';

export async function readSftpWatchQueue<T = any>(): Promise<T[]> {
  const recId = await resolveKnowledgeAgentRecordId();
  if (!recId) return [];
  try {
    const resp = await hubspotFetch(`/crm/v3/objects/${agentTypeId()}/${recId}?properties=${SFTP_WATCH_PROP}`);
    const raw = resp?.properties?.[SFTP_WATCH_PROP];
    if (!raw) return [];
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch (e) {
    console.warn('[sftp-watch] queue read failed:', e);
    return [];
  }
}

export async function writeSftpWatchQueue(items: any[]): Promise<void> {
  const recId = await resolveKnowledgeAgentRecordId();
  if (!recId) throw new Error('SFTP watch queue store not found — set AI_KNOWLEDGE_AGENT_RECORD_ID or ensure the admin owner has an Agent record.');
  await hubspotFetch(`/crm/v3/objects/${agentTypeId()}/${recId}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties: { [SFTP_WATCH_PROP]: JSON.stringify(items) } }),
  });
}

/** Default client invoice when the agent has no client cost. */
const DEFAULT_CLIENT_INVOICE = '60';
/** Default vendor invoice ("vendor cost") when no agent value matches. Must ALWAYS
 *  resolve to a number so the inspection's vendor cost is never null/blank on
 *  completion. Keyed off the inspector: a 1099 (external) inspector floors at $50
 *  even with no matched agent record; internal staff floor at $0. A matched
 *  Agent's configured vendor cost still overrides either default. */
const VENDOR_INVOICE_DEFAULT_EXTERNAL = '50';
const VENDOR_INVOICE_DEFAULT_INTERNAL = '0';

/**
 * Copy billing fields onto an inspection from the Property + matched Agent.
 * Best-effort; returns which fields were written (for backfill reporting).
 */
export async function populateBillingFields(inspectionRecordId: string): Promise<{ ok: boolean; updated: string[]; note?: string }> {
  const { property: propType } = typeIds();
  const insp = await readInspectionProps(inspectionRecordId, [
    'inspector_email', 'inspector_name', 'property_id_ref', 'hubspot_owner_id',
  ]);
  if (!insp) return { ok: false, updated: [], note: 'inspection not found' };

  const propertyId = (insp.property_id_ref || '').toString().trim();
  const inspectorEmail = (insp.inspector_email || '').toString().trim();
  const update: Record<string, any> = {};

  // Property → entity_id, full_address
  if (propertyId) {
    try {
      const pr = await hubspotFetch(`/crm/v3/objects/${propType}/${propertyId}?properties=entity_id&properties=full_address`);
      const pp = pr.properties || {};
      if (pp.entity_id != null && pp.entity_id !== '') update.entity_id = String(pp.entity_id);
      if (pp.full_address != null && pp.full_address !== '') update.full_address = String(pp.full_address);
    } catch (e) {
      console.warn('[billing] property read failed:', e);
    }
  }

  // Invoice amounts always default to a NUMBER so they're never null/blank on the
  // inspection — the matched agent's values override when present. Client → $60;
  // vendor ("vendor cost") → $50 for a 1099 (external) inspector, $0 for internal
  // staff. A matched agent's configured vendor cost still overrides this default.
  const defaultVendorInvoice = isExternalEmail(inspectorEmail)
    ? VENDOR_INVOICE_DEFAULT_EXTERNAL : VENDOR_INVOICE_DEFAULT_INTERNAL;
  update.client_invoice_amount = DEFAULT_CLIENT_INVOICE;
  update.vendor_invoice_amount = defaultVendorInvoice;

  // Owner → Agent → broker_code + invoice amounts
  let ownerId = (insp.hubspot_owner_id || '').toString().trim();
  if (!ownerId && inspectorEmail) ownerId = (await resolveOwnerIdByEmail(inspectorEmail)) || '';
  if (ownerId) {
    update.hubspot_owner_id = ownerId;
    const agent = await fetchAgentBillingByOwner(ownerId);
    if (agent) {
      update.broker_code = agent.brokerCode || '';
      // Keep the agent's configured vendor/client cost when set; otherwise fall
      // back to the numeric defaults above (NEVER blank → never null).
      update.vendor_invoice_amount = agent.vendorCost !== '' ? agent.vendorCost : defaultVendorInvoice;
      update.client_invoice_amount = agent.clientCost !== '' ? agent.clientCost : DEFAULT_CLIENT_INVOICE;
    }
  }

  if (Object.keys(update).length === 0) return { ok: true, updated: [], note: 'no source data found' };
  try {
    await updateInspection(inspectionRecordId, update);
    return { ok: true, updated: Object.keys(update) };
  } catch (e: any) {
    console.warn('[billing] update failed (run scripts/billing_fields to create the properties):', e);
    return { ok: false, updated: [], note: String(e?.message || e).slice(0, 200) };
  }
}

/**
 * Stamp `first_completed_date` (datetime) the FIRST time an inspection completes.
 * Idempotent: leaves an existing value untouched so re-finalize/edits don't
 * overwrite the original completion timestamp. Best-effort.
 */
export async function stampFirstCompleted(inspectionRecordId: string, when: string): Promise<void> {
  try {
    const cur = await readInspectionProps(inspectionRecordId, ['first_completed_date']);
    const existing = (cur?.first_completed_date || '').toString().trim();
    if (existing) return;
    // first_completed_date is a HubSpot datetime → write epoch-ms (ISO strings
    // render as "Invalid date"). Accept either an ISO string or an epoch-ms
    // string as input (e.g. completed_at from the backfill).
    const s = String(when || '').trim();
    const ms = /^\d+$/.test(s) ? Number(s) : new Date(s).getTime();
    if (!Number.isFinite(ms) || ms <= 0) return;
    await updateInspection(inspectionRecordId, { first_completed_date: ms });
  } catch (e) {
    console.warn('[billing] stampFirstCompleted skipped (create the property to enable):', e);
  }
}

/**
 * Freeze the property's CURRENT lifecycle status onto the inspection as
 * `property_status_at_completion`. Called when an inspection reaches a terminal
 * completed state (question-form submit, scope finalize, QC finalize). After
 * this, the header and home card show this frozen value instead of the live
 * property status — so a completed report reflects the status as it was at
 * completion, even if the property's status changes later. While the inspection
 * is still scheduled / in progress / pending approval this is never set, so the
 * UI keeps showing the live property status.
 *
 * Best-effort: never throws. A missing property, an empty status, or a
 * not-yet-created field must not block the completion write that called us.
 */
/**
 * Lean read of a Property's current lifecycle status (the `status` field used by
 * the picker / inspection header). Returns null when unset or on any error
 * (best-effort). Used to stamp the sortable snapshot at inspection create.
 */
export async function fetchPropertyStatus(propertyRecordId: string): Promise<string | null> {
  const id = (propertyRecordId || '').toString().trim();
  if (!id) return null;
  try {
    const { property: propertyTypeId } = typeIds();
    const resp = await hubspotFetch(
      `/crm/v3/objects/${propertyTypeId}/${id}?properties=${encodeURIComponent(PROPERTY_STATUS_PROPERTY)}`,
    );
    return (resp.properties?.[PROPERTY_STATUS_PROPERTY] || '').toString().trim() || null;
  } catch {
    return null;
  }
}

export async function stampPropertyStatusAtCompletion(inspectionRecordId: string): Promise<void> {
  try {
    const { inspection: typeId, property: propertyTypeId } = typeIds();
    const insResp = await hubspotFetch(
      `/crm/v3/objects/${typeId}/${inspectionRecordId}?properties=${encodeURIComponent('property_id_ref')}`,
    );
    const propertyIdRef = (insResp.properties?.property_id_ref || '').toString().trim();
    if (!propertyIdRef) return;
    const propResp = await hubspotFetch(
      `/crm/v3/objects/${propertyTypeId}/${propertyIdRef}?properties=${encodeURIComponent(PROPERTY_STATUS_PROPERTY)}`,
    );
    const status = (propResp.properties?.[PROPERTY_STATUS_PROPERTY] || '').toString().trim();
    if (!status) return;
    // Freeze the historical value AND set the sortable snapshot to match, so a
    // completed inspection sorts by the status it had at completion (and the
    // live-refresh in enrichPropertyStatuses skips completed rows).
    await updateInspection(inspectionRecordId, {
      property_status_at_completion: status,
      property_status_snapshot: status,
    });
  } catch (e) {
    console.warn('[stampPropertyStatusAtCompletion] skipped (create the property to enable):', String(e).slice(0, 200));
  }
}

// ── New Construction RRQC → Property object stamp ───────────────────────────
// When a New Construction RRQC inspection is submitted, push its overall Pass/
// Fail verdict to the associated Property's `rrqc_result`, and on a PASS stamp
// `rrqc_pass_date` (date-only) with the submission date. On a FAIL the pass date
// is cleared/left blank. Best-effort — never blocks the submit.

// Today's date in America/New_York as YYYY-MM-DD (en-CA yields that order), then
// midnight-UTC epoch ms — the canonical HubSpot write for a date property, and it
// displays as MM/DD/YYYY of that ET calendar date without timezone drift.
function easternDateMidnightUtcMs(): number {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return Date.parse(`${ymd}T00:00:00Z`);
}

// Map our internal 'pass'|'fail' to the Property `rrqc_result` field's ACTUAL
// stored value. If the field is an enumeration we match its options by value or
// label (case-insensitive) so we write exactly what HubSpot expects regardless of
// whether it's "Pass"/"Fail", "pass"/"fail", "Passed"/"Failed", etc. Falls back to
// title-case for a free-text field.
async function resolveRrqcResultValue(propertyTypeId: string, result: 'pass' | 'fail'): Promise<string> {
  const fallback = result === 'pass' ? 'Pass' : 'Fail';
  try {
    const def = await hubspotFetch(`/crm/v3/properties/${propertyTypeId}/rrqc_result`);
    const opts: Array<{ label?: string; value?: string }> = Array.isArray(def?.options) ? def.options : [];
    if (!opts.length) return fallback;   // not an enumeration → free text
    const eq = (s: any) => String(s || '').trim().toLowerCase();
    const exact = opts.find((o) => eq(o.value) === result || eq(o.label) === result);
    if (exact?.value != null) return String(exact.value);
    const partial = opts.find((o) => eq(o.value).includes(result) || eq(o.label).includes(result));
    if (partial?.value != null) return String(partial.value);
    return fallback;
  } catch {
    return fallback;   // property missing / not readable → best-effort default
  }
}

export async function stampRrqcResultOnProperty(
  inspectionRecordId: string,
  result: 'pass' | 'fail',
  propertyRecordIdHint?: string | null,
): Promise<void> {
  try {
    const { inspection: typeId, property: propertyTypeId } = typeIds();
    let propId = (propertyRecordIdHint || '').toString().trim();
    if (!propId) {
      const insResp = await hubspotFetch(`/crm/v3/objects/${typeId}/${inspectionRecordId}?properties=${encodeURIComponent('property_id_ref')}`);
      propId = (insResp.properties?.property_id_ref || '').toString().trim();
    }
    if (!propId) { console.warn('[rrqc] inspection has no linked property — skipping property stamp'); return; }

    const rrqcValue = await resolveRrqcResultValue(propertyTypeId, result);
    const props: Record<string, any> = { rrqc_result: rrqcValue };
    // PASS → stamp the pass date; FAIL → leave it blank (clear any prior value).
    props.rrqc_pass_date = result === 'pass' ? easternDateMidnightUtcMs() : '';

    await hubspotFetch(`/crm/v3/objects/${propertyTypeId}/${propId}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties: props }),
    });
    console.log(`[rrqc] property ${propId}: rrqc_result="${rrqcValue}"${result === 'pass' ? `, rrqc_pass_date stamped` : ', rrqc_pass_date cleared'}`);
  } catch (e: any) {
    console.warn('[rrqc] could not stamp property rrqc_result/rrqc_pass_date (best-effort):', `${String(e?.message || e)} ${String(e?.detail || '')}`.slice(0, 240));
  }
}

// ── ResiWalk Services vendors: the HubSpot Companies object ─────────────────
// A vendor is an approved company: `resiwalk_access` = Yes AND
// `eligible_for_recurring` = Yes. `name` is the vendor's display name, `email`
// is the notification address, `resiwalk_password` holds a salted scrypt hash
// (never plaintext) set on first login. This is the live source for the vendor
// pickers, service scoping, notifications, and the vendor password login.
export interface VendorCompany { id: string; name: string; email: string; passwordHash: string; hasPassword: boolean }

let _vendorCompanies: { at: number; list: VendorCompany[] } | null = null;
// Accept common encodings of a "Yes" gate: boolean ('true'), single-select/
// checkbox ('Yes'). The IN filter is broad; a client-side re-check tightens it.
const VENDOR_APPROVED_VALUES = ['true', 'True', 'TRUE', 'Yes', 'yes', 'YES', '1'];
const vendorTruthy = (v: any) => ['true', 'yes', '1'].includes(String(v ?? '').trim().toLowerCase());

/** Approved vendor companies (both flags = Yes), with name + notification email
 *  + password hash. Cached ~5 min; serves stale on a fetch error. */
export async function fetchApprovedVendorCompanies(force = false): Promise<VendorCompany[]> {
  if (!force && _vendorCompanies && Date.now() - _vendorCompanies.at < 5 * 60 * 1000) return _vendorCompanies.list;
  const out: VendorCompany[] = [];
  // resiwalk_password is OPTIONAL — it may not exist yet if no vendor has set a
  // password. If HubSpot 400s because that property doesn't exist, drop it and
  // retry so the whole vendor list isn't wiped out by a missing optional field.
  let hasPasswordProp = true;
  let properties = ['name', 'email', 'resiwalk_access', 'eligible_for_recurring', 'resiwalk_password'];
  const runPage = (after?: string) => hubspotFetch(`/crm/v3/objects/companies/search`, {
    method: 'POST',
    body: JSON.stringify({
      limit: 100, after, properties,
      filterGroups: [{ filters: [
        { propertyName: 'resiwalk_access', operator: 'IN', values: VENDOR_APPROVED_VALUES },
        { propertyName: 'eligible_for_recurring', operator: 'IN', values: VENDOR_APPROVED_VALUES },
      ] }],
    }),
  });
  let after: string | undefined;
  try {
    do {
      let resp;
      try {
        resp = await runPage(after);
      } catch (e: any) {
        if (hasPasswordProp && isMissingPropertyError(e, 'resiwalk_password')) {
          // Property not provisioned yet → treat everyone as no-password-set.
          hasPasswordProp = false;
          properties = properties.filter((p) => p !== 'resiwalk_password');
          resp = await runPage(after);
        } else {
          throw e; // a missing flag/email/name property is fatal — surface it
        }
      }
      for (const r of resp.results || []) {
        const p = r.properties || {};
        if (!vendorTruthy(p.resiwalk_access) || !vendorTruthy(p.eligible_for_recurring)) continue; // defensive re-check
        const email = String(p.email || '').trim();
        const name = String(p.name || '').trim();
        if (!email || !name) continue; // need both to assign + notify + log in
        out.push({ id: String(r.id), name, email, passwordHash: String(p.resiwalk_password || ''), hasPassword: isVendorPasswordSet(p.resiwalk_password) });
      }
      after = resp.paging?.next?.after || undefined;
    } while (after);
  } catch (e: any) {
    console.warn('[vendor-companies] fetch failed (check the resiwalk_access / eligible_for_recurring / email properties exist on Companies):', `${String(e?.message || e)} ${String(e?.detail || '')}`.slice(0, 240));
    if (_vendorCompanies) return _vendorCompanies.list; // serve stale rather than empty
    return [];
  }
  _vendorCompanies = { at: Date.now(), list: out };
  return out;
}

/** The approved vendor whose notification `email` matches (case-insensitive), or null. */
export async function findApprovedVendorByEmail(email: string | null | undefined): Promise<VendorCompany | null> {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  const list = await fetchApprovedVendorCompanies();
  return list.find((v) => v.email.trim().toLowerCase() === e) || null;
}

/** Store the vendor's password hash on the company object; busts the cache. */
export async function setVendorPasswordHash(companyId: string, hash: string): Promise<void> {
  await hubspotFetch(`/crm/v3/objects/companies/${companyId}`, {
    method: 'PATCH', body: JSON.stringify({ properties: { resiwalk_password: hash } }),
  });
  _vendorCompanies = null; // reflect hasPassword immediately
}

/**
 * Freeze the listing snapshot (status / price / listed date / Move-in Ready /
 * lease-start move-in) onto the inspection at completion, mirroring
 * stampPropertyStatusAtCompletion. After this, the header + report PDFs show
 * these frozen values (via parseListingSnapshot) instead of the live listing, so
 * a completed inspection reflects the listing as it was at the time of
 * inspection even if the listing changes later. Best-effort: never throws.
 */
export async function stampListingSnapshotAtCompletion(inspectionRecordId: string): Promise<void> {
  try {
    const { inspection: typeId, property: propType } = typeIds();
    const insResp = await hubspotFetch(
      `/crm/v3/objects/${typeId}/${inspectionRecordId}?properties=${encodeURIComponent('property_id_ref')}`,
    );
    const propertyIdRef = (insResp.properties?.property_id_ref || '').toString().trim();
    if (!propertyIdRef) return;
    const listing = await fetchActiveListingForProperty(propertyIdRef);
    // Property marks (pest-control enrollment + last-tenant pet count) frozen
    // alongside the listing — these can change later, so capture them as-of the
    // inspection. Best-effort.
    let pestControlEnrolled = false;
    let tenantHasPet = false;
    try {
      const pr = await hubspotFetch(`/crm/v3/objects/${propType}/${propertyIdRef}?properties=pest_control_enrolled&properties=last_tenant_pet_count`);
      const pp = pr.properties || {};
      pestControlEnrolled = /^y/i.test((pp.pest_control_enrolled || '').toString().trim());
      const petN = Number((pp.last_tenant_pet_count ?? '').toString().trim());
      tenantHasPet = Number.isFinite(petN) && petN >= 1;
    } catch { /* best-effort */ }
    await updateInspection(inspectionRecordId, {
      listing_snapshot_json: JSON.stringify({
        listingStatus: listing?.listingStatus ?? null,
        listingPrice: listing?.listingPrice ?? null,
        listingDate: listing?.listingDate ?? null,
        moveInReadyDate: listing?.moveInReadyDate ?? null,
        moveInDate: listing?.moveInDate ?? null,
        pestControlEnrolled,
        tenantHasPet,
      }),
    });
  } catch (e) {
    console.warn('[stampListingSnapshotAtCompletion] skipped (create the property to enable):', String(e).slice(0, 200));
  }
}

/**
 * Backfill billing fields across existing inspections. Paginated + resumable:
 * processes up to `max` records starting from `after`, and returns `nextAfter`
 * (null when done) so callers can loop. For each record it (re)runs
 * populateBillingFields and stamps first_completed_date from completed_at when
 * it's missing. Idempotent — safe to re-run.
 */
export async function backfillBillingFields(opts: { after?: string; max?: number } = {}): Promise<{ processed: number; updated: number; errors: number; nextAfter: string | null }> {
  const { inspection: typeId } = typeIds();
  const max = opts.max ?? 300;
  let after = opts.after;
  let processed = 0, updated = 0, errors = 0;

  while (processed < max) {
    const body: any = { filterGroups: [], properties: ['completed_at', 'first_completed_date'], limit: 100 };
    if (after) body.after = after;
    const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search?archived=false`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const results = resp.results || [];
    for (const r of results) {
      processed++;
      try {
        const bf = await populateBillingFields(r.id);
        if (bf.ok && bf.updated.length) updated++;
        const p = r.properties || {};
        const completed = (p.completed_at || '').toString().trim();
        const first = (p.first_completed_date || '').toString().trim();
        if (completed && !first) await stampFirstCompleted(r.id, completed);
      } catch (e) {
        errors++;
        console.warn(`[billing-backfill] record ${r.id} failed:`, e);
      }
      await new Promise((res) => setTimeout(res, 120)); // polite to the API
    }
    after = resp.paging?.next?.after;
    if (!after) return { processed, updated, errors, nextAfter: null };
    if (processed >= max) return { processed, updated, errors, nextAfter: after };
  }
  return { processed, updated, errors, nextAfter: after || null };
}


/**
 * Backfill `resiwalk_inspection_url` on existing inspections (the live deep link
 * `<origin>/inspection/<recordId>`). Idempotent — skips records already set to
 * the same URL. Paginated like backfillBillingFields: processes up to `max`
 * records from the optional `after` cursor and returns `nextAfter` (null = done).
 */
export async function backfillInspectionUrls(opts: { after?: string; max?: number; origin: string }): Promise<{ processed: number; updated: number; skipped: number; errors: number; nextAfter: string | null }> {
  const { inspection: typeId } = typeIds();
  const max = opts.max ?? 1000;
  const origin = opts.origin.replace(/\/+$/, '');
  let after = opts.after;
  let processed = 0, updated = 0, skipped = 0, errors = 0;

  while (processed < max) {
    const body: any = { filterGroups: [], properties: ['resiwalk_inspection_url'], limit: 100 };
    if (after) body.after = after;
    const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search?archived=false`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const results = resp.results || [];
    for (const r of results) {
      processed++;
      try {
        const want = `${origin}/inspection/${r.id}`;
        const existing = (r.properties?.resiwalk_inspection_url || '').toString().trim();
        if (existing === want) { skipped++; continue; }
        await updateInspection(r.id, { resiwalk_inspection_url: want });
        updated++;
      } catch (e) {
        errors++;
        console.warn(`[inspection-url-backfill] record ${r.id} failed:`, e);
      }
      await new Promise((res) => setTimeout(res, 90)); // polite to the API
    }
    after = resp.paging?.next?.after;
    if (!after) return { processed, updated, skipped, errors, nextAfter: null };
    if (processed >= max) return { processed, updated, skipped, errors, nextAfter: after };
  }
  return { processed, updated, skipped, errors, nextAfter: after || null };
}

/**
 * Recompute the inspection-wide cost totals from its rate-card lines and write
 * them to `total_vendor_cost` / `total_client_cost` / `total_tenant_cost` on the
 * inspection, so the inspection object (and the home card / price sort that read
 * these rollups) always reflects the current scope — through editing, approval,
 * and finalize. Best-effort on the write (tolerates the properties not existing
 * yet); never throws. Returns the totals + line count.
 *
 * Pricing source:
 *  - When `catalog` + `regions` are supplied, each line is RE-PRICED LIVE with
 *    the same `calculateLine` the form uses (against the inspection's region),
 *    so the rollup matches exactly what the inspector sees — even for older
 *    lines whose stored cost snapshots are stale. This is the correct path and
 *    is what the save flow + backfill pass.
 *  - Otherwise it falls back to summing each line's STORED cost snapshot
 *    (legacy behavior) — fine right after a save (snapshots are fresh) but can
 *    drift from the form for lines saved under different/old pricing.
 *
 * `skipIfNoLines` avoids stamping 0 onto non-scope inspections during a backfill
 * (the live save path leaves it false so deleting the last line writes 0).
 */
export async function recomputeInspectionTotals(
  inspectionId: string,
  opts: {
    skipIfNoLines?: boolean;
    catalog?: RateCardLineItem[];
    regions?: RegionRate[];
    region?: string; // inspection region; fetched from the record if omitted
  } = {},
): Promise<{ vendor: number; client: number; tenant: number; lineCount: number; wrote: boolean }> {
  // Use the SAME rounding as every per-line stored value and every billing
  // document (rate-card-lines save, chargeback PDF/XLSX, vendor/master PDFs all
  // use roundMoney). A local EPSILON-nudged round2 here rounded exactly-half
  // values UP where roundMoney rounds down, so the stored/headline rollup could
  // read a cent-per-line HIGHER than the amount actually billed.
  const round2 = roundMoney;
  const answers = await fetchAnswersForInspection(inspectionId);
  const lineAnswers = answers.filter((a) => a.answerType === 'rate_card_line' && a.rateCardLine);

  // Live re-pricing when a catalog + region matrix are provided.
  const live = !!(opts.catalog && opts.regions);
  const catalogByCode = live ? new Map(opts.catalog!.map((c) => [c.lineItemCode, c])) : null;
  let region = opts.region;
  if (live && region == null) {
    try { region = (await fetchInspectionById(inspectionId))?.regionSnapshot || ''; }
    catch { region = ''; }
  }

  let vendor = 0, client = 0, tenant = 0, lineCount = 0;
  for (const a of lineAnswers) {
    const rc = a.rateCardLine!;
    lineCount++;
    const item = live ? catalogByCode!.get(rc.lineItemCode) : undefined;
    if (live && item) {
      // Re-price from the line's inputs exactly like the form does.
      const calc = calculateLine(item, region || '', opts.regions!, {
        quantity: Number(rc.quantityDecimal) || 0,
        tenantBillBackPercent: Number(rc.tenantBillBackPercent) || 0,
        customLaborRate: rc.customLaborRate ?? null,
        customAdjustedMaterialCost: rc.customAdjustedMaterialCost ?? null,
        customVendorCost: rc.customVendorCost ?? null,
      });
      vendor += round2(calc.vendorCost);
      client += round2(calc.clientCost);
      tenant += round2(calc.tenantCost);
    } else {
      // Stored-snapshot fallback (no catalog provided, or the code is no longer
      // in the catalog — keep the line's last known cost rather than dropping it).
      vendor += round2(Number(rc.vendorCost) || 0);
      client += round2(Number(rc.clientCost) || 0);
      tenant += round2(Number(rc.tenantCost) || 0);
    }
  }
  vendor = round2(vendor); client = round2(client); tenant = round2(tenant);
  if (lineCount === 0 && opts.skipIfNoLines) return { vendor, client, tenant, lineCount, wrote: false };
  try {
    await updateInspection(inspectionId, {
      total_vendor_cost: vendor,
      total_client_cost: client,
      total_tenant_cost: tenant,
    });
    return { vendor, client, tenant, lineCount, wrote: true };
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (!(msg.includes('PROPERTY_DOESNT_EXIST') || (msg.includes('Property') && msg.includes('does not exist')))) {
      console.warn(`[recomputeInspectionTotals] write failed for ${inspectionId}:`, msg);
    }
    return { vendor, client, tenant, lineCount, wrote: false };
  }
}

/**
 * Backfill `total_vendor_cost` / `total_client_cost` / `total_tenant_cost` across
 * existing inspections. Paginated like the other backfills; skips inspections
 * with no rate-card lines (so questionnaires aren't stamped with 0s).
 *
 * Pass `catalog` + `regions` to RE-PRICE each line live (matching the form) so
 * the backfill corrects rollups built from stale stored snapshots, not just
 * re-sums them. The admin endpoint loads these from the cached catalog/region.
 */
export async function backfillInspectionTotals(
  opts: { after?: string; max?: number; catalog?: RateCardLineItem[]; regions?: RegionRate[] } = {},
): Promise<{ processed: number; updated: number; skipped: number; errors: number; nextAfter: string | null }> {
  const { inspection: typeId } = typeIds();
  const max = opts.max ?? 1000;
  let after = opts.after;
  let processed = 0, updated = 0, skipped = 0, errors = 0;

  // Process records with bounded concurrency rather than strictly one-at-a-time
  // with a fixed sleep: the shared HubSpot request governor (HS_MAX_CONCURRENT)
  // already throttles the underlying calls, so a small in-flight window cuts the
  // wall-clock time ~Nx without risking rate limits. Each recompute makes a few
  // calls, so keep the window small.
  const CONCURRENCY = 4;
  while (processed < max) {
    const body: any = { filterGroups: [], properties: ['template_type'], limit: 100 };
    if (after) body.after = after;
    const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search?archived=false`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const results = resp.results || [];
    for (let i = 0; i < results.length; i += CONCURRENCY) {
      const chunk = results.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map(async (r: any) => {
        processed++;
        try {
          const out = await recomputeInspectionTotals(r.id, {
            skipIfNoLines: true,
            catalog: opts.catalog,
            regions: opts.regions,
          });
          if (out.wrote) updated++; else skipped++;
        } catch (e) {
          errors++;
          console.warn(`[inspection-totals-backfill] record ${r.id} failed:`, e);
        }
      }));
    }
    after = resp.paging?.next?.after;
    if (!after) return { processed, updated, skipped, errors, nextAfter: null };
    if (processed >= max) return { processed, updated, skipped, errors, nextAfter: after };
  }
  return { processed, updated, skipped, errors, nextAfter: after || null };
}

/**
 * Backfill `inspector_name` across existing inspections from the LATEST HubSpot
 * user data, matched by `inspector_email`. Fixes inspections whose stored name
 * was blank or has since changed (e.g. a name was filled in on the user record
 * after inspections were created). Paginated + resumable like the other
 * backfills. Only writes when the resolved name is non-empty AND differs from
 * what's stored, so it's idempotent and a no-op once everything is in sync.
 *
 * `email→name` is built once from fetchUsers() and reused across the whole run.
 */
/**
 * Backfill the combined-date sort key: for inspections with no `last_edited_at`
 * (e.g. scheduled-but-never-edited, or records created before create-time
 * seeding), set it from the scheduled date (falling back to created date) so the
 * single "Date" sort orders them sensibly. Paginated + resumable; only fills
 * empty values (never overwrites a real edit timestamp). Best-effort.
 */
export async function backfillLastEditedDate(
  opts: { after?: string; max?: number } = {},
): Promise<{ processed: number; updated: number; skipped: number; errors: number; nextAfter: string | null }> {
  const { inspection: typeId } = typeIds();
  const max = opts.max ?? 200;
  let after = opts.after;
  let processed = 0, updated = 0, skipped = 0, errors = 0;
  const toIso = (raw: any): string => {
    if (raw == null || raw === '') return '';
    const s = String(raw).trim();
    const t = /^\d+$/.test(s) ? Number(s) : Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00Z` : s);
    return isFinite(t) && !isNaN(t) ? new Date(t).toISOString() : '';
  };

  while (processed < max) {
    const body: any = {
      filterGroups: [],
      properties: ['last_edited_at', 'scheduled_date', 'hs_createdate'],
      limit: 100,
    };
    if (after) body.after = after;
    const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search?archived=false`, {
      method: 'POST', body: JSON.stringify(body),
    });
    for (const r of resp.results || []) {
      processed++;
      const p = r.properties || {};
      if (String(p.last_edited_at || '').trim()) { skipped++; continue; } // already has it
      const iso = toIso(p.scheduled_date) || toIso(p.hs_createdate);
      if (!iso) { skipped++; continue; }
      try { await updateInspection(r.id, { last_edited_at: iso }); updated++; }
      catch (e) { errors++; console.warn(`[last-edited-backfill] ${r.id} failed:`, e); }
    }
    after = resp.paging?.next?.after;
    if (!after) return { processed, updated, skipped, errors, nextAfter: null };
    if (processed >= max) return { processed, updated, skipped, errors, nextAfter: after };
  }
  return { processed, updated, skipped, errors, nextAfter: after || null };
}

/**
 * Backfill: sync every inspection's inspector_name/email FROM its HubSpot record
 * Owner (hubspot_owner_id). Paginated + resumable; idempotent (rows already in
 * sync, or with no owner, are skipped). Use after reassigning owners in bulk.
 */
export async function backfillInspectorFromOwner(
  opts: { after?: string; max?: number } = {},
): Promise<{ processed: number; updated: number; skipped: number; errors: number; nextAfter: string | null }> {
  const { inspection: typeId } = typeIds();
  const max = opts.max ?? 200;
  let after = opts.after;
  let processed = 0, updated = 0, skipped = 0, errors = 0;

  while (processed < max) {
    const body: any = {
      filterGroups: [],
      properties: ['hubspot_owner_id', 'inspector_email', 'inspector_name'],
      limit: 100,
    };
    if (after) body.after = after;
    const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search?archived=false`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const results = resp.results || [];
    for (const r of results) {
      processed++;
      try {
        const changed = await syncInspectorFromOwner(r.id, r.properties || {});
        if (changed) updated++; else skipped++;
      } catch (e) {
        errors++;
        console.warn(`[inspector-from-owner-backfill] record ${r.id} failed:`, e);
      }
    }
    after = resp.paging?.next?.after;
    if (!after) return { processed, updated, skipped, errors, nextAfter: null };
    if (processed >= max) return { processed, updated, skipped, errors, nextAfter: after };
  }
  return { processed, updated, skipped, errors, nextAfter: after || null };
}

/**
 * Backfill `property_status_at_completion` (and the sortable snapshot) for
 * COMPLETED inspections that are missing it — e.g. ones completed before the
 * freeze logic existed. Uses each property's CURRENT status as the value (the
 * best available proxy for "status at completion"). Paginated + resumable; the
 * status filter is stable across the run (we only write the status fields, not
 * `status`), so the `after` cursor stays valid. Idempotent: already-set rows
 * are skipped.
 */
export async function backfillPropertyStatusAtCompletion(
  opts: { after?: string; max?: number } = {},
): Promise<{ processed: number; updated: number; skipped: number; errors: number; nextAfter: string | null }> {
  const { inspection: typeId } = typeIds();
  const max = opts.max ?? 200;
  let after = opts.after;
  let processed = 0, updated = 0, skipped = 0, errors = 0;

  while (processed < max) {
    const body: any = {
      filterGroups: [{ filters: [{ propertyName: 'status', operator: 'IN', values: ['completed', 'complete', 'submitted'] }] }],
      properties: ['property_status_at_completion'],
      limit: 100,
    };
    if (after) body.after = after;
    const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search?archived=false`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const results = resp.results || [];
    for (const r of results) {
      processed++;
      const cur = (r.properties?.property_status_at_completion || '').toString().trim();
      if (cur) { skipped++; continue; } // already has a frozen value
      try {
        await stampPropertyStatusAtCompletion(r.id); // reads the property's CURRENT status, writes both fields
        updated++;
      } catch (e) {
        errors++;
        console.warn(`[property-status-backfill] record ${r.id} failed:`, e);
      }
    }
    after = resp.paging?.next?.after;
    if (!after) return { processed, updated, skipped, errors, nextAfter: null };
    if (processed >= max) return { processed, updated, skipped, errors, nextAfter: after };
  }
  return { processed, updated, skipped, errors, nextAfter: after || null };
}

/**
 * Backfill the standardized 1099 Leasing Agent report fields from existing
 * answers. Paginated + resumable (processes up to `max` 1099 inspections from
 * `after`, returns `nextAfter`). For each it reads the answers, maps them with
 * extractLeasingAgent1099Fields, and writes the inspection fields when present.
 * Idempotent. Skips records whose two source questions aren't found/answered.
 */
export async function backfillLeasingAgent1099Fields(
  opts: { after?: string; max?: number } = {},
): Promise<{ processed: number; updated: number; skipped: number; errors: number; nextAfter: string | null }> {
  const { inspection: typeId } = typeIds();
  const max = opts.max ?? 150;
  let after = opts.after;
  let processed = 0, updated = 0, skipped = 0, errors = 0;

  while (processed < max) {
    const body: any = {
      filterGroups: [{ filters: [{ propertyName: 'template_type', operator: 'EQ', value: 'leasing_agent_1099_property_inspection' }] }],
      properties: ['template_type'],
      limit: 100,
    };
    if (after) body.after = after;
    const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search?archived=false`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const results = resp.results || [];
    for (const r of results) {
      processed++;
      try {
        const answers = await fetchAnswersForInspection(r.id);
        const fields = extractLeasingAgent1099Fields(answers);
        if (Object.keys(fields).length > 0) {
          await updateInspection(r.id, fields as Record<string, any>);
          updated++;
        } else {
          skipped++;
        }
      } catch (e) {
        errors++;
        console.warn(`[1099-field-backfill] record ${r.id} failed:`, e);
      }
    }
    after = resp.paging?.next?.after;
    if (!after) return { processed, updated, skipped, errors, nextAfter: null };
    if (processed >= max) return { processed, updated, skipped, errors, nextAfter: after };
  }
  return { processed, updated, skipped, errors, nextAfter: after || null };
}

export async function backfillInspectorNames(
  opts: { after?: string; max?: number; nameByEmail?: Map<string, string> } = {},
): Promise<{ processed: number; updated: number; skipped: number; errors: number; nextAfter: string | null }> {
  const { inspection: typeId } = typeIds();
  const max = opts.max ?? 1000;
  let after = opts.after;
  let processed = 0, updated = 0, skipped = 0, errors = 0;

  // Build the email→latest-name map once (callers can pass it in to share it
  // across resumed pages).
  let nameByEmail = opts.nameByEmail;
  if (!nameByEmail) {
    nameByEmail = new Map<string, string>();
    // fetchActiveUsers() (not fetchUsers()) so names are repaired from the owner
    // record when /settings/v3/users left them blank — otherwise the backfill
    // would re-write the email-username fallback ("asanders").
    for (const u of await fetchActiveUsers()) {
      const email = (u.email || '').trim().toLowerCase();
      const name = (u.fullName || '').trim();
      if (email && name) nameByEmail.set(email, name);
    }
  }

  const CONCURRENCY = 5;
  while (processed < max) {
    const body: any = {
      filterGroups: [],
      properties: ['inspector_email', 'inspector_name'],
      limit: 100,
    };
    if (after) body.after = after;
    const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search?archived=false`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const results = resp.results || [];
    for (let i = 0; i < results.length; i += CONCURRENCY) {
      const chunk = results.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map(async (r: any) => {
        processed++;
        try {
          const p = r.properties || {};
          const email = String(p.inspector_email || '').trim().toLowerCase();
          const current = String(p.inspector_name || '').trim();
          const latest = email ? nameByEmail!.get(email) : undefined;
          if (latest && latest !== current) {
            await updateInspection(r.id, { inspector_name: latest });
            updated++;
          } else {
            skipped++;
          }
        } catch (e) {
          errors++;
          console.warn(`[inspector-name-backfill] record ${r.id} failed:`, e);
        }
      }));
    }
    after = resp.paging?.next?.after;
    if (!after) return { processed, updated, skipped, errors, nextAfter: null };
    if (processed >= max) return { processed, updated, skipped, errors, nextAfter: after };
  }
  return { processed, updated, skipped, errors, nextAfter: after || null };
}

/**
 * Stamp the inspection's "last edited" timestamp. Called on every edit (answers,
 * photos, rate-card lines) so the list can sort by most-recently-touched.
 *
 * Best-effort: if the `last_edited_at` property hasn't been created in HubSpot
 * yet, we swallow the error (the list falls back to hs_lastmodifieddate) so a
 * save is never blocked by this. Never throws.
 */
export async function touchInspection(recordId: string): Promise<void> {
  try {
    await updateInspection(recordId, { last_edited_at: new Date().toISOString() });
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (msg.includes('PROPERTY_DOESNT_EXIST') || (msg.includes('Property') && msg.includes('does not exist'))) {
      return; // property not created yet — handled by the hs_lastmodifieddate fallback
    }
    console.warn('[touchInspection] failed (non-fatal):', msg);
  }
}

/**
 * Create a Scheduled Inspection record. Returns the new HubSpot record ID.
 * Sets up the Inspection->Property association too.
 */
export async function createScheduledInspection(args: {
  inspectionProps: Record<string, any>;
  propertyRecordId: string;
}): Promise<{ inspectionId: string }> {
  const inspectionId = await createInspection(args.inspectionProps);
  const ok = await associateInspectionToProperty(inspectionId, args.propertyRecordId);
  if (!ok) console.warn('createScheduledInspection: Inspection->Property association not created');
  return { inspectionId };
}

/**
 * QC Turn Re-Inspect: snapshot the source Scope Rate Card's line items onto a
 * newly-created QC inspection as its own answer records. This makes the QC
 * self-contained — later edits to the source don't change the QC.
 *
 * Each copied line keeps cat/sub/desc/qty/unit/vendor + the snapshotted
 * vendor/client/tenant costs (we only display through Vendor $, but we copy
 * everything for fidelity). pass_fail starts blank; the inspector sets it.
 *
 * Returns the number of lines copied.
 */
export async function copyRateCardLinesToQc(args: {
  sourceInspectionId: string;
  qcInspectionId: string;
}): Promise<number> {
  const sourceAnswers = await fetchAnswersForInspection(args.sourceInspectionId);
  const lineAnswers = sourceAnswers.filter((a) => a.answerType === 'rate_card_line' && a.rateCardLine);
  if (lineAnswers.length === 0) return 0;

  const genId = (prefix: string) =>
    `${prefix}-${args.qcInspectionId}-${(typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).slice(2, 12)}`;

  const upserts: AnswerUpsert[] = [];
  // Internal Resolution after-photos captured on the SCOPE carry over to the QC
  // re-inspect: tagged onto the matching QC line AND seeded into the QC's
  // per-section "after" photo pool, so they load already attached when the
  // re-inspect is opened (the inspector validates the in-house work against the
  // photos rather than re-shooting them).
  const afterBySection = new Map<string, { section: string; location: string; urls: string[] }>();

  const lineExternalIds: string[] = [];
  for (const a of lineAnswers) {
    const rc = a.rateCardLine!;
    const externalId = genId('QCLINE');
    lineExternalIds.push(externalId);
    const carriedAfter = isInternalResolution(a.assignedTo) ? (a.afterPhotoUrls || []) : [];
    const props: Record<string, any> = {
      answer_id_external: externalId,
      answer_type: 'rate_card_line',
      answer_summary: a.answerValue || rc.lineItemCode || 'line',
      section: a.section || '',
      location: a.location || '',
      answer_value: a.answerValue || '',
      note: a.note || '',
      assigned_to: a.assignedTo || '',
      quantity: a.quantity != null ? a.quantity : '',
      rate_card_line_item_code: rc.lineItemCode || '',
      quantity_decimal: rc.quantityDecimal != null ? rc.quantityDecimal : '',
      tenant_bill_back_percent: rc.tenantBillBackPercent != null ? rc.tenantBillBackPercent : '',
      is_custom_priced: rc.isCustomPriced ? 'true' : 'false',
      vendor_cost: rc.vendorCost != null ? rc.vendorCost : '',
      client_cost: rc.clientCost != null ? rc.clientCost : '',
      tenant_cost: rc.tenantCost != null ? rc.tenantCost : '',
      // QC-specific: starts unmarked
      pass_fail: '',
    };
    // Override fields: ONLY include when set. These come from the phase3c
    // migration and are NOT provisioned by provisionAppProperties — sending them
    // (even as '') makes HubSpot reject the ENTIRE record as "unknown property" on
    // an org where the migration hasn't run, which would silently drop the whole
    // QC line copy. Mirrors rate-card-lines.ts's guarded writes.
    if (rc.customLaborRate != null) props.custom_labor_rate = rc.customLaborRate;
    if (rc.customAdjustedMaterialCost != null) props.custom_adjusted_material_cost = rc.customAdjustedMaterialCost;
    if (rc.customVendorCost != null) props.custom_vendor_cost = rc.customVendorCost;
    // Pre-tag the carried-over after-photos onto this QC line.
    if (carriedAfter.length > 0) props.photo_urls = joinPhotoUrls(carriedAfter);
    upserts.push({ answerProps: props, questionHubspotRecordId: null });

    if (carriedAfter.length > 0) {
      const key = `${a.section || ''}||${a.location || ''}`;
      const entry = afterBySection.get(key) || { section: a.section || '', location: a.location || '', urls: [] };
      for (const u of carriedAfter) if (!entry.urls.includes(u)) entry.urls.push(u);
      afterBySection.set(key, entry);
    }
  }


  // Seed the QC's per-section "after" photo pools from the carried-over photos.
  for (const entry of afterBySection.values()) {
    upserts.push({
      answerProps: buildSectionPhotoAnswerProps({
        // Use the SAME deterministic external id the form's persistAfterPhotos and
        // the durable photo-attach path use (QCAFTER-<qc>-<section||location>) so
        // all three writers converge on ONE record. A random genId() here made the
        // attach path miss the seeded record and CREATE a duplicate section_photo,
        // and qc-finalize's last-write-wins then dropped one record's After photos.
        answerIdExternal: `QCAFTER-${args.qcInspectionId}-${`${entry.section || ''}||${entry.location || ''}`.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
        summaryLabel: entry.location || entry.section || 'Section',
        section: entry.section,
        location: entry.location,
        photoUrls: entry.urls,
        photoPhase: 'after',
      }),
      questionHubspotRecordId: null,
    });
  }

  // upsertAnswers resolves per-item HubSpot rejections INTERNALLY (returns
  // {failed:true} markers) rather than throwing — so inspect them instead of
  // reporting the queued count as saved. Otherwise a fully-rejected copy returned
  // the full lineCount, and create.ts then stamped a nonzero Client $ on a QC that
  // is actually EMPTY of lines (no error surfaced anywhere).
  const results = await upsertAnswers(args.qcInspectionId, upserts) as Array<{ answerIdExternal: string; failed?: boolean; reason?: string }>;
  const failed = results.filter((r) => r.failed);
  if (failed.length > 0) {
    console.error(`[copyRateCardLinesToQc] ${failed.length}/${upserts.length} QC record(s) rejected by HubSpot for inspection ${args.qcInspectionId} — copied QC will be short. First reason: ${String(failed[0]?.reason || '').slice(0, 200)}`);
  }
  const failedExternal = new Set(failed.map((r) => r.answerIdExternal));
  // Report the count of LINE records that ACTUALLY saved (exclude failures + the
  // seeded section-photo records) so the caller doesn't treat a failed copy as
  // populated.
  const savedLineCount = lineExternalIds.filter((eid) => !failedExternal.has(eid)).length;
  return savedLineCount;
}

/**
 * Read a source inspection's section photos so the QC can show them as
 * "Before" photos. Returns a map keyed by SEVERAL forms of the section
 * identity so the caller can match regardless of how the QC's lines are keyed:
 *   - `${section}||${location}`
 *   - bare `location`
 *   - bare `section`
 * The same URL list is stored under each applicable key.
 */
export async function fetchSourceSectionPhotos(
  sourceInspectionId: string
): Promise<Record<string, string[]>> {
  const answers = await fetchAnswersForInspection(sourceInspectionId);
  const out: Record<string, string[]> = {};
  for (const a of answers) {
    if (a.answerType !== 'section_photo') continue;
    const urls = a.photoUrls || [];
    if (urls.length === 0) continue;
    const composite = `${a.section || ''}||${a.location || ''}`;
    out[composite] = urls;
    if (a.location) out[a.location] = urls;
    if (a.section && !(a.section in out)) out[a.section] = urls;
  }
  return out;
}

/**
 * Upsert answer records for an inspection. This is the autosave workhorse.
 *
 * For each answer in `answersToUpsert`:
 *   - If answer has a `recordId`, PATCH (update) that record
 *   - Else, create a new record AND associate it to the inspection
 *
 * Returns the updated list of {answerIdExternal, recordId} so the caller knows
 * the new record IDs for future updates.
 */
export interface AnswerUpsert {
  // If updating an existing record, this is its HubSpot ID. If creating, undefined.
  recordId?: string;
  // The full Answer property set to write (same shape as createAnswers).
  answerProps: Record<string, any>;
  // For new records only: the Inspection Question's HubSpot ID, so we can associate.
  questionHubspotRecordId?: string | null;
}

/** Map answer_id_external → existing Answer recordId (for the create-dedup guard
 *  in upsertAnswers). Batched IN-search; best-effort. */
async function findAnswerRecordIdsByExternalId(answerTypeId: string, externalIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = Array.from(new Set(externalIds.filter(Boolean)));
  for (let i = 0; i < uniq.length; i += 100) {
    const chunk = uniq.slice(i, i + 100);
    const resp = await hubspotFetch(`/crm/v3/objects/${answerTypeId}/search?archived=false`, {
      method: 'POST',
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: 'answer_id_external', operator: 'IN', values: chunk }] }],
        properties: ['answer_id_external'],
        limit: 100,
      }),
    });
    for (const r of resp.results || []) {
      const ext = String(r.properties?.answer_id_external || '');
      if (ext && !out.has(ext)) out.set(ext, String(r.id));
    }
  }
  return out;
}

export async function upsertAnswers(
  inspectionRecordId: string,
  upserts: AnswerUpsert[]
): Promise<Array<{ recordId: string; answerIdExternal: string; failed?: boolean; reason?: string }>> {
  if (upserts.length === 0) return [];
  const tids = typeIds();

  // Split into creates vs updates
  const toCreate = upserts.filter((u) => !u.recordId);
  const toUpdate = upserts.filter((u) => u.recordId);

  // Idempotency guard: a "create" (no client recordId) whose answer_id_external
  // ALREADY exists in HubSpot would make a DUPLICATE record. This happens if the
  // client lost the recordId (e.g. autosave abandoned tracking after unconfirmed
  // flushes, or an offline replay). Look the externals up and reclassify any that
  // already exist as UPDATES, so a re-save updates in place instead of duplicating.
  if (toCreate.length > 0) {
    try {
      const exts = toCreate.map((u) => String(u.answerProps?.answer_id_external || '')).filter(Boolean);
      const existing = await findAnswerRecordIdsByExternalId(tids.answer, exts);
      if (existing.size > 0) {
        for (const u of toCreate) {
          const rid = existing.get(String(u.answerProps?.answer_id_external || ''));
          if (rid) u.recordId = rid; // mutate → now treated as an update below
        }
        const promoted = toCreate.filter((u) => u.recordId);
        if (promoted.length > 0) {
          toUpdate.push(...promoted);
          const stillCreate = toCreate.filter((u) => !u.recordId);
          toCreate.length = 0; toCreate.push(...stillCreate);
        }
      }
    } catch (e) {
      console.warn('[upsertAnswers] external-id dedup lookup failed (continuing as creates):', String((e as any)?.message || e).slice(0, 160));
    }
  }

  // Failed items are RETURNED (not silently dropped): the client must know which
  // answers HubSpot rejected and WHY, otherwise the autosave never sees them come
  // back, keeps them "dirty", and re-saves forever — the perpetual "Saving…" loop.
  const results: Array<{ recordId: string; answerIdExternal: string; failed?: boolean; reason?: string }> = [];

  // ----- Updates (PATCH each) -----
  // HubSpot supports batch/update for properties. Use it — but if a chunk is
  // rejected (one bad property value 400s the WHOLE batch), retry it per-item so
  // the good answers still save and only the offending one is skipped (logged
  // with its props so the bad property is diagnosable). This keeps a single bad
  // answer from blocking an entire submit.
  if (toUpdate.length > 0) {
    for (let i = 0; i < toUpdate.length; i += HUBSPOT_BATCH_LIMIT) {
      const chunk = toUpdate.slice(i, i + HUBSPOT_BATCH_LIMIT);
      const runUpdate = (items: typeof chunk) => hubspotFetch(`/crm/v3/objects/${tids.answer}/batch/update`, {
        method: 'POST',
        body: JSON.stringify({ inputs: items.map((u) => ({ id: u.recordId, properties: u.answerProps })) }),
      });
      try {
        const resp = await runUpdate(chunk);
        for (const r of resp.results || []) results.push({ recordId: r.id, answerIdExternal: r.properties?.answer_id_external || '' });
      } catch (batchErr: any) {
        console.warn(`[upsertAnswers] batch/update of ${chunk.length} failed — retrying per item:`, String(batchErr?.detail || batchErr?.message || batchErr).slice(0, 200));
        for (const u of chunk) {
          try {
            const r = await runUpdate([u]);
            for (const x of r.results || []) results.push({ recordId: x.id, answerIdExternal: x.properties?.answer_id_external || '' });
          } catch (itemErr: any) {
            const reason = String(itemErr?.detail || itemErr?.message || itemErr).slice(0, 300);
            console.error(`[upsertAnswers] SKIPPED update of answer ${u.answerProps?.answer_id_external} (${u.answerProps?.question_id_external}) — ${reason}`);
            results.push({ recordId: u.recordId || '', answerIdExternal: u.answerProps?.answer_id_external || '', failed: true, reason });
          }
        }
      }
    }
  }

  // ----- Creates (batch/create) -----
  if (toCreate.length > 0) {
    const newAnswers: Array<{ externalId: string; recordId: string }> = [];
    const collect = (resp: any) => {
      for (const r of resp.results || []) {
        newAnswers.push({ externalId: r.properties?.answer_id_external || '', recordId: r.id });
        results.push({ recordId: r.id, answerIdExternal: r.properties?.answer_id_external || '' });
      }
    };
    for (let i = 0; i < toCreate.length; i += HUBSPOT_BATCH_LIMIT) {
      const chunk = toCreate.slice(i, i + HUBSPOT_BATCH_LIMIT);
      const runCreate = (items: typeof chunk) => hubspotFetch(`/crm/v3/objects/${tids.answer}/batch/create`, {
        method: 'POST',
        body: JSON.stringify({ inputs: items.map((u) => ({ properties: u.answerProps })) }),
      });
      try {
        collect(await runCreate(chunk));
      } catch (batchErr: any) {
        // One bad property value 400s the whole batch — retry per item so the
        // good answers still save and only the offender is skipped (logged).
        console.warn(`[upsertAnswers] batch/create of ${chunk.length} failed — retrying per item:`, String(batchErr?.detail || batchErr?.message || batchErr).slice(0, 200));
        for (const u of chunk) {
          try { collect(await runCreate([u])); }
          catch (itemErr: any) {
            const reason = String(itemErr?.detail || itemErr?.message || itemErr).slice(0, 300);
            console.error(`[upsertAnswers] SKIPPED create of answer ${u.answerProps?.answer_id_external} (${u.answerProps?.question_id_external}) — ${reason}`);
            results.push({ recordId: '', answerIdExternal: u.answerProps?.answer_id_external || '', failed: true, reason });
          }
        }
      }
    }

    // Associate each new Answer to the Inspection (batch). This association is
    // CRITICAL: fetchAnswersForInspection reads answers BY this association, so
    // an answer created without it is orphaned and invisible on reopen (looks
    // like data loss even though the record exists). Resolve the labeled type,
    // fall back to the default association type, and fail loudly if neither
    // works rather than silently creating orphaned answers.
    let inspToAnswer = await getAssociationTypeId(tids.inspection, tids.answer, 'Answer of');
    if (inspToAnswer == null) {
      inspToAnswer = await getDefaultAssociationTypeId(tids.inspection, tids.answer);
      console.warn(`[upsertAnswers] 'Answer of' label not found; using default association type ${inspToAnswer}`);
    }
    if (inspToAnswer == null) {
      throw new Error(
        'Could not resolve the Inspection→Answer association type. Answers would be ' +
        'orphaned (invisible on reopen), so the save was aborted. Check the association ' +
        'labels between the Inspection and Answer objects in HubSpot.'
      );
    }
    if (newAnswers.length > 0) {
      const pairs = newAnswers.map((a) => ({ fromId: inspectionRecordId, toId: a.recordId }));
      let assocResult = await batchCreateAssociations(tids.inspection, tids.answer, inspToAnswer, pairs);
      // PARTIAL failure → those specific answers would be orphaned (invisible on
      // reopen). Re-associating is IDEMPOTENT in HubSpot (re-creating an existing
      // association is a no-op and never duplicates the Answer record), so retry
      // the whole set ONCE to recover transient failures (a 429 on one chunk,
      // brief 5xx) before treating it as data loss.
      if (assocResult.failed > 0) {
        console.warn(`[upsertAnswers] ${assocResult.failed}/${pairs.length} Inspection→Answer associations failed — retrying once (idempotent)`);
        assocResult = await batchCreateAssociations(tids.inspection, tids.answer, inspToAnswer, pairs);
      }
      if (assocResult.ok === 0) {
        throw new Error(
          `Created ${newAnswers.length} answer record(s) but FAILED to associate any ` +
          `to the inspection — they would be invisible on reopen. Aborting so the issue ` +
          `is visible rather than causing silent data loss.`
        );
      }
      if (assocResult.failed > 0) {
        // Still partial after the idempotent retry — log loudly (telemetry) so it
        // surfaces rather than silently orphaning those answers.
        console.error(`[upsertAnswers] ${assocResult.failed}/${pairs.length} Inspection→Answer associations STILL failed after retry for inspection ${inspectionRecordId} — those answers may be invisible on reopen.`);
      }
    }

    // Associate each new Answer to its source Question (batch)
    const qToAnswer = await getAssociationTypeId(tids.question, tids.answer, 'Answer to');
    if (qToAnswer != null) {
      // Match each created Answer to its source Question by answer_id_external —
      // NOT by array index. newAnswers only collects SUCCESSFUL creates, so a
      // per-item create failure shortens/misaligns it and index-matching would
      // link a question to the WRONG answer (and drop another's link).
      const recordIdByExternal = new Map(newAnswers.map((a) => [a.externalId, a.recordId]));
      const qaPairs: Array<{ fromId: string; toId: string }> = [];
      for (const u of toCreate) {
        const qid = u.questionHubspotRecordId;
        const ext = String(u.answerProps?.answer_id_external || '');
        if (!qid || !ext) continue;
        const toId = recordIdByExternal.get(ext);
        if (!toId) continue; // this answer's create failed — no link to make
        qaPairs.push({ fromId: qid, toId });
      }
      if (qaPairs.length > 0) {
        // Idempotent retry on partial failure (same rationale as the
        // Inspection→Answer batch above). Non-fatal — a missing Question→Answer
        // link only affects question-grouped views, not answer visibility.
        let qaResult = await batchCreateAssociations(tids.question, tids.answer, qToAnswer, qaPairs);
        if (qaResult.failed > 0) {
          console.warn(`[upsertAnswers] ${qaResult.failed}/${qaPairs.length} Question→Answer associations failed — retrying once (idempotent)`);
          qaResult = await batchCreateAssociations(tids.question, tids.answer, qToAnswer, qaPairs);
          if (qaResult.failed > 0) console.error(`[upsertAnswers] ${qaResult.failed}/${qaPairs.length} Question→Answer associations STILL failed after retry for inspection ${inspectionRecordId}.`);
        }
      }
    }
  }

  return results;
}

/**
 * Archive (delete) Answer records by ID. Used when an inspector clears a field
 * that previously had an answer.
 *
 * HubSpot batch/archive uses { inputs: [{ id }] }.
 */
export async function archiveAnswers(answerRecordIds: string[]): Promise<void> {
  if (answerRecordIds.length === 0) return;
  const { answer: typeId } = typeIds();
  const runBatch = (ids: string[]) => hubspotFetch(`/crm/v3/objects/${typeId}/batch/archive`, {
    method: 'POST',
    body: JSON.stringify({ inputs: ids.map((id) => ({ id })) }),
  });
  for (let i = 0; i < answerRecordIds.length; i += HUBSPOT_BATCH_LIMIT) {
    const chunk = answerRecordIds.slice(i, i + HUBSPOT_BATCH_LIMIT);
    try {
      await runBatch(chunk);
    } catch (batchErr: any) {
      // HubSpot 400s the ENTIRE batch if ANY id is stale/already-archived. Retry
      // per-id so one bad id can't fail the archive of the others — and can't fail
      // an otherwise-successful autosave (answers.ts awaits this after upserting),
      // which would leave a "deleted" answer un-archived so it reappears on reopen.
      // An already-gone id is effectively success (it's archived either way).
      console.warn(`[archiveAnswers] batch archive of ${chunk.length} failed — retrying per id:`, String(batchErr?.detail || batchErr?.message || batchErr).slice(0, 200));
      for (const id of chunk) {
        try { await runBatch([id]); }
        catch (e: any) { console.warn(`[archiveAnswers] could not archive ${id} (already archived/stale?):`, String(e?.message || e).slice(0, 160)); }
      }
    }
  }
}

// ===========================================================================
// Rate Card fetchers
// ===========================================================================

import type { RateCardLineItem, RegionRate } from './types';

/**
 * Fetch ALL active rate_card_line_item records (the live catalog — ~1,000+ items
 * and growing). Pagination is unbounded (loops on `after` until exhausted), so
 * there is NO hardcoded size cap: additions/removals in HubSpot flow through
 * automatically. (HubSpot's Search API paginates up to 10,000 results total —
 * well above the current size; revisit only if the catalog ever nears that.)
 *
 * Pages through search results (HubSpot caps at 100 per page).
 * Use only inside the cached API layer in /api/rate-card/catalog — do NOT call
 * from per-request code paths or it'll be slow.
 */
export async function fetchRateCardCatalog(): Promise<RateCardLineItem[]> {
  const ids = await rateCardTypeIds();
  const properties = [
    'line_item_code', 'labor_short_description', 'labor_full_description', 'labor_subtext',
    'category', 'subcategory',
    'labor_code', 'labor_meas', 'labor_hours', 'labor_hourly_rate_list',
    'material_code', 'material_description', 'material_meas',
    'material_rate', 'material_qty', 'material_cost',
    'bill_to', 'work_type',
    'is_labor_only', 'is_bid_item', 'is_active',
    'catalog_version',
  ];

  const out: RateCardLineItem[] = [];
  let after: string | undefined;
  do {
    const body: any = {
      filterGroups: [
        // Active only. is_active is a boolean-like enum stored as 'true'/'false' strings.
        { filters: [{ propertyName: 'is_active', operator: 'EQ', value: 'true' }] },
      ],
      properties,
      limit: 100,
      sorts: [{ propertyName: 'category', direction: 'ASCENDING' }],
    };
    if (after) body.after = after;
    const resp = await hubspotFetch(`/crm/v3/objects/${ids.lineItem}/search`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    for (const r of resp.results || []) {
      const p = r.properties || {};
      out.push({
        recordId: r.id,
        lineItemCode: p.line_item_code || '',
        laborShortDescription: p.labor_short_description || '',
        laborFullDescription: p.labor_full_description || '',
        laborSubtext: p.labor_subtext || '',
        category: p.category || '',
        subcategory: p.subcategory || '',
        laborCode: p.labor_code || '',
        laborMeas: p.labor_meas || '',
        laborHours: numOrZero(p.labor_hours),
        laborHourlyRateList: numOrZero(p.labor_hourly_rate_list),
        materialCode: p.material_code || '',
        materialDescription: p.material_description || '',
        materialMeas: p.material_meas || '',
        materialRate: numOrZero(p.material_rate),
        materialQty: numOrZero(p.material_qty),
        materialCost: numOrZero(p.material_cost),
        billTo: p.bill_to || '',
        workType: p.work_type || '',
        isLaborOnly: p.is_labor_only === 'true',
        isBidItem: p.is_bid_item === 'true',
        isActive: p.is_active === 'true',
        catalogVersion: p.catalog_version || '',
      });
    }
    after = resp.paging?.next?.after;
    // No artificial per-page throttle. The catalog's ~9 pages are fetched
    // sequentially (each await serializes the next), and rate-limit protection
    // now lives centrally in hubspotFetch: the request governor caps in-flight
    // concurrency and 429s are retried with backoff. The old unconditional 150ms
    // sleep added ~1.3s of pure wait to every cold catalog load for no benefit
    // the governor doesn't already provide.
  } while (after);
  return out;
}

/**
 * Fetch a single catalog record by its natural key (line_item_code).
 * Used at line-save time to load the snapshot inputs.
 */
export async function fetchRateCardLineItemByCode(code: string): Promise<RateCardLineItem | null> {
  const ids = await rateCardTypeIds();
  const properties = [
    'line_item_code', 'labor_short_description', 'labor_full_description', 'labor_subtext',
    'category', 'subcategory',
    'labor_code', 'labor_meas', 'labor_hours', 'labor_hourly_rate_list',
    'material_code', 'material_description', 'material_meas',
    'material_rate', 'material_qty', 'material_cost',
    'bill_to', 'work_type',
    'is_labor_only', 'is_bid_item', 'is_active',
    'catalog_version',
  ];
  const body = {
    filterGroups: [
      { filters: [{ propertyName: 'line_item_code', operator: 'EQ', value: code }] },
    ],
    properties,
    limit: 1,
  };
  const resp = await hubspotFetch(`/crm/v3/objects/${ids.lineItem}/search`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const r = (resp.results || [])[0];
  if (!r) return null;
  const p = r.properties || {};
  return {
    recordId: r.id,
    lineItemCode: p.line_item_code || '',
    laborShortDescription: p.labor_short_description || '',
    laborFullDescription: p.labor_full_description || '',
    laborSubtext: p.labor_subtext || '',
    category: p.category || '',
    subcategory: p.subcategory || '',
    laborCode: p.labor_code || '',
    laborMeas: p.labor_meas || '',
    laborHours: numOrZero(p.labor_hours),
    laborHourlyRateList: numOrZero(p.labor_hourly_rate_list),
    materialCode: p.material_code || '',
    materialDescription: p.material_description || '',
    materialMeas: p.material_meas || '',
    materialRate: numOrZero(p.material_rate),
    materialQty: numOrZero(p.material_qty),
    materialCost: numOrZero(p.material_cost),
    billTo: p.bill_to || '',
    workType: p.work_type || '',
    isLaborOnly: p.is_labor_only === 'true',
    isBidItem: p.is_bid_item === 'true',
    isActive: p.is_active === 'true',
    catalogVersion: p.catalog_version || '',
  };
}

/**
 * Archive (delete) a rate_card_line_item record. This is HubSpot's standard
 * archive — the record leaves the active object list and the live catalog.
 * Archived records can still be restored from HubSpot's recycling bin for a
 * window, but treat this as a real delete. Admin-tool use only.
 */
export async function archiveRateCardLineItem(recordId: string): Promise<void> {
  const ids = await rateCardTypeIds();
  await hubspotFetch(`/crm/v3/objects/${ids.lineItem}/${recordId}`, { method: 'DELETE' });
}

/**
 * Fetch all 18 region_rate records.
 *
 * Same caching/usage caveat as fetchRateCardCatalog.
 */
export async function fetchRegionRates(): Promise<RegionRate[]> {
  const ids = await rateCardTypeIds();
  const properties = [
    'region', 'material_cost_adjustment', 'material_tax_adjustment',
    'rate_appliance', 'rate_cabinet', 'rate_carpentry', 'rate_cleaning',
    'rate_concrete', 'rate_doors', 'rate_drywall', 'rate_electrical',
    'rate_fence', 'rate_flooring', 'rate_garage_doors', 'rate_gutters',
    'rate_hvac', 'rate_hvac_sibi_units', 'rate_inspections', 'rate_landscape',
    'rate_painting', 'rate_pest_control', 'rate_plumbing', 'rate_remediation',
    'rate_roofing', 'rate_septic', 'rate_siding', 'rate_trash_debris_removal',
    'rate_unit_turns', 'rate_utility_activation', 'rate_windows_glass',
    'rates_version', 'is_active',
  ];

  const out: RegionRate[] = [];
  let after: string | undefined;
  do {
    const body: any = {
      filterGroups: [
        { filters: [{ propertyName: 'is_active', operator: 'EQ', value: 'true' }] },
      ],
      properties,
      limit: 100,
      sorts: [{ propertyName: 'region', direction: 'ASCENDING' }],
    };
    if (after) body.after = after;
    const resp = await hubspotFetch(`/crm/v3/objects/${ids.regionRate}/search`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    for (const r of resp.results || []) {
      const p = r.properties || {};
      out.push({
        recordId: r.id,
        region: p.region || '',
        materialCostAdjustment: numOrZero(p.material_cost_adjustment),
        materialTaxAdjustment: numOrZero(p.material_tax_adjustment),
        rateAppliance: numOrZero(p.rate_appliance),
        rateCabinet: numOrZero(p.rate_cabinet),
        rateCarpentry: numOrZero(p.rate_carpentry),
        rateCleaning: numOrZero(p.rate_cleaning),
        rateConcrete: numOrZero(p.rate_concrete),
        rateDoors: numOrZero(p.rate_doors),
        rateDrywall: numOrZero(p.rate_drywall),
        rateElectrical: numOrZero(p.rate_electrical),
        rateFence: numOrZero(p.rate_fence),
        rateFlooring: numOrZero(p.rate_flooring),
        rateGarageDoors: numOrZero(p.rate_garage_doors),
        rateGutters: numOrZero(p.rate_gutters),
        rateHvac: numOrZero(p.rate_hvac),
        rateHvacSibiUnits: numOrZero(p.rate_hvac_sibi_units),
        rateInspections: numOrZero(p.rate_inspections),
        rateLandscape: numOrZero(p.rate_landscape),
        ratePainting: numOrZero(p.rate_painting),
        ratePestControl: numOrZero(p.rate_pest_control),
        ratePlumbing: numOrZero(p.rate_plumbing),
        rateRemediation: numOrZero(p.rate_remediation),
        rateRoofing: numOrZero(p.rate_roofing),
        rateSeptic: numOrZero(p.rate_septic),
        rateSiding: numOrZero(p.rate_siding),
        rateTrashDebrisRemoval: numOrZero(p.rate_trash_debris_removal),
        rateUnitTurns: numOrZero(p.rate_unit_turns),
        rateUtilityActivation: numOrZero(p.rate_utility_activation),
        rateWindowsGlass: numOrZero(p.rate_windows_glass),
        ratesVersion: p.rates_version || '',
        isActive: p.is_active === 'true',
      });
    }
    after = resp.paging?.next?.after;
  } while (after);
  return out;
}

/**
 * Fetch the property's region property (used at inspection start to snapshot
 * region_snapshot onto the new inspection).
 */
export async function fetchPropertyRegion(propertyRecordId: string): Promise<string | null> {
  const tids = typeIds();
  try {
    const resp = await hubspotFetch(
      `/crm/v3/objects/${tids.property}/${propertyRecordId}?properties=region`,
    );
    const v = resp?.properties?.region;
    return (typeof v === 'string' && v.trim()) ? v.trim() : null;
  } catch (e: any) {
    if (String(e).includes('404')) return null;
    throw e;
  }
}

// Helper used by the fetchers above.
function numOrZero(v: any): number {
  if (v == null || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return isFinite(n) ? n : 0;
}
