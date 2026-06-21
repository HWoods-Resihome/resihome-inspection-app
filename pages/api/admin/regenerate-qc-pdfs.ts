/**
 * GET /api/admin/regenerate-qc-pdfs
 *
 * Re-renders the Turn Re-Inspect QC PDF IN PLACE (before/after photos + line
 * pass/fail, header verdict) for completed QC inspections, reading saved answers
 * from HubSpot. Use this to retrofit PDF design/format changes (e.g. capitalized
 * Bed/Bath, region removed) onto existing QC reports.
 *
 *   ?id=<recordId>   regenerate a single QC inspection (quick validation)
 *   ?list            list the target completed QC inspections (no regeneration)
 *   (no id)          regenerate all recent COMPLETED QC inspections; ?limit=N
 *                    caps how many (default 50).
 *
 * Admin-gated (@resihome.com). Best-effort per inspection; returns a per-id log.
 *
 * NOTE: the fail "overall note" is captured at finalize time and isn't stored
 * separately, so a regenerated FAIL report won't reproduce that free-text note.
 * The verdict, pass/fail counts, before/after photos and line detail all
 * reproduce from the saved answers.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import {
  fetchInspections,
  fetchInspectionWithPropertyRef,
  fetchAnswersForInspection,
  fetchActiveListingForProperty,
  parseListingSnapshot,
  fetchSourceSectionPhotos,
  uploadFileWithId,
  attachPdfUrlToInspection,
  updateInspection,
} from '@/lib/hubspot';
import { getCachedCatalog } from '@/pages/api/rate-card/catalog';
import { templateLabel as templateLabelFor } from '@/lib/templateLabels';
import { renderQcPdf, type QcPdfContext, type QcPdfSection, type QcPdfLine } from '@/lib/pdfQc';
import { buildShortLink } from '@/lib/shortLinks';
import { resolveImagesInParallel } from '@/lib/pdf-images';
import { getPosterUrl } from '@/lib/media';

const QC_TEMPLATE = 'pm_turn_reinspect_qc';

export const config = { maxDuration: 300 };

async function regenerateOne(id: string, origin?: string): Promise<{ id: string; ok: boolean; pdfUrl?: string; error?: string }> {
  const data = await fetchInspectionWithPropertyRef(id);
  if (!data) return { id, ok: false, error: 'Inspection not found' };
  const inspection = data.inspection;
  if (inspection.templateType !== QC_TEMPLATE) {
    return { id, ok: false, error: `Template ${inspection.templateType} not supported here` };
  }

  const answers = await fetchAnswersForInspection(id);

  // ── Build ordered sections from rate-card lines (mirrors qc-finalize) ─────
  const lineAnswers = answers.filter((a) => a.answerType === 'rate_card_line');
  const catByCode: Record<string, { category: string; subcategory: string; unit: string }> = {};
  if (lineAnswers.length > 0) {
    try {
      for (const c of await getCachedCatalog()) {
        catByCode[c.lineItemCode] = { category: c.category || '', subcategory: c.subcategory || '', unit: c.laborMeas || '' };
      }
    } catch (e) { console.warn('[regenerate-qc-pdfs] catalog load failed; columns sparse:', e); }
  }

  const afterByLoc: Record<string, string[]> = {};
  for (const a of answers) {
    if (a.answerType === 'section_photo') {
      const urls = a.photoUrls || [];
      afterByLoc[`${a.section || ''}||${a.location || ''}`] = urls;
      if (a.location) afterByLoc[a.location] = urls;
      if (a.section && !(a.section in afterByLoc)) afterByLoc[a.section] = urls;
    }
  }
  let beforeByLoc: Record<string, string[]> = {};
  if (inspection.sourceRateCardId) {
    try { beforeByLoc = await fetchSourceSectionPhotos(inspection.sourceRateCardId); }
    catch (e) { console.warn('[regenerate-qc-pdfs] before-photo load failed:', e); }
  }

  const sectionOrder: string[] = [];
  const sectionMap = new Map<string, QcPdfSection>();
  let passCount = 0;
  let failCount = 0;

  for (const a of lineAnswers) {
    const loc = a.location || '';
    const sectionLabel = a.section || '';
    const key = `${sectionLabel}||${loc}`;
    if (!sectionMap.has(key)) {
      sectionOrder.push(key);
      sectionMap.set(key, {
        displayName: loc || sectionLabel || 'Section',
        lines: [],
        beforePhotos: beforeByLoc[key] || beforeByLoc[loc] || beforeByLoc[sectionLabel] || [],
        afterPhotos: afterByLoc[key] || afterByLoc[loc] || afterByLoc[sectionLabel] || [],
        passCount: 0,
        failCount: 0,
      });
    }
    const sec = sectionMap.get(key)!;
    const pf = (a.passFail === 'pass' || a.passFail === 'fail') ? a.passFail : '';
    if (pf === 'pass') { sec.passCount++; passCount++; }
    else if (pf === 'fail') { sec.failCount++; failCount++; }
    const code = a.rateCardLine?.lineItemCode || '';
    const cat = catByCode[code] || { category: '', subcategory: '', unit: '' };
    const line: QcPdfLine = {
      category: cat.category,
      subcategory: cat.subcategory,
      unit: cat.unit,
      description: a.answerValue || '',
      quantity: a.quantity,
      vendor: a.assignedTo || '',
      vendorCost: a.rateCardLine?.vendorCost ?? null,
      passFail: pf,
      failureNote: pf === 'fail' ? (a.qcFailureNote || '') : '',
    };
    sec.lines.push(line);
  }

  // Standalone-QC rooms (section_photo records carry after photos + verdict).
  for (const a of answers) {
    if (a.answerType !== 'section_photo') continue;
    const loc = a.location || '';
    const sectionLabel = a.section || '';
    const key = `${sectionLabel}||${loc}`;
    const pf = (a.passFail === 'pass' || a.passFail === 'fail') ? a.passFail : '';
    const note = (a as any).note || '';
    const hasPhotos = (a.photoUrls || []).length > 0;
    if (!sectionMap.has(key)) {
      if (!pf && !hasPhotos) continue;
      sectionOrder.push(key);
      sectionMap.set(key, {
        displayName: loc || sectionLabel || 'Section',
        lines: [],
        beforePhotos: beforeByLoc[key] || beforeByLoc[loc] || beforeByLoc[sectionLabel] || [],
        afterPhotos: a.photoUrls || [],
        passCount: 0,
        failCount: 0,
        roomVerdict: pf,
        roomNote: note,
      });
    } else {
      const sec = sectionMap.get(key)!;
      if ((sec.afterPhotos || []).length === 0 && (a.photoUrls || []).length) sec.afterPhotos = a.photoUrls!;
      if (sec.lines.length === 0) { sec.roomVerdict = pf; sec.roomNote = note; }
    }
    const sec = sectionMap.get(key)!;
    if (pf && sec.lines.length === 0) {
      if (pf === 'pass') { sec.passCount++; passCount++; }
      else { sec.failCount++; failCount++; }
    }
  }

  const sections: QcPdfSection[] = sectionOrder.map((k) => sectionMap.get(k)!);

  // Pre-resolve photos to embedded thumbnails (keep original URLs for links).
  const allPhotoUrls: string[] = [];
  for (const s of sections) allPhotoUrls.push(...s.beforePhotos, ...s.afterPhotos);
  const resolved = await resolveImagesInParallel(allPhotoUrls);
  const embeddedByUrl: Record<string, string> = {};
  for (const [url, dataUri] of resolved) embeddedByUrl[getPosterUrl(url)] = dataUri;

  // Verdict from the stored value (fall back to fail-if-any-fail).
  const verdict: 'pass' | 'fail' = inspection.qcVerdict === 'pass' || inspection.qcVerdict === 'fail'
    ? inspection.qcVerdict
    : (failCount > 0 ? 'fail' : 'pass');

  const listing = parseListingSnapshot(data.listingSnapshotJson)
    || await fetchActiveListingForProperty(data.propertyIdRef).catch(() => null);

  const ctx: QcPdfContext = {
    templateLabel: templateLabelFor(inspection.templateType) || 'Turn Re-Inspect QC',
    propertyName: inspection.propertyAddressSnapshot || `Property ${data.propertyIdRef}`,
    inspectorName: inspection.inspectorName || '(Unknown inspector)',
    bedrooms: inspection.bedroomsAtInspection || 0,
    bathrooms: inspection.bathroomsAtInspection || 0,
    squareFootage: data.propertySquareFootage,
    region: inspection.regionSnapshot || null,
    sourceRateCardName: inspection.sourceRateCardName || null,
    listingStatus: listing?.listingStatus ?? null,
    listingPrice: listing?.listingPrice ?? null,
    listingDate: listing?.listingDate ?? null,
    moveInDate: listing?.moveInDate ?? null,
    generatedAtIso: new Date().toISOString(),
    verdict,
    overallNote: verdict === 'fail' ? (inspection.qcOverallNote || '') : '',
    passCount,
    failCount,
    sections,
    embeddedByUrl,
  };
  if (origin) (ctx as any).photoGalleryBase = buildShortLink(origin, id, 'photos');

  const pdfBuf = await renderQcPdf(ctx);

  // Mint a NEW versioned file path on every regen so HubSpot's path-based CDN
  // serves the fresh bytes (overwriting the same path kept serving stale ones).
  const safeAddress = (ctx.propertyName || 'property').replace(/[^A-Za-z0-9_\-\s]/g, '').replace(/\s+/g, ' ').trim().slice(0, 90);
  const version = Date.now().toString(36);
  const idSuffix = String(id).slice(-6);
  const filename = `Turn Re-Inspect QC - ${safeAddress} - ${idSuffix} - v${version}.pdf`;
  const { url } = await uploadFileWithId(pdfBuf, filename, 'application/pdf', '/inspection_pdfs', false);

  // Point the record (and its clean /d/<id>/report link) at the new file.
  await attachPdfUrlToInspection(id, url);
  try { await updateInspection(id, { pdf_master_url: url, ...(origin ? { link_report: buildShortLink(origin, id, 'report') } : {}) }); }
  catch { /* property may not exist — non-fatal */ }

  return { id, ok: true, pdfUrl: url };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.email))) return res.status(403).json({ error: 'Admin only.' });

  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
  const origin = host ? `${proto}://${host}` : undefined;

  try {
    const id = typeof req.query.id === 'string' ? req.query.id : '';
    if (id) {
      const result = await regenerateOne(id, origin);
      return res.status(result.ok ? 200 : 502).json({ ok: result.ok, results: [result] });
    }

    if (req.query.list) {
      const all = await fetchInspections();
      const items = all
        .filter((i) => i.templateType === QC_TEMPLATE && (i.status || '').toLowerCase() === 'completed')
        .map((i) => ({ id: i.recordId, label: templateLabelFor(i.templateType) || i.templateType, address: i.propertyAddressSnapshot }));
      return res.status(200).json({ ok: true, items, ids: items.map((i) => i.id), count: items.length });
    }

    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    const all = await fetchInspections();
    const targets = all.filter((i) =>
      i.templateType === QC_TEMPLATE && (i.status || '').toLowerCase() === 'completed').slice(0, limit);

    const results: Array<{ id: string; ok: boolean; pdfUrl?: string; error?: string }> = [];
    for (const t of targets) {
      try { results.push(await regenerateOne(t.recordId, origin)); }
      catch (e: any) { results.push({ id: t.recordId, ok: false, error: String(e?.message || e).slice(0, 200) }); }
    }
    const okCount = results.filter((r) => r.ok).length;
    console.log(`[regenerate-qc-pdfs] ${okCount}/${results.length} regenerated`);
    return res.status(200).json({ ok: true, total: results.length, regenerated: okCount, results });
  } catch (e: any) {
    console.error('[regenerate-qc-pdfs] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
