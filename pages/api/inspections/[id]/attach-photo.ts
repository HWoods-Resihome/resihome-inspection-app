/**
 * POST /api/inspections/[id]/attach-photo
 *
 * Attach an already-uploaded photo URL to its record, server-side and
 * IDEMPOTENTLY — so a photo can land on the section/line record in the
 * background (from any page, or a device that holds the queue) without the
 * inspection form being open. Driven by the durable photo-attach outbox
 * (lib/photoAttachOutbox) which the global background sync replays.
 *
 * Body: { url, replacesUrl?, target: { kind: 'section'|'line', externalId,
 *         field: 'photo_urls'|'after_photo_urls', section?, location?, summaryLabel? } }
 *
 * Idempotent by construction:
 *  - reads the CURRENT record and appends the URL only if missing (dedupe),
 *  - upsertAnswers dedupes creates by answer_id_external (no duplicate records),
 *  so the form's live attach + this replay (and retries) converge to one result.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { externalWriteDenial } from '@/lib/inspectionGuard';
import { fetchAnswersForInspection, upsertAnswers } from '@/lib/hubspot';
import { buildSectionPhotoAnswerProps, joinPhotoUrls } from '@/lib/answerProps';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const { id } = req.query;
  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'Missing inspection id' });

  const denial = await externalWriteDenial(session.email, id);
  if (denial) return res.status(403).json({ error: denial });

  const url = String(req.body?.url || '').trim();
  const replacesUrl = String(req.body?.replacesUrl || '').trim();
  const target = req.body?.target || {};
  const kind = target.kind === 'section' ? 'section' : target.kind === 'line' ? 'line' : target.kind === 'fc' ? 'fc' : '';
  const externalId = String(target.externalId || '').trim();
  const field = target.field === 'after_photo_urls' ? 'after_photo_urls' : 'photo_urls';
  const fcSlot = String(target.fcSlot || '').trim();
  if (!url || url.startsWith('blob:')) return res.status(400).json({ error: 'A real (uploaded) url is required.' });
  if (!kind || !externalId) return res.status(400).json({ error: 'target.kind and target.externalId are required.' });

  // Compute the next URL list: replace the original (annotation) if present, else
  // append — but only if not already there (dedupe → idempotent).
  const nextList = (current: string[]): string[] | null => {
    if (replacesUrl && current.includes(replacesUrl)) {
      const swapped = Array.from(new Set(current.map((u) => (u === replacesUrl ? url : u))));
      return JSON.stringify(swapped) === JSON.stringify(current) ? null : swapped; // null = no change
    }
    if (current.includes(url)) return null; // already attached — idempotent no-op
    return [...current, url];
  };

  try {
    const answers = await fetchAnswersForInspection(id);
    const existing = answers.find((a) => a.answerIdExternal === externalId);

    if (kind === 'fc') {
      // Append the URL to one slot inside the Final Checklist JSON blob. APPEND-
      // ONLY + abort if the JSON won't parse, so a background write can never wipe
      // checklist state. (The open form is the sole writer of an active inspection
      // — the background driver skips active ones — so there's no concurrent write.)
      const rec = existing || answers.find((a) => a.questionIdExternal === 'fc__all' || a.answerIdExternal.startsWith('FINALCHECKLIST-'));
      if (!rec) return res.status(200).json({ ok: true, deferred: true, reason: 'fc blob not found yet' });
      const [qid, slotKey] = fcSlot.split(':');
      if (!qid || !slotKey) return res.status(400).json({ error: 'fcSlot must be "<qid>:<key>".' });
      let blob: any;
      try { blob = JSON.parse(rec.note || '{}'); } catch { return res.status(200).json({ ok: false, error: 'FC blob unparseable — left untouched.' }); }
      if (!blob || typeof blob !== 'object') return res.status(200).json({ ok: false, error: 'FC blob not an object.' });
      const ans = { ...(blob[qid] || {}) };
      if (slotKey === 'photo') {
        const arr = Array.isArray(ans.photoUrls) ? ans.photoUrls : [];
        if (replacesUrl && arr.includes(replacesUrl)) ans.photoUrls = Array.from(new Set(arr.map((u: string) => (u === replacesUrl ? url : u))));
        else if (arr.includes(url)) return res.status(200).json({ ok: true, alreadyAttached: true });
        else ans.photoUrls = [...arr, url];
      } else {
        const sp = { ...(ans.stickerPhotos || {}) };
        const arr = Array.isArray(sp[slotKey]) ? sp[slotKey] : [];
        if (replacesUrl && arr.includes(replacesUrl)) sp[slotKey] = Array.from(new Set(arr.map((u: string) => (u === replacesUrl ? url : u))));
        else if (arr.includes(url)) return res.status(200).json({ ok: true, alreadyAttached: true });
        else sp[slotKey] = [...arr, url];
        ans.stickerPhotos = sp;
      }
      blob[qid] = ans;
      const results = await upsertAnswers(id, [{ recordId: rec.recordId, answerProps: { answer_id_external: rec.answerIdExternal, note: JSON.stringify(blob) } }]);
      const failed = results.find((r) => r.failed);
      if (failed) return res.status(502).json({ ok: false, error: failed.reason || 'fc attach failed' });
      return res.status(200).json({ ok: true });
    }

    if (kind === 'line') {
      if (!existing) {
        // The line record should exist (the line was saved). If it's genuinely
        // not there yet, defer — the form will attach on next open. Not an error.
        return res.status(200).json({ ok: true, deferred: true, reason: 'line record not found yet' });
      }
      const cur = field === 'after_photo_urls' ? (existing.afterPhotoUrls || []) : (existing.photoUrls || []);
      const next = nextList(cur);
      if (!next) return res.status(200).json({ ok: true, alreadyAttached: true });
      const results = await upsertAnswers(id, [{
        recordId: existing.recordId,
        answerProps: { answer_id_external: externalId, [field]: joinPhotoUrls(next) },
      }]);
      const failed = results.find((r) => r.failed);
      if (failed) return res.status(502).json({ ok: false, error: failed.reason || 'attach failed' });
      return res.status(200).json({ ok: true });
    }

    // kind === 'section'
    const cur = existing ? (existing.photoUrls || []) : [];
    const next = nextList(cur);
    if (existing && !next) return res.status(200).json({ ok: true, alreadyAttached: true });
    const photoUrls = next || [url];
    const props = buildSectionPhotoAnswerProps({
      answerIdExternal: externalId,
      section: String(target.section || existing?.section || ''),
      summaryLabel: String(target.summaryLabel || target.section || existing?.section || ''),
      location: target.location != null ? String(target.location) : (existing?.location || null),
      photoUrls,
    });
    const results = await upsertAnswers(id, [{
      recordId: existing?.recordId,           // PATCH if it exists; else CREATE (upsertAnswers dedupes by external id)
      answerProps: props,
      questionHubspotRecordId: null,
    }]);
    const failed = results.find((r) => r.failed);
    if (failed) return res.status(502).json({ ok: false, error: failed.reason || 'attach failed' });
    return res.status(200).json({ ok: true, created: !existing });
  } catch (e: any) {
    console.error(`[attach-photo] ${id} failed:`, e);
    const upstream = (e as any)?.status;
    const status = (typeof upstream === 'number' && upstream >= 400 && upstream < 500 && upstream !== 429) ? upstream : 500;
    return res.status(status).json({ ok: false, error: String(e?.message || e).slice(0, 300) });
  }
}
