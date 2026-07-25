#!/usr/bin/env node
/**
 * live-read.mjs — READ-ONLY HubSpot query helper for in-session diagnostics.
 *
 * A safe way to let a Claude Code session (or anyone) pull live records without
 * opening the app. It performs ONLY reads (GET + /search POST). There are NO
 * create/patch/delete helpers in this file — it cannot mutate data even if asked.
 * The real guardrail, though, is the TOKEN you give it: point it at a HubSpot
 * private-app token scoped to READ ONLY, so a bug (here or anywhere) can never write.
 *
 * ── SECRETS ──────────────────────────────────────────────────────────────────
 * This file contains NO secret. It reads them from the environment at runtime.
 * NEVER hardcode a token here or commit one anywhere. Set them in the Claude Code
 * ENVIRONMENT configuration (same model as Vercel) — not in the repo, not in chat.
 *
 * REQUIRED ENV
 *   HUBSPOT_READONLY_TOKEN   preferred — a READ-scoped private-app token (pat-na1-…)
 *     (falls back to HUBSPOT_TOKEN if the read-only one isn't set)
 *   HUBSPOT_INSPECTION_TYPE_ID
 *   HUBSPOT_INSPECTION_ANSWER_TYPE_ID
 *   HUBSPOT_INSPECTION_QUESTION_TYPE_ID
 *   HUBSPOT_PROPERTY_TYPE_ID           (only needed for `get --type property`)
 *
 * USAGE
 *   node scripts/live-read.mjs photo-gaps --id <inspectionId>
 *       → questions on that inspection that REQUIRE a photo but have none
 *         (mirrors the /api/admin/photo-gaps logic — "which photo did we lose?").
 *   node scripts/live-read.mjs answers --id <inspectionId>
 *       → every answer: question id, value, note, #photos.
 *   node scripts/live-read.mjs get --type inspection|answer|question|property --id <id> [--props a,b,c]
 *       → raw properties of one record.
 *   Add --json to any command for machine-readable output.
 */

// ── args ──
const argv = process.argv.slice(2);
const cmd = argv[0];
const argVal = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const hasFlag = (flag) => argv.includes(flag);
const asJson = hasFlag('--json');

// ── env ──
function need(k) { const v = process.env[k]; if (!v) { console.error(`Missing required env: ${k}`); process.exit(1); } return v; }
const TOKEN = process.env.HUBSPOT_READONLY_TOKEN || process.env.HUBSPOT_TOKEN;
if (!TOKEN) { console.error('Set HUBSPOT_READONLY_TOKEN (a read-scoped pat-na1-… token) in the environment.'); process.exit(1); }
const INSP = need('HUBSPOT_INSPECTION_TYPE_ID');
const ANS = need('HUBSPOT_INSPECTION_ANSWER_TYPE_ID');

const HS = 'https://api.hubapi.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── HubSpot READ fetch (GET or /search POST only) with 429/5xx backoff ──
async function hs(path, init = {}, tries = 6) {
  const method = (init.method || 'GET').toUpperCase();
  // Hard guard: this helper is read-only. Allow GET, and POST only to HubSpot's
  // read endpoints — /search and /batch/read (both return records, never mutate).
  // Refuse anything else (create/patch/delete/batch-update) outright.
  const isRead = method === 'POST' && /\/(search|batch\/read)(\?|$)/.test(path);
  if (method !== 'GET' && !isRead) {
    throw new Error(`live-read is READ-ONLY: refused ${method} ${path}`);
  }
  for (let a = 0; a < tries; a++) {
    const res = await fetch(`${HS}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
    if (res.status === 429 || res.status >= 500) { await sleep(600 * 2 ** a); continue; }
    if (res.status === 204) return null;
    const text = await res.text();
    if (!res.ok) throw new Error(`HubSpot ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }
  throw new Error(`HubSpot ${path} failed after ${tries} retries (429/5xx)`);
}

// ── reads ──
async function getObject(typeId, id, props) {
  const qs = props?.length ? `?properties=${encodeURIComponent(props.join(','))}` : '';
  return hs(`/crm/v3/objects/${typeId}/${id}${qs}`);
}
async function answerIdsForInspection(inspId) {
  const ids = []; let after;
  do {
    const qs = new URLSearchParams({ limit: '500' }); if (after) qs.set('after', after);
    const r = await hs(`/crm/v4/objects/${INSP}/${inspId}/associations/${ANS}?${qs}`);
    for (const x of r.results || []) { const v = x.toObjectId ?? x.id; if (v != null) ids.push(String(v)); }
    after = r.paging?.next?.after;
  } while (after);
  return ids;
}
const ANSWER_PROPS = ['question_id_external', 'answer_value', 'note', 'section', 'location', 'answer_type', 'photo_urls'];
async function readAnswers(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const r = await hs(`/crm/v3/objects/${ANS}/batch/read`, {
      method: 'POST', body: JSON.stringify({ properties: ANSWER_PROPS, inputs: ids.slice(i, i + 100).map((id) => ({ id })) }),
    });
    out.push(...(r.results || []));
  }
  return out;
}
// All enabled question definitions → map question_id_external → props. Answers
// carry question_id_external, so a global map resolves each answer's flags
// (requires_photo / is_required / response_type) without template matching.
async function questionMapByExternalId() {
  const QID = need('HUBSPOT_INSPECTION_QUESTION_TYPE_ID');
  const props = ['question_id_external', 'question_text', 'section', 'requires_photo', 'is_required', 'response_type'];
  const map = new Map();
  let after;
  do {
    const body = { limit: 100, after, properties: props, filterGroups: [] };
    const r = await hs(`/crm/v3/objects/${QID}/search`, { method: 'POST', body: JSON.stringify(body) });
    for (const rec of r.results || []) {
      const p = rec.properties || {};
      if (p.question_id_external) map.set(p.question_id_external, p);
    }
    after = r.paging?.next?.after;
    if (after) await sleep(120);
  } while (after);
  return map;
}

// ── helpers ──
const splitPhotos = (v) => String(v || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
const isNA = (opt) => /^(n\/?a|n\.a\.?|not applicable)\b/.test(String(opt || '').trim().toLowerCase());
const isTrue = (v) => String(v).toLowerCase() === 'true';

// ── commands ──
async function cmdPhotoGaps() {
  const id = argVal('--id');
  if (!id) { console.error('photo-gaps needs --id <inspectionId>'); process.exit(1); }
  const insp = await getObject(INSP, id, ['inspection_name', 'property_address_snapshot', 'template_type', 'status', 'completed_at']);
  const ip = insp?.properties || {};
  const [qMap, answerIds] = await Promise.all([questionMapByExternalId(), answerIdsForInspection(id)]);
  const answers = await readAnswers(answerIds);
  const gaps = [];
  for (const rec of answers) {
    const a = rec.properties || {};
    const q = qMap.get(a.question_id_external);
    if (!q) continue;
    if (splitPhotos(a.photo_urls).length > 0) continue;
    const photoOnlyGap = isTrue(q.is_required) && q.response_type === 'photo_only';
    const requiresPhotoGap = isTrue(q.requires_photo) && !!a.answer_value && !isNA(a.answer_value);
    if (photoOnlyGap || requiresPhotoGap) {
      gaps.push({ question: q.question_text, section: a.section || q.section || '', location: a.location || '', answer: a.answer_value || '' });
    }
  }
  const result = {
    inspectionId: id,
    address: ip.property_address_snapshot || ip.inspection_name || '',
    templateType: ip.template_type || '',
    status: ip.status || '',
    completedAt: ip.completed_at || null,
    gapCount: gaps.length,
    gaps,
  };
  if (asJson) { console.log(JSON.stringify(result, null, 2)); return; }
  console.log(`\n${result.address}  [${result.templateType} · ${result.status}]`);
  console.log(`Inspection ${id}`);
  if (gaps.length === 0) { console.log('✓ No missing required photos.\n'); return; }
  console.log(`\n⚠ ${gaps.length} required photo(s) MISSING:`);
  for (const g of gaps) console.log(`  • ${g.section ? g.section + ' — ' : ''}${g.question}  (answered: ${g.answer || '—'})`);
  console.log('');
}

async function cmdAnswers() {
  const id = argVal('--id');
  if (!id) { console.error('answers needs --id <inspectionId>'); process.exit(1); }
  const answers = await readAnswers(await answerIdsForInspection(id));
  const rows = answers.map((rec) => {
    const a = rec.properties || {};
    return { question_id_external: a.question_id_external, type: a.answer_type, section: a.section, location: a.location, value: a.answer_value, note: a.note, photos: splitPhotos(a.photo_urls).length };
  });
  if (asJson) { console.log(JSON.stringify(rows, null, 2)); return; }
  for (const r of rows) console.log(`${String(r.photos).padStart(2)}📷  ${r.section || ''}${r.location ? '/' + r.location : ''}  ${r.value || '—'}  [${r.question_id_external}]`);
}

async function cmdGet() {
  const type = argVal('--type');
  const id = argVal('--id');
  const props = (argVal('--props') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const map = { inspection: INSP, answer: ANS, question: process.env.HUBSPOT_INSPECTION_QUESTION_TYPE_ID, property: process.env.HUBSPOT_PROPERTY_TYPE_ID };
  const typeId = map[type];
  if (!typeId || !id) { console.error('get needs --type inspection|answer|question|property and --id <id> (and the matching TYPE_ID env)'); process.exit(1); }
  const rec = await getObject(typeId, id, props.length ? props : undefined);
  console.log(JSON.stringify(rec?.properties ?? rec, null, 2));
}

const commands = { 'photo-gaps': cmdPhotoGaps, answers: cmdAnswers, get: cmdGet };
const run = commands[cmd];
if (!run) {
  console.error('Usage: node scripts/live-read.mjs <photo-gaps|answers|get> [--id <id>] [--type <t>] [--props a,b] [--json]');
  process.exit(1);
}
run().catch((e) => { console.error(String(e?.message || e)); process.exit(1); });
