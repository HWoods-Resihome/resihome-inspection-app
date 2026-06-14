// HubSpot API client. SERVER-SIDE ONLY -- never import in client code.

import type { Question, Property, HubSpotUser, InspectionSummary } from './types';
import { isInternalResolution } from './vendors';
import { buildSectionPhotoAnswerProps, joinPhotoUrls } from './answerProps';

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
// Concurrency cap: hand a fixed number of slots out, queue the rest. Env-tunable.
const HS_MAX_CONCURRENT = Math.max(1, Number(process.env.HUBSPOT_MAX_CONCURRENT) || 8);
let hsActive = 0;
const hsWaiters: Array<() => void> = [];
async function hsAcquire(): Promise<void> {
  if (hsActive < HS_MAX_CONCURRENT) { hsActive++; return; }
  // No free slot — wait. The releaser hands its slot directly to us (it does NOT
  // decrement), so hsActive stays accurate without a race.
  await new Promise<void>((resolve) => hsWaiters.push(resolve));
}
function hsRelease(): void {
  const next = hsWaiters.shift();
  if (next) next();        // transfer the slot to the next waiter
  else hsActive--;         // nobody waiting — free the slot
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
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= BACKOFFS_MS.length; attempt++) {
    const res = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Authorization: `Bearer ${token()}`,
        'Content-Type': 'application/json',
      },
    });
    if (res.status === 429 && attempt < BACKOFFS_MS.length) {
      const retryAfterHeader = res.headers.get('retry-after');
      const retryAfterMs = retryAfterHeader
        ? Math.max(BACKOFFS_MS[attempt], Number(retryAfterHeader) * 1000)
        : BACKOFFS_MS[attempt];
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
      console.warn(`[hubspotFetch] ${res.status} on ${method} ${path}, retrying in ${BACKOFFS_MS[attempt]}ms (attempt ${attempt + 1}/${BACKOFFS_MS.length})`);
      await new Promise((resolve) => setTimeout(resolve, BACKOFFS_MS[attempt]));
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
      (lastError as any).detail = text.slice(0, 500);
      hsNoteFailure();
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
    sourceRateCardId: null,
    sourceRateCardName: null,
    qcVerdict: null,
    qcPassCount: null,
    qcFailCount: null,
    submittedAt: null,
    submittedByEmail: null,
    approvedByName: null,
    approvedAt: null,
    resolutionTimingJson: null,
  };
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

// The inspection templates currently offered (used to populate the filter
// dropdown without scanning the whole dataset for distinct values).
const CURRENT_TEMPLATE_TYPES = [
  'pm_scope_rate_card',
  'pm_turn_reinspect_qc',
  'pm_community_inspection',
  'pm_vacancy_occupancy_check',
  'qc_new_construction_rrqc',
  'leasing_agent_1099_property_inspection',
];

export type InspectionStatusKey = 'all' | 'scheduled' | 'in_progress' | 'pending_approval' | 'completed';
export type InspectionSortField = 'updated' | 'scheduled';

export interface InspectionQuery {
  search?: string;
  status?: InspectionStatusKey;
  inspectors?: string[];         // exact inspector_name values; empty = no filter
  templates?: string[];          // exact template_type values; empty = no filter
  forceTemplate?: string | null; // external (1099) users are locked to one template
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
  if (status && STATUS_VARIANTS[status]) {
    filters.push({ propertyName: 'status', operator: 'IN', values: STATUS_VARIANTS[status] });
  } else {
    // "All" still hides cancelled inspections from the field team.
    filters.push({ propertyName: 'status', operator: 'NOT_IN', values: CANCELLED_VARIANTS });
  }
  const templates = q.forceTemplate
    ? [q.forceTemplate]
    : (q.templates || []).map((t) => t.trim()).filter((t) => t && t !== 'all');
  if (templates.length) filters.push({ propertyName: 'template_type', operator: 'IN', values: templates });
  const inspectors = (q.inspectors || []).map((n) => n.trim()).filter((n) => n && n !== 'all');
  if (inspectors.length) filters.push({ propertyName: 'inspector_name', operator: 'IN', values: inspectors });
  return filters;
}

// Compose filterGroups. When searching, replicate the AND-filters into each of
// the three search dimensions (address / name / inspector) so search ANDs with
// the active filters (HubSpot ORs across groups, ANDs within a group).
function inspectionFilterGroups(q: InspectionQuery): any[] {
  const and = inspectionAndFilters(q);
  const search = (q.search || '').trim();
  if (!search) return [{ filters: and }];
  const token = `*${search}*`;
  return ['property_address_snapshot', 'inspection_name', 'inspector_name'].map((propertyName) => ({
    filters: [{ propertyName, operator: 'CONTAINS_TOKEN', value: token }, ...and],
  }));
}

const SORT_PROPERTY: Record<InspectionSortField, string> = {
  updated: 'hs_lastmodifieddate',
  scheduled: 'scheduled_date',
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
  const sortField: InspectionSortField = params.sortField === 'scheduled' ? 'scheduled' : 'updated';
  const direction = params.sortDir === 'asc' ? 'ASCENDING' : 'DESCENDING';
  const pageSize = Math.min(100, Math.max(1, params.pageSize || 20));
  const page = Math.max(1, params.page || 1);
  const offset = (page - 1) * pageSize;
  const body: any = {
    filterGroups: inspectionFilterGroups(params),
    properties: INSPECTION_LIST_PROPERTIES,
    limit: pageSize,
    sorts: [{ propertyName: SORT_PROPERTY[sortField], direction }],
  };
  // HubSpot caps offset paging at 10,000; clamp so a very deep page never errors.
  if (offset > 0) body.after = String(Math.min(offset, Math.max(0, 10000 - pageSize)));
  const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search?archived=false`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const items = (resp.results || []).map(mapInspectionRow);
  const total = typeof resp.total === 'number' ? resp.total : items.length;
  return { items, total };
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
  const [all, scheduled, in_progress, pending_approval, completed] = await Promise.all(keys.map(countOne));
  return { all, scheduled, in_progress, pending_approval, completed };
}

// Distinct inspector_name values that actually appear on inspections — so the
// filter dropdown lists only inspectors WITH inspections, not the whole user
// directory. Derived from a bounded recent scan (HubSpot has no distinct API),
// cached at module scope so the multi-page sweep runs at most once per TTL per
// warm instance rather than on every home load.
let _inspectorNamesCache: { names: string[]; at: number } | null = null;
const INSPECTOR_NAMES_TTL_MS = 30 * 60 * 1000;
const INSPECTOR_NAMES_MAX_PAGES = 20; // up to ~2,000 most-recently-touched inspections

export async function inspectionInspectorNames(): Promise<string[]> {
  if (_inspectorNamesCache && Date.now() - _inspectorNamesCache.at < INSPECTOR_NAMES_TTL_MS) {
    return _inspectorNamesCache.names;
  }
  const { inspection: typeId } = typeIds();
  const seen = new Set<string>();
  let after: string | undefined;
  let pages = 0;
  try {
    do {
      const body: any = {
        filterGroups: [{ filters: [{ propertyName: 'status', operator: 'NOT_IN', values: CANCELLED_VARIANTS }] }],
        properties: ['inspector_name'],
        limit: 100,
        sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
      };
      if (after) body.after = after;
      const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search?archived=false`, {
        method: 'POST', body: JSON.stringify(body),
      });
      for (const r of resp.results || []) {
        const n = String(r.properties?.inspector_name || '').trim();
        if (n) seen.add(n);
      }
      after = resp.paging?.next?.after;
      pages++;
    } while (after && pages < INSPECTOR_NAMES_MAX_PAGES);
  } catch (e) {
    // Return whatever we collected; an empty list just yields no inspector options.
    console.warn('[inspector-facet] scan failed:', e);
  }
  const names = Array.from(seen).sort((a, b) => a.localeCompare(b));
  // Only cache a non-empty result so a transient failure doesn't pin an empty list.
  if (names.length) _inspectorNamesCache = { names, at: Date.now() };
  return names;
}

/**
 * Options for the inspector + template filter dropdowns, derived WITHOUT a full
 * dataset scan: inspectors are the distinct names that appear on inspections
 * (cached, bounded recent scan), templates the known current set. External
 * users only ever see their one template.
 */
export async function inspectionFacets(opts: { externalTemplate?: string | null } = {}): Promise<{ inspectors: string[]; templates: string[] }> {
  let inspectors: string[] = [];
  try { inspectors = await inspectionInspectorNames(); } catch { inspectors = []; }
  const templates = opts.externalTemplate ? [opts.externalTemplate] : CURRENT_TEMPLATE_TYPES;
  return { inspectors, templates };
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
// record archived, so the set of non-archived owner emails is the authoritative
// "currently active" list. Cached briefly (login hits this a few times per
// sign-in). Returns null on error so callers can fail OPEN (don't lock everyone
// out during an owners-API hiccup) rather than closed.
let _activeOwnerEmailsCache: { emails: Set<string>; at: number } | null = null;
const ACTIVE_OWNERS_TTL_MS = 5 * 60 * 1000;
async function fetchActiveOwnerEmails(): Promise<Set<string> | null> {
  if (_activeOwnerEmailsCache && Date.now() - _activeOwnerEmailsCache.at < ACTIVE_OWNERS_TTL_MS) {
    return _activeOwnerEmailsCache.emails;
  }
  try {
    const emails = new Set<string>();
    let after: string | undefined;
    do {
      const qs = new URLSearchParams({ limit: '100', archived: 'false' });
      if (after) qs.set('after', after);
      const resp = await hubspotFetch(`/crm/v3/owners/?${qs.toString()}`);
      for (const o of resp.results || []) {
        if (o.email) emails.add(String(o.email).trim().toLowerCase());
      }
      after = resp.paging?.next?.after;
    } while (after);
    _activeOwnerEmailsCache = { emails, at: Date.now() };
    return emails;
  } catch (e) {
    console.warn('[auth] could not load active owners; falling back to all users:', e);
    return null;
  }
}

/**
 * Active HubSpot users — fetchUsers() filtered to those whose owner is NOT
 * archived (i.e. the account hasn't been deactivated/removed). This is the gate
 * sign-in must use so a deactivated user can't authenticate. If the owners list
 * can't be loaded, falls back to all users (fail-open) so an API hiccup can't
 * lock everyone out.
 */
export async function fetchActiveUsers(): Promise<HubSpotUser[]> {
  const [users, activeEmails] = await Promise.all([fetchUsers(), fetchActiveOwnerEmails()]);
  if (!activeEmails) return users; // owners unavailable → don't break login
  return users.filter((u) => activeEmails.has(u.email.trim().toLowerCase()));
}

async function getAssociationTypeId(fromTypeId: string, toTypeId: string, label: string): Promise<number | null> {
  const resp = await hubspotFetch(assocLabelsUrl(fromTypeId, toTypeId));
  for (const a of resp.results || []) {
    if (a.label === label) return a.typeId;
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
  }));
  form.append('folderPath', folderPath);

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}` },
    body: form,
  });
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

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}` },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot file upload failed ${res.status}: ${text.slice(0, 500)}`);
  }
  const json = await res.json();
  return { url: json.url || json.cdnUrl || '', id: String(json.id || '') };
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
      sourceRateCardId: null,
      sourceRateCardName: null,
      qcVerdict: null,
      qcPassCount: null,
      qcFailCount: null,
      submittedAt: null,
      submittedByEmail: null,
      approvedByName: null,
      approvedAt: null,
      resolutionTimingJson: null,
    };
  } catch (e: any) {
    if (String(e).includes('404')) return null;
    throw e;
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
  propertyAirFiltersType1: string | null;
  propertyAirFiltersType2: string | null;
  propertyAirFiltersType3: string | null;
  propertySepticFee: number | null;
  /** Property's team_group_email — preferred finalize CC. */
  propertyTeamGroupEmail: string | null;
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
    'source_rate_card_id', 'source_rate_card_name', 'qc_verdict', 'qc_pass_count', 'qc_fail_count',
    // Submit/approve stamps + Internal Resolution timing map
    'submitted_at', 'submitted_by_email', 'approved_by_name', 'approved_at', 'resolution_timing_json',
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
    let propertyAddressStreet: string | null = null;
    let propertyCity: string | null = null;
    let propertyStateCode: string | null = null;
    let propertyEntityId: string | null = null;
    let propertyLastPrimaryTenant: string | null = null;
    let propertyLastTenantMonths: number | null = null;
    let propertyHbmmId: string | null = null;
    let propertyAirFiltersTotal: number | null = null;
    let propertyAirFiltersType1: string | null = null;
    let propertyAirFiltersType2: string | null = null;
    let propertyAirFiltersType3: string | null = null;
    let propertySepticFee: number | null = null;
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
          // Preferred email CC for finalize (falls back to team{STATE}@resihome.com).
          'team_group_email',
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
        if (pp.air_filters___total_quantity != null && pp.air_filters___total_quantity !== '') {
          const n = Number(pp.air_filters___total_quantity);
          if (Number.isFinite(n)) propertyAirFiltersTotal = n;
        }
        propertyAirFiltersType1 = (pp.air_filters___type__1 || '').toString().trim() || null;
        propertyAirFiltersType2 = (pp.air_filters___type__2 || '').toString().trim() || null;
        propertyAirFiltersType3 = (pp.air_filters___type__3 || '').toString().trim() || null;
        if (pp.septic_fee != null && pp.septic_fee !== '') {
          const n = Number(pp.septic_fee);
          if (Number.isFinite(n)) propertySepticFee = n;
        }
        propertyTeamGroupEmail = (pp.team_group_email || '').toString().trim() || null;
      } catch (e: any) {
        console.warn(`[fetchInspectionWithPropertyRef] could not fetch property ${propertyIdRef} extras:`, String(e).slice(0, 200));
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
        qcPassCount: p.qc_pass_count != null && p.qc_pass_count !== '' ? Number(p.qc_pass_count) : null,
        qcFailCount: p.qc_fail_count != null && p.qc_fail_count !== '' ? Number(p.qc_fail_count) : null,
        submittedAt: p.submitted_at || null,
        submittedByEmail: p.submitted_by_email || null,
        approvedByName: p.approved_by_name || null,
        approvedAt: p.approved_at || null,
        resolutionTimingJson: p.resolution_timing_json || null,
      },
      propertyIdRef,
      propertySquareFootage,
      propertyZip,
      propertyAddressStreet,
      propertyCity,
      propertyStateCode,
      propertyEntityId,
      propertyLastPrimaryTenant,
      propertyLastTenantMonths,
      propertyHbmmId,
      propertyAirFiltersTotal,
      propertyAirFiltersType1,
      propertyAirFiltersType2,
      propertyAirFiltersType3,
      propertySepticFee,
      propertyTeamGroupEmail,
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

// Format a HubSpot date value (epoch-ms string or ISO) to a short M/D/YYYY string.
function formatListingDate(raw: any): string | null {
  if (raw == null || raw === '') return null;
  const s = String(raw);
  const t = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
  if (!isFinite(t) || isNaN(t)) return null;
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

export async function fetchActiveListingForProperty(
  propertyRecordId: string
): Promise<{ listingPrice: number | null; listingDate: string | null } | null> {
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
    const wantProps = ['listing_price', 'listing_date', 'hs_createdate'];
    if (statusProp) wantProps.push(statusProp);
    type Row = { price: number | null; date: any; created: number; status: string };
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
          price,
          date: p.listing_date ?? null,
          created: isNaN(createdMs) ? 0 : createdMs,
          status: statusProp ? String(p[statusProp] ?? '') : '',
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
    return { listingPrice: pick.price, listingDate: formatListingDate(pick.date) };
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
  answerValue: string;
  note: string;
  quantity: number | null;
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

// Whether the `after_photo_urls` property exists on the Answer object yet.
// Cached for the life of the server instance. Used to (a) avoid requesting an
// unknown property in batch reads (HubSpot 400s on those), (b) gate the
// after-photo requirement so the feature is dormant until the migration that
// adds the property has run. Returns false on any uncertainty (fail-safe).
let _afterPhotoPropCache: boolean | null = null;
export async function answerHasAfterPhotoProperty(): Promise<boolean> {
  if (_afterPhotoPropCache !== null) return _afterPhotoPropCache;
  try {
    const { answer } = typeIds();
    await hubspotFetch(`/crm/v3/properties/${answer}/after_photo_urls`);
    _afterPhotoPropCache = true;
  } catch {
    // 404 (not created yet) or any other error → treat as absent.
    _afterPhotoPropCache = false;
  }
  return _afterPhotoPropCache;
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
  let exists = false;
  try {
    const { answer } = typeIds();
    await hubspotFetch(`/crm/v3/properties/${answer}/${encodeURIComponent(name)}`);
    exists = true;
  } catch { exists = false; }
  _answerPropCache.set(name, { exists, at: Date.now() });
  return exists;
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
        answerValue: p.answer_value || '',
        note: p.note || '',
        quantity: p.quantity != null && p.quantity !== '' ? Number(p.quantity) : null,
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
export async function fetchPropertyFieldOptions(fieldName: string): Promise<string[]> {
  const { property: typeId } = typeIds();
  try {
    const resp = await hubspotFetch(`/crm/v3/properties/${typeId}/${encodeURIComponent(fieldName)}`);
    const options = Array.isArray(resp.options) ? resp.options : [];
    return options
      .filter((o: any) => o && o.hidden !== true)
      .map((o: any) => String(o.label ?? o.value ?? '').trim())
      .filter(Boolean);
  } catch (e: any) {
    console.warn(`[fetchPropertyFieldOptions] ${fieldName} unavailable:`, String(e).slice(0, 160));
    return [];
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
  // Why the loop wrote this (sample size, example phrases, catalog code) — shown
  // to admins for context. Auto entries only.
  meta?: Record<string, string | number | string[] | undefined>;
}

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

/** Append a new entry (inspector-submitted). Goes live immediately. */
export async function addKnowledgeEntry(input: { text: string; addedByEmail: string; addedByName?: string }): Promise<AiKnowledgeEntry> {
  const text = (input.text || '').trim();
  if (!text) throw new Error('Empty knowledge text.');
  const entries = await readKnowledgeEntries();
  const entry: AiKnowledgeEntry = {
    id: `kb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text: text.slice(0, 1000),
    addedByEmail: input.addedByEmail || '',
    addedByName: input.addedByName || '',
    createdAt: Date.now(),
  };
  entries.unshift(entry);
  await writeKnowledgeEntries(entries.slice(0, 500)); // hard cap to keep the property small
  return entry;
}

/** Admin: edit an entry's text. Editing an AUTO entry ADOPTS it as admin-owned
 *  so the self-improvement loop won't overwrite the curated wording. */
export async function updateKnowledgeEntry(id: string, text: string): Promise<void> {
  const entries = await readKnowledgeEntries();
  const i = entries.findIndex((e) => e.id === id);
  if (i < 0) throw new Error('Entry not found.');
  const adopt = entries[i].source === 'auto' ? { source: 'admin' as const } : {};
  entries[i] = { ...entries[i], text: (text || '').trim().slice(0, 1000), updatedAt: Date.now(), ...adopt };
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
export async function getKnowledgeBasePromptText(maxChars = 2400): Promise<string> {
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
  const entries = (_kbEntriesCache?.entries || []).filter((e) => e.status !== 'dismissed');
  if (!entries.length) return '';
  const lines = entries.map((e) => `- ${String(e.text).replace(/\s+/g, ' ').trim()}`);
  return lines.join('\n').slice(0, maxChars);
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
    const msg = String(e?.message || e);
    if (msg.includes('PROPERTY_DOESNT_EXIST') || (msg.includes('Property') && msg.includes('does not exist'))) {
      await ensureAppAdminsProperty();
      await doWrite(); // retry once after creating the property
    } else {
      throw e;
    }
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
  const { question, answer } = typeIds();

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

  // Drop the "does this property exist?" caches so the just-provisioned fields
  // are picked up by this warm instance without waiting for a cold start.
  _afterPhotoPropCache = null;
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

  // Client invoice always defaults to 60 (overridden by the agent's value when
  // matched). Vendor invoice stays blank unless the agent provides one.
  update.client_invoice_amount = DEFAULT_CLIENT_INVOICE;

  // Owner → Agent → broker_code + invoice amounts
  let ownerId = (insp.hubspot_owner_id || '').toString().trim();
  if (!ownerId && inspectorEmail) ownerId = (await resolveOwnerIdByEmail(inspectorEmail)) || '';
  if (ownerId) {
    update.hubspot_owner_id = ownerId;
    const agent = await fetchAgentBillingByOwner(ownerId);
    if (agent) {
      update.broker_code = agent.brokerCode || '';
      update.vendor_invoice_amount = agent.vendorCost !== '' ? agent.vendorCost : '';  // blank if null
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
 * inspection. Sums the per-line stored totals (the exact numbers the form + PDFs
 * show), so the inspection object always reflects the current scope — through
 * editing, approval, and finalize. Best-effort on the write (tolerates the
 * properties not existing yet); never throws. Returns the totals + line count.
 *
 * Call after any change to an inspection's rate-card lines (save/archive) and at
 * finalize. `skipIfNoLines` avoids stamping 0 onto non-scope inspections during
 * the backfill (the live save path leaves it false so deleting the last line
 * correctly writes 0).
 */
export async function recomputeInspectionTotals(
  inspectionId: string,
  opts: { skipIfNoLines?: boolean } = {},
): Promise<{ vendor: number; client: number; tenant: number; lineCount: number; wrote: boolean }> {
  const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
  const answers = await fetchAnswersForInspection(inspectionId);
  let vendor = 0, client = 0, tenant = 0, lineCount = 0;
  for (const a of answers) {
    if (a.answerType !== 'rate_card_line' || !a.rateCardLine) continue;
    const rc = a.rateCardLine;
    vendor += round2(Number(rc.vendorCost) || 0);
    client += round2(Number(rc.clientCost) || 0);
    tenant += round2(Number(rc.tenantCost) || 0);
    lineCount++;
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
 */
export async function backfillInspectionTotals(opts: { after?: string; max?: number } = {}): Promise<{ processed: number; updated: number; skipped: number; errors: number; nextAfter: string | null }> {
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
          const out = await recomputeInspectionTotals(r.id, { skipIfNoLines: true });
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

  for (const a of lineAnswers) {
    const rc = a.rateCardLine!;
    const externalId = genId('QCLINE');
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
      custom_labor_rate: rc.customLaborRate != null ? rc.customLaborRate : '',
      custom_adjusted_material_cost: rc.customAdjustedMaterialCost != null ? rc.customAdjustedMaterialCost : '',
      custom_vendor_cost: rc.customVendorCost != null ? rc.customVendorCost : '',
      vendor_cost: rc.vendorCost != null ? rc.vendorCost : '',
      client_cost: rc.clientCost != null ? rc.clientCost : '',
      tenant_cost: rc.tenantCost != null ? rc.tenantCost : '',
      // QC-specific: starts unmarked
      pass_fail: '',
    };
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

  // Number of lines copied (reported to the caller — excludes the seeded
  // section-photo records appended below).
  const lineCount = upserts.length;

  // Seed the QC's per-section "after" photo pools from the carried-over photos.
  for (const entry of afterBySection.values()) {
    upserts.push({
      answerProps: buildSectionPhotoAnswerProps({
        answerIdExternal: genId('QCAFTER'),
        summaryLabel: entry.location || entry.section || 'Section',
        section: entry.section,
        location: entry.location,
        photoUrls: entry.urls,
        photoPhase: 'after',
      }),
      questionHubspotRecordId: null,
    });
  }

  await upsertAnswers(args.qcInspectionId, upserts);
  return lineCount;
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

export async function upsertAnswers(
  inspectionRecordId: string,
  upserts: AnswerUpsert[]
): Promise<Array<{ recordId: string; answerIdExternal: string }>> {
  if (upserts.length === 0) return [];
  const tids = typeIds();

  // Split into creates vs updates
  const toCreate = upserts.filter((u) => !u.recordId);
  const toUpdate = upserts.filter((u) => u.recordId);

  const results: Array<{ recordId: string; answerIdExternal: string }> = [];

  // ----- Updates (PATCH each) -----
  // HubSpot supports batch/update for properties. Use it.
  if (toUpdate.length > 0) {
    for (let i = 0; i < toUpdate.length; i += HUBSPOT_BATCH_LIMIT) {
      const chunk = toUpdate.slice(i, i + HUBSPOT_BATCH_LIMIT);
      const resp = await hubspotFetch(`/crm/v3/objects/${tids.answer}/batch/update`, {
        method: 'POST',
        body: JSON.stringify({
          inputs: chunk.map((u) => ({
            id: u.recordId,
            properties: u.answerProps,
          })),
        }),
      });
      for (const r of resp.results || []) {
        results.push({
          recordId: r.id,
          answerIdExternal: r.properties?.answer_id_external || '',
        });
      }
    }
  }

  // ----- Creates (batch/create) -----
  if (toCreate.length > 0) {
    const newAnswers: Array<{ externalId: string; recordId: string }> = [];
    for (let i = 0; i < toCreate.length; i += HUBSPOT_BATCH_LIMIT) {
      const chunk = toCreate.slice(i, i + HUBSPOT_BATCH_LIMIT);
      const resp = await hubspotFetch(`/crm/v3/objects/${tids.answer}/batch/create`, {
        method: 'POST',
        body: JSON.stringify({
          inputs: chunk.map((u) => ({ properties: u.answerProps })),
        }),
      });
      for (let j = 0; j < (resp.results || []).length; j++) {
        const r = resp.results[j];
        newAnswers.push({
          externalId: r.properties?.answer_id_external || '',
          recordId: r.id,
        });
        results.push({
          recordId: r.id,
          answerIdExternal: r.properties?.answer_id_external || '',
        });
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
      const qaPairs: Array<{ fromId: string; toId: string }> = [];
      for (let j = 0; j < toCreate.length; j++) {
        const qid = toCreate[j].questionHubspotRecordId;
        if (!qid) continue;
        const matchingNewAnswer = newAnswers[j];
        if (!matchingNewAnswer) continue;
        qaPairs.push({ fromId: qid, toId: matchingNewAnswer.recordId });
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
  for (let i = 0; i < answerRecordIds.length; i += HUBSPOT_BATCH_LIMIT) {
    const chunk = answerRecordIds.slice(i, i + HUBSPOT_BATCH_LIMIT);
    await hubspotFetch(`/crm/v3/objects/${typeId}/batch/archive`, {
      method: 'POST',
      body: JSON.stringify({
        inputs: chunk.map((id) => ({ id })),
      }),
    });
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
