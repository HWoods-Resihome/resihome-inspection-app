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

async function hubspotFetch(path: string, init: RequestInit = {}): Promise<any> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot ${init.method || 'GET'} ${path} failed ${res.status}: ${text.slice(0, 500)}`);
  }
  if (res.status === 204) return null;
  return res.json();
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
    'address', 'city', 'state', 'zip',
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
      const zip = p.zip || '';
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
    'hs_createdate',
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
        totalQuestionsAnswered: p.total_questions_answered != null && p.total_questions_answered !== ''
          ? Number(p.total_questions_answered)
          : null,
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
 */
export async function uploadFile(
  buffer: Buffer,
  filename: string,
  contentType: string,
  folderPath: string = '/inspection_photos'
): Promise<string> {
  const url = `${API_BASE}/files/v3/files`;
  const form = new FormData();
  const blob = new Blob([buffer], { type: contentType });
  form.append('file', blob, filename);
  form.append('options', JSON.stringify({
    access: 'PUBLIC_INDEXABLE',
    overwrite: false,
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
