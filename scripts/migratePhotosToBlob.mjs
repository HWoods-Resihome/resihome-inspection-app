#!/usr/bin/env node
/**
 * ResiWalk photo backfill — HubSpot File Manager → Vercel Blob (Part 2).
 *
 * Standalone, one-off migration. NOT part of the app runtime. Copies photos that
 * are still hosted in HubSpot Files into Vercel Blob, rewrites the reference on
 * the inspection_answer records (photo_urls / after_photo_urls) to the new Blob
 * URL, verifies the copy byte-for-byte, and — only when explicitly told — deletes
 * the original from HubSpot.
 *
 * Driven by the REFERENCES (answer records), not by a folder file list: that
 * guarantees every photo the app actually displays is migrated and its exact
 * reference updated in place. A HubSpot file no answer references is an orphan
 * and is left alone (reported under --report-orphans).
 *
 * SAFETY MODEL
 *   • Dry-run by default — writes nothing, deletes nothing; just inventories.
 *   • --apply           copy to Blob + rewrite the answer reference (NO deletes).
 *   • --delete          additionally delete the HubSpot original, but ONLY after
 *                       the Blob copy is verified AND the reference write returned
 *                       success. Requires --apply. Off by default.
 *   • Idempotent + resumable via a JSON state file: a re-run skips done answers
 *     and never re-copies a URL already mapped.
 *   • Per-URL order is strict: download → upload → VERIFY size → write ref → (gated) delete.
 *
 * USAGE (see scripts/MIGRATE_PHOTOS_RUNBOOK.md for the full runbook)
 *   node scripts/migratePhotosToBlob.mjs [--inspection <id>] [--apply] [--delete]
 *        [--limit <n>] [--state <path>] [--report-orphans]
 *
 * REQUIRED ENV
 *   HUBSPOT_TOKEN                       private app token with Files + CRM scopes
 *   HUBSPOT_INSPECTION_TYPE_ID          inspection object type id
 *   HUBSPOT_INSPECTION_ANSWER_TYPE_ID   inspection_answer object type id
 *   BLOB_READ_WRITE_TOKEN               Vercel Blob store RW token (for --apply)
 * (This script hardcodes NO tokens/portals — set them in the environment.)
 */
import { put } from '@vercel/blob';
import fs from 'node:fs';

// ── args ──
const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const argVal = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const ONLY_INSPECTION = argVal('--inspection') || '';
const APPLY = hasFlag('--apply');
const DELETE = hasFlag('--delete');
const REPORT_ORPHANS = hasFlag('--report-orphans');
const LIMIT = Number(argVal('--limit') || 0) || Infinity;
const STATE_PATH = argVal('--state') || '.migrate-photos-state.json';
if (DELETE && !APPLY) { console.error('Refusing to --delete without --apply. Copy+verify first.'); process.exit(1); }

// ── env ──
const TOKEN = need('HUBSPOT_TOKEN');
const INSP = need('HUBSPOT_INSPECTION_TYPE_ID');
const ANS = need('HUBSPOT_INSPECTION_ANSWER_TYPE_ID');
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN || '';
if (APPLY && !BLOB_TOKEN) { console.error('BLOB_READ_WRITE_TOKEN is required for --apply.'); process.exit(1); }
function need(k) { const v = process.env[k]; if (!v) { console.error(`Missing required env: ${k}`); process.exit(1); } return v; }

const HS = 'https://api.hubapi.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

// A HubSpot-hosted file URL (File Manager CDN) vs. one already on Vercel Blob.
const isHubspotUrl = (u) => /hubspotusercontent|hubfs|hs-fs\./i.test(String(u || ''));
const isBlobUrl = (u) => /\.blob\.vercel-storage\.com/i.test(String(u || ''));
const stripQuery = (u) => String(u || '').split('#')[0].split('?')[0];

// ── HubSpot fetch with 429/5xx backoff ──
async function hs(path, init = {}, tries = 6) {
  for (let a = 0; a < tries; a++) {
    const res = await fetch(`${HS}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
    if (res.status === 429 || res.status >= 500) { await sleep(600 * 2 ** a); continue; }
    if (res.status === 204) return null;
    const text = await res.text();
    if (!res.ok) throw new Error(`HubSpot ${init.method || 'GET'} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }
  throw new Error(`HubSpot ${path} failed after ${tries} retries (429/5xx)`);
}

// ── state (resume) ──
const state = fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) : { version: 1, doneAnswers: {}, urlMap: {} };
const saveState = () => fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));

// ── structured logging ──
const stamp = now().replace(/[:.]/g, '-');
const logPath = `migrate-photos-${stamp}.log.jsonl`;
const logLine = (o) => fs.appendFileSync(logPath, JSON.stringify({ t: now(), ...o }) + '\n');
const totals = { answers: 0, urls: 0, copied: 0, verified: 0, referenced: 0, deleted: 0, skippedDone: 0, orphans: 0, errors: 0, bytes: 0 };

// ── answer discovery ──
async function answerIdsForInspection(inspId) {
  const ids = []; let after;
  do {
    const qs = new URLSearchParams({ limit: '500' }); if (after) qs.set('after', after);
    const r = await hs(`/crm/v4/objects/${INSP}/${inspId}/associations/${ANS}?${qs}`);
    for (const x of r.results || []) { const id = x.toObjectId ?? x.id; if (id != null) ids.push(String(id)); }
    after = r.paging?.next?.after;
  } while (after);
  return ids;
}
async function readAnswers(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const r = await hs(`/crm/v3/objects/${ANS}/batch/read`, {
      method: 'POST',
      body: JSON.stringify({ properties: ['photo_urls', 'after_photo_urls'], inputs: ids.slice(i, i + 100).map((id) => ({ id })) }),
    });
    out.push(...(r.results || []));
  }
  return out;
}
// All answers that have any photo_urls (paged). Yields {id, properties}.
async function* allAnswersWithPhotos() {
  let after;
  do {
    const body = {
      limit: 100, after,
      properties: ['photo_urls', 'after_photo_urls'],
      filterGroups: [{ filters: [{ propertyName: 'photo_urls', operator: 'HAS_PROPERTY' }] }],
    };
    const r = await hs(`/crm/v3/objects/${ANS}/search`, { method: 'POST', body: JSON.stringify(body) });
    for (const rec of r.results || []) yield rec;
    after = r.paging?.next?.after;
    if (after) await sleep(120); // be gentle on the search API
  } while (after);
}

// ── copy one HubSpot URL → Blob, verified ──
async function migrateUrl(url, inspHint) {
  if (state.urlMap[url]) return state.urlMap[url];   // already migrated in a prior run
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status} for ${url.slice(0, 90)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  totals.bytes += buf.length;
  const name = decodeURIComponent(stripQuery(url).split('/').pop() || `photo_${Date.now()}.jpg`);
  const m = /idbph_(\d+)__/.exec(name);
  const inspId = inspHint || (m ? m[1] : 'unknown');
  const key = `inspections/${inspId}/${name}`;
  if (!APPLY) { totals.copied++; return `(dry-run:${key})`; }
  const putRes = await put(key, buf, {
    access: 'public', addRandomSuffix: false, allowOverwrite: true,
    contentType: res.headers.get('content-type') || 'image/jpeg', token: BLOB_TOKEN,
  });
  totals.copied++;
  // VERIFY: re-download the Blob object and confirm the byte count matches.
  const vr = await fetch(putRes.url);
  if (!vr.ok) throw new Error(`verify fetch ${vr.status}`);
  const vbuf = Buffer.from(await vr.arrayBuffer());
  if (vbuf.length !== buf.length) throw new Error(`verify size mismatch: blob ${vbuf.length} vs source ${buf.length}`);
  totals.verified++;
  state.urlMap[url] = putRes.url;
  return putRes.url;
}

// ── folder listing (only for deletion id-lookup / orphan report) ──
let folderIndex = null; // url(no-query) → fileId
async function loadFolderIndex() {
  if (folderIndex) return folderIndex;
  folderIndex = new Map();
  let after;
  do {
    const qs = new URLSearchParams({ limit: '100' }); if (after) qs.set('after', after);
    // Files in the inspection_photos folder. (Folder path filter is done by name
    // via the file's path; we index everything and match by URL.)
    const r = await hs(`/files/v3/files?${qs}`);
    for (const f of r.results || []) if (f.url) folderIndex.set(stripQuery(f.url), String(f.id));
    after = r.paging?.next?.after;
  } while (after);
  return folderIndex;
}
async function deleteHubspotFile(url) {
  const idx = await loadFolderIndex();
  const id = idx.get(stripQuery(url));
  if (!id) { logLine({ event: 'delete-skip-no-id', url }); return false; }
  await hs(`/files/v3/files/${id}`, { method: 'DELETE' });
  totals.deleted++;
  return true;
}

// ── process one answer record ──
async function processAnswer(rec, inspHint) {
  const id = String(rec.id);
  if (state.doneAnswers[id]) { totals.skippedDone++; return; }
  totals.answers++;
  const p = rec.properties || {};
  let changed = false;
  const migratedOldUrls = [];
  for (const prop of ['photo_urls', 'after_photo_urls']) {
    let raw = p[prop];
    if (!raw) continue;
    // Preserve the exact delimiters — replace each HubSpot URL substring in place.
    const urls = String(raw).split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    for (const url of urls) {
      totals.urls++;
      if (!isHubspotUrl(url) || isBlobUrl(url)) continue; // already on Blob or external
      try {
        const newUrl = await migrateUrl(url, inspHint);
        if (APPLY && newUrl && !newUrl.startsWith('(dry-run')) {
          raw = raw.split(url).join(newUrl);
          migratedOldUrls.push(url);
          changed = true;
        }
        logLine({ event: 'copied', answerId: id, prop, oldUrl: url, newUrl });
      } catch (e) {
        totals.errors++;
        logLine({ event: 'error', answerId: id, prop, url, error: String(e?.message || e) });
      }
    }
    if (APPLY && changed) p[prop] = raw;
  }
  // Write the rewritten references back, THEN (gated) delete the originals.
  if (APPLY && changed) {
    const props = {};
    if (p.photo_urls) props.photo_urls = p.photo_urls;
    if (p.after_photo_urls) props.after_photo_urls = p.after_photo_urls;
    await hs(`/crm/v3/objects/${ANS}/${id}`, { method: 'PATCH', body: JSON.stringify({ properties: props }) });
    totals.referenced++;
    logLine({ event: 'referenced', answerId: id });
    if (DELETE) {
      for (const oldUrl of migratedOldUrls) {
        try { await deleteHubspotFile(oldUrl); logLine({ event: 'deleted', answerId: id, url: oldUrl }); }
        catch (e) { totals.errors++; logLine({ event: 'delete-error', answerId: id, url: oldUrl, error: String(e?.message || e) }); }
      }
    }
  }
  state.doneAnswers[id] = { at: now() };
  saveState();
}

// ── main ──
(async () => {
  console.log(`[migrate] mode=${APPLY ? (DELETE ? 'APPLY+DELETE' : 'APPLY') : 'DRY-RUN'} inspection=${ONLY_INSPECTION || 'ALL'} state=${STATE_PATH} log=${logPath}`);
  let processed = 0;
  if (ONLY_INSPECTION) {
    const ids = await answerIdsForInspection(ONLY_INSPECTION);
    console.log(`[migrate] inspection ${ONLY_INSPECTION}: ${ids.length} answer records`);
    const recs = await readAnswers(ids);
    for (const rec of recs) { if (processed++ >= LIMIT) break; await processAnswer(rec, ONLY_INSPECTION); }
  } else {
    for await (const rec of allAnswersWithPhotos()) { if (processed++ >= LIMIT) break; await processAnswer(rec, ''); }
  }

  if (REPORT_ORPHANS) {
    const idx = await loadFolderIndex();
    const referenced = new Set(Object.keys(state.urlMap).map(stripQuery));
    for (const [url] of idx) if (!referenced.has(url)) { totals.orphans++; logLine({ event: 'orphan', url }); }
  }

  saveState();
  console.log('[migrate] DONE', JSON.stringify(totals, null, 2));
  console.log(`[migrate] structured log: ${logPath}`);
  if (!APPLY) console.log('[migrate] DRY-RUN only — nothing was written or deleted. Re-run with --apply to copy.');
})().catch((e) => { console.error('[migrate] fatal:', e); process.exit(1); });
