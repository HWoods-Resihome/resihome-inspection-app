// HubSpot API client. SERVER-SIDE ONLY -- never import in client code.

import type { Question, Property, HubSpotUser, InspectionSummary } from './types';

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
  const raw = process.env.HUBSPOT_SANDBOX_TOKEN;
  if (!raw) {
    throw new Error(
      'HUBSPOT_SANDBOX_TOKEN is not set. Check .env.local exists in the project root ' +
      'and contains the line HUBSPOT_SANDBOX_TOKEN=pat-na1-... then restart `npm run dev`.'
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

function typeIds() {
  const inspection = process.env.HUBSPOT_INSPECTION_TYPE_ID;
  const question = process.env.HUBSPOT_INSPECTION_QUESTION_TYPE_ID;
  const answer = process.env.HUBSPOT_INSPECTION_ANSWER_TYPE_ID;
  const property = process.env.HUBSPOT_PROPERTY_TYPE_ID;
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
  const envLineItem = process.env.HUBSPOT_RATE_CARD_LINE_ITEM_TYPE_ID;
  const envRegionRate = process.env.HUBSPOT_REGION_RATE_TYPE_ID;
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

  // Retry on 429 (rate limit) with exponential backoff. HubSpot's secondly
  // limit (~10 req/sec) can be hit when paginating the 853-row catalog or
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
    if (!res.ok) {
      const text = await res.text();
      lastError = new Error(`HubSpot ${method} ${path} failed ${res.status}: ${text.slice(0, 500)}`);
      throw lastError;
    }
    if (res.status === 204) return null;
    return res.json();
  }

  // All retries exhausted on 429
  throw lastError || new Error(`HubSpot ${method} ${path} failed after retries (429)`);
}

export async function fetchQuestionsForTemplate(
  template: string,
  opts: { debug?: boolean } = {}
): Promise<{ questions: Question[]; debug?: any }> {
  const { question: typeId } = typeIds();
  const properties = [
    'question_id_external', 'question_text', 'section', 'section_order',
    'display_order', 'response_type', 'response_options', 'default_value',
    'note_required_on_values', 'has_assigned_to', 'assigned_to_options',
    'repeats_per_room_type', 'applies_to_templates', 'is_required', 'help_text',
  ];

  const out: Question[] = [];
  const debugAll: any[] = [];
  const debugSkipped: any[] = [];
  let after: string | undefined = undefined;
  do {
    const body: any = {
      filterGroups: [],
      properties,
      limit: 100,
      // Exclude archived records explicitly. HubSpot's default is already to
      // exclude archived from search, but being explicit prevents accidents.
    };
    if (after) body.after = after;
    const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search?archived=false`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
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

export async function fetchProperties(): Promise<Property[]> {
  const { property: typeId } = typeIds();
  // Standard HubSpot fields + your confirmed bedrooms/bathrooms field names.
  // Anything not on your object is silently ignored by HubSpot.
  const candidateProps = [
    'hs_object_id', 'name',
    // The postal field is `zip_code` on this object (with legacy `zip` as a
    // fallback). Requesting only `zip` is why new inspections lost the zip in
    // their address snapshot. Mirror the PDF-header logic in fetchInspection*.
    'address', 'city', 'state', 'zip', 'zip_code',
    'bedrooms', 'bathrooms',
  ];

  const out: Property[] = [];
  let after: string | undefined = undefined;
  do {
    const body: any = { filterGroups: [], properties: candidateProps, limit: 100 };
    if (after) body.after = after;
    const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    for (const r of resp.results || []) {
      const p = r.properties || {};
      const address = p.address || '';
      const city = p.city || '';
      const state = p.state || '';
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
        bedrooms,
        bathrooms,
      });
    }
    after = resp.paging?.next?.after;
  } while (after);

  out.sort((a, b) => a.name.localeCompare(b.name));
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
  const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search`, {
    method: 'POST',
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: 'hs_object_id', operator: 'EQ', value: recordId }] }],
      properties: ['latitude', 'longitude', 'lat', 'lng', 'lon'],
      limit: 1,
    }),
  });
  const p = resp.results?.[0]?.properties || {};
  const lat = Number(p.latitude ?? p.lat);
  const lng = Number(p.longitude ?? p.lng ?? p.lon);
  // Treat 0,0 (the null island) as "not set" — it's never a real US property.
  if (isFinite(lat) && isFinite(lng) && (lat !== 0 || lng !== 0)) return { lat, lng };
  return null;
}

/**
 * Fetch all Inspection records for the list view (Round A).
 * Returns lightweight summary records sorted by most-recent-first.
 *
 * Sort priority: scheduled_date if set, else completed_at, else createdate (HubSpot built-in).
 */
export async function fetchInspections(): Promise<InspectionSummary[]> {
  const { inspection: typeId } = typeIds();
  const properties = [
    'inspection_id_external', 'inspection_name', 'template_type', 'status',
    'property_address_snapshot', 'inspector_name', 'inspector_email',
    'bedrooms_at_inspection', 'bathrooms_at_inspection',
    'started_at', 'completed_at', 'scheduled_date',
    'total_questions_answered',
    'pdf_attachment_url',
    'hs_createdate',
    'last_edited_at', 'hs_lastmodifieddate',
  ];

  const out: InspectionSummary[] = [];
  let after: string | undefined = undefined;
  let pages = 0;
  do {
    const body: any = {
      filterGroups: [],
      properties,
      limit: 100,
      sorts: [{ propertyName: 'hs_createdate', direction: 'DESCENDING' }],
    };
    if (after) body.after = after;
    const resp = await hubspotFetch(`/crm/v3/objects/${typeId}/search?archived=false`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    for (const r of resp.results || []) {
      const p = r.properties || {};
      out.push({
        recordId: r.id,
        inspectionIdExternal: p.inspection_id_external || '',
        inspectionName: p.inspection_name || `(Inspection ${r.id})`,
        templateType: p.template_type || '',
        status: p.status || '',
        propertyAddressSnapshot: p.property_address_snapshot || '',
        inspectorName: p.inspector_name || '',
        inspectorEmail: p.inspector_email || '',
        bedroomsAtInspection: p.bedrooms_at_inspection != null && p.bedrooms_at_inspection !== ''
          ? Number(p.bedrooms_at_inspection)
          : null,
        bathroomsAtInspection: p.bathrooms_at_inspection != null && p.bathrooms_at_inspection !== ''
          ? Number(p.bathrooms_at_inspection)
          : null,
        startedAt: p.started_at || null,
        completedAt: p.completed_at || null,
        scheduledDate: p.scheduled_date || null,
        createdAt: p.hs_createdate || null,
        updatedAt: p.last_edited_at || p.hs_lastmodifieddate || null,
        totalQuestionsAnswered: p.total_questions_answered != null && p.total_questions_answered !== ''
          ? Number(p.total_questions_answered)
          : null,
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
      });
    }
    after = resp.paging?.next?.after;
    pages++;
    // Cap at 5 pages = 500 inspections for now. Above this we'd need pagination/infinite scroll.
    if (pages >= 5) break;
  } while (after);

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

  const [inspToAnswer, qToAnswer, inspToProperty] = await Promise.all([
    getAssociationTypeId(tids.inspection, tids.answer, 'Answer of'),
    getAssociationTypeId(tids.question, tids.answer, 'Answer to'),
    getAssociationTypeId(tids.inspection, tids.property, 'Property'),
  ]);

  const inspectionId = await createInspection(input.inspectionProps);
  const answerResults = await createAnswers(input.answersProps.map((a) => a.answerProps));

  // Inspection -> Property (single pair via batch endpoint, since v4 single PUT
  // is deprecated and the date-based labeled-single PUT pattern is verbose).
  if (inspToProperty != null) {
    const result = await batchCreateAssociations(
      tids.inspection, tids.property, inspToProperty,
      [{ fromId: inspectionId, toId: input.propertyRecordId }],
    );
    if (result.failed > 0) console.warn(`Inspection->Property association failed`);
  }

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
    if (propertyIdRef) {
      try {
        const propProps = [
          'square_footage', 'zip', 'zip_code',
          'address', 'city', 'state_code',
          'entity_id', 'last_primary_tenant',
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
      },
      propertyIdRef,
      propertySquareFootage,
      propertyZip,
      propertyAddressStreet,
      propertyCity,
      propertyStateCode,
      propertyEntityId,
      propertyLastPrimaryTenant,
    };
  } catch (e: any) {
    if (String(e).includes('404')) return null;
    throw e;
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
  // QC Turn Re-Inspect: per-line result ('pass'|'fail'|'') and photo phase
  // ('after' for QC after-photos). Empty/absent on non-QC answers.
  passFail?: 'pass' | 'fail' | '';
  photoPhase?: string;
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

export async function fetchAnswersForInspection(inspectionRecordId: string): Promise<SavedAnswer[]> {
  const tids = typeIds();
  // Step 1: read the associations to find linked Answer record IDs
  const assocResp = await hubspotFetch(
    `/crm/associations/${HUBSPOT_API_VERSION}/${tids.inspection}/${tids.answer}/batch/read`,
    {
      method: 'POST',
      body: JSON.stringify({ inputs: [{ id: inspectionRecordId }] }),
    }
  );
  const answerIds: string[] = [];
  for (const r of assocResp.results || []) {
    for (const t of r.to || []) {
      if (t.toObjectId) answerIds.push(String(t.toObjectId));
      else if (t.id) answerIds.push(String(t.id));
    }
  }
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
        passFail: (p.pass_fail === 'pass' || p.pass_fail === 'fail') ? p.pass_fail : '',
        photoPhase: p.photo_phase || '',
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
export async function updateInspection(recordId: string, props: Record<string, any>): Promise<void> {
  const { inspection: typeId } = typeIds();
  await hubspotFetch(`/crm/v3/objects/${typeId}/${recordId}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties: props }),
  });
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
  const tids = typeIds();
  const inspToProperty = await getAssociationTypeId(tids.inspection, tids.property, 'Property');

  const inspectionId = await createInspection(args.inspectionProps);

  if (inspToProperty != null) {
    await batchCreateAssociations(
      tids.inspection, tids.property, inspToProperty,
      [{ fromId: inspectionId, toId: args.propertyRecordId }],
    );
  }

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

  const upserts: AnswerUpsert[] = lineAnswers.map((a) => {
    const rc = a.rateCardLine!;
    const externalId = `QCLINE-${args.qcInspectionId}-${(typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).slice(2, 12)}`;
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
    return { answerProps: props, questionHubspotRecordId: null };
  });

  await upsertAnswers(args.qcInspectionId, upserts);
  return upserts.length;
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
      const assocResult = await batchCreateAssociations(
        tids.inspection, tids.answer, inspToAnswer,
        newAnswers.map((a) => ({ fromId: inspectionRecordId, toId: a.recordId })),
      );
      if (assocResult.ok === 0 && newAnswers.length > 0) {
        throw new Error(
          `Created ${newAnswers.length} answer record(s) but FAILED to associate any ` +
          `to the inspection — they would be invisible on reopen. Aborting so the issue ` +
          `is visible rather than causing silent data loss.`
        );
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
        await batchCreateAssociations(tids.question, tids.answer, qToAnswer, qaPairs);
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
 * Fetch all active rate_card_line_item records (the 853-item catalog).
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
    // Throttle pagination: HubSpot's secondly limit is ~10 req/sec across the
    // whole portal. With 9 pages of 100 items in this catalog, blasting them
    // back-to-back can blow the limit if any other request is concurrent.
    // 150ms = ~6 req/sec max, leaving headroom.
    if (after) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
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
