/**
 * GET /api/admin/regenerate-inspection-pdfs
 *
 * Re-renders the Q&A inspection PDF (the reworked summary + detail look) IN PLACE
 * for the 1099 Leasing Agent, Vacancy/Occupancy, and Community/Visit templates,
 * reading saved answers from HubSpot. Use this to retrofit the new design onto
 * existing inspections.
 *
 *   ?id=<recordId>   regenerate a single inspection (quick validation)
 *   (no id)          regenerate all recent COMPLETED inspections of the three
 *                    templates; ?limit=N caps how many (default 50).
 *
 * Admin-gated (@resihome.com). Best-effort per inspection; returns a per-id log.
 *
 * NOTE: the "Maintenance Ticket" highlight only shows when the ticket request was
 * captured at submit time; it isn't reconstructable here, so regenerated PDFs may
 * show "No" even if a ticket was raised. The pass/fail summary + details + clickable
 * photos all reproduce correctly.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { renderToBuffer } from '@react-pdf/renderer';
import React from 'react';
import { getSessionFromRequest } from '@/lib/auth';
import { InspectionPdf, type PdfData, type PdfAnswer } from '@/lib/pdf';
import {
  fetchInspections, fetchInspectionWithPropertyRef, fetchAnswersForInspection,
  fetchQuestionsForTemplate, fetchActiveListingForProperty, uploadFileWithId, attachPdfUrlToInspection,
  updateInspection,
} from '@/lib/hubspot';
import { buildShortLink } from '@/lib/shortLinks';
import { resolveImagesInParallel } from '@/lib/pdf-images';
import { getPosterUrl } from '@/lib/media';
import { templateLabel as templateLabelFor } from '@/lib/templateLabels';
import { summarizeFinalChecklist, finalChecklistPhotos, type FcAnswers, type FcCompletionCtx } from '@/lib/finalChecklist';

// Strip a trailing "__<hash>" so an answer's question id matches the template's
// question id even when one carries the uniqueness suffix and the other doesn't.
const normQid = (s: string) => (s || '').replace(/__[0-9a-f]{4,}$/i, '');
// Last-resort readable label from a question id slug (drops section prefix + hash).
function prettifyQid(qid: string): string {
  const parts = (qid || '').split('__');
  const core = parts.length >= 2 ? parts[1] : (parts[0] || qid);
  return core.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const TEMPLATES = new Set([
  'leasing_agent_1099_property_inspection',
  'pm_vacancy_occupancy_check',
  'pm_community_inspection',
]);

export const config = { maxDuration: 300 };

async function regenerateOne(id: string, origin?: string): Promise<{ id: string; ok: boolean; pdfUrl?: string; error?: string }> {
  const data = await fetchInspectionWithPropertyRef(id);
  if (!data) return { id, ok: false, error: 'Inspection not found' };
  const insp = data.inspection;
  const tmpl = insp.templateType;
  if (!TEMPLATES.has(tmpl)) return { id, ok: false, error: `Template ${tmpl} not supported here` };

  // Map questionIdExternal -> clean question text AND template order. The stored
  // answer_summary is section-prefixed, so we read the template's questions; key
  // by both the exact id and a hash-stripped id so answers match regardless of
  // the suffix. The order map restores the form's section/question order (so the
  // Review / Sign-Off section lands last, after Whole House).
  const qText = new Map<string, string>();
  const qOrder = new Map<string, { s: number; d: number }>();
  try {
    const { questions } = await fetchQuestionsForTemplate(tmpl, { includeDisabled: true });
    for (const q of questions) {
      const ord = { s: q.sectionOrder ?? 9999, d: q.displayOrder ?? 9999 };
      qText.set(q.questionIdExternal, q.questionText); qText.set(normQid(q.questionIdExternal), q.questionText);
      qOrder.set(q.questionIdExternal, ord); qOrder.set(normQid(q.questionIdExternal), ord);
    }
  } catch { /* prettify fallback below */ }
  const questionText = (qid: string) => qText.get(qid) || qText.get(normQid(qid)) || prettifyQid(qid);
  const orderOf = (qid: string) => qOrder.get(qid) || qOrder.get(normQid(qid)) || { s: 9999, d: 9999 };

  const answers = await fetchAnswersForInspection(id);
  const effSection = (a: { section: string; location?: string }) => a.location || a.section;

  const sectionPhotosBy: Record<string, string[]> = {};
  // Capture the Final Checklist JSON blob (questionId "fc__all", value
  // "final_checklist", data in `note`) — rendered as its own block, not a Q&A row.
  let fcBlob: FcAnswers | null = null;

  // Collect Q&A with their template order so we can sort sections + questions
  // back into the form's order (Review / Sign-Off last, after Whole House).
  const qaItems: { sec: string; s: number; d: number; ans: PdfAnswer }[] = [];
  for (const a of answers) {
    const sec = effSection(a);
    if (a.answerType === 'section_photo') {
      sectionPhotosBy[sec] = (sectionPhotosBy[sec] || []).concat(a.photoUrls || []);
      continue;
    }
    if (a.answerType !== 'qa') continue; // skip rate_card_line / signature etc.
    if (/^fc__/.test(a.questionIdExternal) || /^final.?checklist$/i.test((a.answerValue || '').trim())) {
      try { if (a.note) fcBlob = JSON.parse(a.note) as FcAnswers; } catch { /* malformed blob — skip */ }
      continue;
    }
    const ord = orderOf(a.questionIdExternal);
    qaItems.push({
      sec, s: ord.s, d: ord.d,
      ans: {
        questionText: questionText(a.questionIdExternal),
        section: sec,
        location: a.location,
        answerValue: a.answerValue,
        note: a.note || undefined,
        quantity: a.quantity,
        assignedTo: a.assignedTo || undefined,
        photoUrls: a.photoUrls && a.photoUrls.length > 0 ? a.photoUrls : undefined,
      },
    });
  }

  // Group + order: each section's order is the min sectionOrder among its
  // questions; questions within a section sort by displayOrder.
  const secMinOrder = new Map<string, number>();
  for (const it of qaItems) secMinOrder.set(it.sec, Math.min(secMinOrder.get(it.sec) ?? Infinity, it.s));
  for (const sec of Object.keys(sectionPhotosBy)) if (!secMinOrder.has(sec)) secMinOrder.set(sec, 9998);
  const sectionsInOrder = Array.from(secMinOrder.keys()).sort((x, y) => (secMinOrder.get(x)! - secMinOrder.get(y)!));
  const answersBySection: Record<string, PdfAnswer[]> = {};
  for (const sec of sectionsInOrder) {
    answersBySection[sec] = qaItems.filter((it) => it.sec === sec).sort((x, y) => x.d - y.d).map((it) => it.ans);
  }

  // Final Checklist → label/value groups (same as the Master report).
  let finalChecklist: { name: string; rows: { label: string; value: string }[] }[] | undefined;
  if (fcBlob) {
    const fcCtx: FcCompletionCtx = {
      septicFee: (data as any).propertySepticFee ?? null,
      airQtyPrefill: (data as any).propertyAirFiltersTotal ?? null,
      filterOptionsAvailable: true,
      filterPrefills: [
        (data as any).propertyAirFiltersType1 ?? null,
        (data as any).propertyAirFiltersType2 ?? null,
        (data as any).propertyAirFiltersType3 ?? null,
      ],
    };
    try { finalChecklist = summarizeFinalChecklist(fcBlob, fcCtx); } catch { /* skip */ }
  }
  const fcPhotos = fcBlob ? finalChecklistPhotos(fcBlob) : [];

  // Listing highlights for the header (Active / Deposit Taken · price · date).
  let listing: { listingStatus: string | null; listingPrice: number | null; listingDate: string | null } | null = null;
  try { listing = await fetchActiveListingForProperty(data.propertyIdRef); } catch { /* optional */ }

  // Resolve + embed thumbnails (small file), keep original URLs for clickable links.
  const allUrls: string[] = [];
  for (const arr of Object.values(answersBySection)) for (const a of arr) for (const u of (a.photoUrls || [])) allUrls.push(getPosterUrl(u));
  for (const arr of Object.values(sectionPhotosBy)) for (const u of arr) allUrls.push(getPosterUrl(u));
  for (const u of fcPhotos) allUrls.push(getPosterUrl(u));
  const resolved = await resolveImagesInParallel(allUrls);
  const embeddedByUrl: Record<string, string> = {};
  for (const [u, d] of resolved) embeddedByUrl[u] = d;

  let triggeredCount = 0;
  for (const arr of Object.values(answersBySection)) for (const a of arr) if (a.note || a.quantity != null || a.assignedTo) triggeredCount++;

  const pdfData: PdfData = {
    inspectionName: insp.inspectionName,
    externalId: insp.inspectionIdExternal,
    templateLabel: templateLabelFor(tmpl) || tmpl,
    propertyAddress: insp.propertyAddressSnapshot,
    inspectorName: insp.inspectorName,
    bedrooms: insp.bedroomsAtInspection || 0,
    bathrooms: insp.bathroomsAtInspection || 0,
    squareFootage: data.propertySquareFootage,
    region: insp.regionSnapshot || null,
    listingStatus: listing?.listingStatus ?? null,
    listingPrice: listing?.listingPrice ?? null,
    listingDate: listing?.listingDate ?? null,
    completedAt: insp.completedAt || insp.updatedAt || new Date().toISOString(),
    totalAnswered: Object.values(answersBySection).reduce((n, arr) => n + arr.length, 0),
    totalPhotos: allUrls.length,
    triggeredCount,
    hubspotRecordId: id,
    sectionsInOrder,
    answersBySection,
    sectionPhotosBy,
    triggeredValues: new Set<string>(),
    embeddedByUrl,
    finalChecklist,
    finalChecklistPhotos: fcPhotos,
  };

  const buf = await renderToBuffer(React.createElement(InspectionPdf, { data: pdfData }) as any);
  const safeName = (insp.inspectionName || 'Inspection').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60);
  const { url } = await uploadFileWithId(buf, `${safeName}_${insp.inspectionIdExternal}.pdf`, 'application/pdf', '/inspection_pdfs', true);
  await attachPdfUrlToInspection(id, url);
  // Refresh the clean short link so the record's "report" link/download resolves
  // to the regenerated PDF (matches /api/pdf). Best-effort.
  if (origin) {
    try { await updateInspection(id, { link_report: buildShortLink(origin, id, 'report') }); }
    catch { /* property may not exist — non-fatal */ }
  }
  return { id, ok: true, pdfUrl: url };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!/@resihome\.com$/i.test(session.email)) return res.status(403).json({ error: 'Admin only.' });

  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
  const origin = host ? `${proto}://${host}` : undefined;

  try {
    const id = typeof req.query.id === 'string' ? req.query.id : '';
    if (id) {
      const result = await regenerateOne(id, origin);
      return res.status(result.ok ? 200 : 502).json({ ok: result.ok, results: [result] });
    }

    // List mode: just return the target inspections (no regeneration) so the
    // admin page can drive a per-id progress loop.
    if (req.query.list) {
      const all = await fetchInspections();
      const items = all
        .filter((i) => TEMPLATES.has(i.templateType) && (i.status || '').toLowerCase() === 'completed')
        .map((i) => ({ id: i.recordId, label: templateLabelFor(i.templateType) || i.templateType, address: i.propertyAddressSnapshot }));
      return res.status(200).json({ ok: true, items, ids: items.map((i) => i.id), count: items.length });
    }

    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    const all = await fetchInspections();
    const targets = all.filter((i) =>
      TEMPLATES.has(i.templateType) && (i.status || '').toLowerCase() === 'completed').slice(0, limit);

    const results: Array<{ id: string; ok: boolean; pdfUrl?: string; error?: string }> = [];
    for (const t of targets) {
      try { results.push(await regenerateOne(t.recordId, origin)); }
      catch (e: any) { results.push({ id: t.recordId, ok: false, error: String(e?.message || e).slice(0, 200) }); }
    }
    const okCount = results.filter((r) => r.ok).length;
    console.log(`[regenerate-inspection-pdfs] ${okCount}/${results.length} regenerated`);
    return res.status(200).json({ ok: true, total: results.length, regenerated: okCount, results });
  } catch (e: any) {
    console.error('[regenerate-inspection-pdfs] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
