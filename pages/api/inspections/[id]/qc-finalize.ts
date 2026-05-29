// POST /api/inspections/[id]/qc-finalize
//
// Finalizes a (PM) Turn Re-Inspect QC inspection:
//   1. Persist the overall verdict + pass/fail counts on the inspection
//   2. Render the QC PDF (before/after photos + line pass/fail, header verdict)
//   3. Upload it to HubSpot Files + store the URL
//   4. Flip status to 'completed'
//
// No approval step — this is the terminal action (like the 1099 inspection).
//
// Body: { verdict: 'pass' | 'fail' }

import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import {
  fetchInspectionWithPropertyRef,
  fetchAnswersForInspection,
  fetchSourceSectionPhotos,
  fetchRateCardCatalog,
  uploadFile,
  updateInspection,
} from '@/lib/hubspot';
import { renderQcPdf, type QcPdfContext, type QcPdfSection, type QcPdfLine } from '@/lib/pdfQc';
import { resolveImagesInParallel } from '@/lib/pdf-images';

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

// In-flight lock — prevents double-tap from running two QC finalizations.
const inFlightQcFinalize = new Set<string>();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const session = await getSessionFromRequest(req);
  if (!session) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  const id = req.query.id;
  if (typeof id !== 'string' || !id) {
    res.status(400).json({ error: 'Missing inspection id' });
    return;
  }

  const verdict = (req.body?.verdict || '').toString().toLowerCase();
  if (verdict !== 'pass' && verdict !== 'fail') {
    res.status(400).json({ error: 'verdict must be "pass" or "fail"' });
    return;
  }

  if (inFlightQcFinalize.has(id)) {
    res.status(409).json({ error: 'This inspection is already being submitted. Please wait.' });
    return;
  }
  inFlightQcFinalize.add(id);

  const t0 = Date.now();
  try {
    const data = await fetchInspectionWithPropertyRef(id);
    if (!data) {
      res.status(404).json({ error: 'Inspection not found' });
      return;
    }
    const inspection = data.inspection;
    const answers = await fetchAnswersForInspection(id);

    // Group lines + after-photos by section instance (location), preserving
    // the order they appear in the answer list.
    const lineAnswers = answers.filter((a) => a.answerType === 'rate_card_line');

    // Catalog lookup to enrich each line with category/subcategory/unit.
    let catByCode: Record<string, { category: string; subcategory: string; unit: string }> = {};
    if (lineAnswers.length > 0) {
      try {
        const catalog = await fetchRateCardCatalog();
        for (const c of catalog) {
          catByCode[c.lineItemCode] = { category: c.category || '', subcategory: c.subcategory || '', unit: c.laborMeas || '' };
        }
      } catch (e) {
        console.warn('[qc-finalize] catalog load failed; PDF columns sparse:', e);
      }
    }

    const afterByLoc: Record<string, string[]> = {};
    for (const a of answers) {
      if (a.answerType === 'section_photo') {
        const key = a.location || a.section || '';
        if (key) afterByLoc[key] = a.photoUrls || [];
      }
    }
    let beforeByLoc: Record<string, string[]> = {};
    if (inspection.sourceRateCardId) {
      try { beforeByLoc = await fetchSourceSectionPhotos(inspection.sourceRateCardId); }
      catch (e) { console.warn('[qc-finalize] before-photo load failed:', e); }
    }

    // Build ordered sections. Key by `${section}||${location}` so distinct
    // room instances (Bedroom 1 vs Bedroom 2) stay separate.
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
        // Before photos: match on composite, then bare location, then section
        // (same fallback the QC form uses).
        const before = beforeByLoc[key] || beforeByLoc[loc] || beforeByLoc[sectionLabel] || [];
        sectionMap.set(key, {
          displayName: loc || sectionLabel || 'Section',
          lines: [],
          beforePhotos: before,
          afterPhotos: afterByLoc[loc] || [],
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
      };
      sec.lines.push(line);
    }

    const sections: QcPdfSection[] = sectionOrder.map((k) => sectionMap.get(k)!);

    // Pre-resolve every before/after photo URL to a JPEG data URI in parallel,
    // then swap them into the section data. This is the same approach the
    // /api/pdf route uses and is far more reliable than letting @react-pdf
    // fetch each HubSpot URL itself at render time (which can silently fail).
    const allPhotoUrls: string[] = [];
    for (const s of sections) {
      allPhotoUrls.push(...s.beforePhotos, ...s.afterPhotos);
    }
    const resolved = await resolveImagesInParallel(allPhotoUrls);
    const swap = (urls: string[]) => urls.map((u) => resolved.get(u) || u);
    for (const s of sections) {
      s.beforePhotos = swap(s.beforePhotos);
      s.afterPhotos = swap(s.afterPhotos);
    }

    const ctx: QcPdfContext = {
      templateLabel: '(PM) Turn Re-Inspect QC',
      propertyName: inspection.propertyAddressSnapshot || `Property ${data.propertyIdRef}`,
      inspectorName: inspection.inspectorName || '(Unknown inspector)',
      bedrooms: inspection.bedroomsAtInspection || 0,
      bathrooms: inspection.bathroomsAtInspection || 0,
      squareFootage: data.propertySquareFootage,
      region: inspection.regionSnapshot || null,
      sourceRateCardName: inspection.sourceRateCardName || null,
      generatedAtIso: new Date().toISOString(),
      verdict: verdict as 'pass' | 'fail',
      passCount,
      failCount,
      sections,
    };

    const pdfBuf = await renderQcPdf(ctx);

    // Filename: "Turn Re-Inspect QC - {address} - {date}.pdf"
    const safeAddress = (ctx.propertyName || 'property')
      .replace(/[^a-zA-Z0-9_\-\s]/g, '').replace(/\s+/g, ' ').trim().slice(0, 90);
    const d = new Date(ctx.generatedAtIso);
    const datePart = `${d.getMonth() + 1}-${d.getDate()}-${String(d.getFullYear()).slice(2)}`;
    const filename = `Turn Re-Inspect QC - ${safeAddress} - ${datePart}.pdf`;

    const pdfUrl = await uploadFile(pdfBuf, filename, 'application/pdf', '/inspection_pdfs', true);

    // Persist verdict + counts + status + PDF url. Defensive fallback if the
    // QC schema fields aren't present yet.
    const nowIso = new Date().toISOString();
    const fullUpdate: Record<string, any> = {
      status: 'completed',
      completed_at: nowIso,
      qc_verdict: verdict,
      qc_pass_count: passCount,
      qc_fail_count: failCount,
      pdf_attachment_url: pdfUrl,
      pdf_master_url: pdfUrl,
      pdf_generated_at: nowIso,
    };
    try {
      await updateInspection(id, fullUpdate);
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (msg.includes('PROPERTY_DOESNT_EXIST') || (msg.includes('Property') && msg.includes('does not exist'))) {
        console.warn('[qc-finalize] QC props not on schema — run phase5_step1. Falling back to status-only.');
        await updateInspection(id, { status: 'completed', completed_at: nowIso, pdf_attachment_url: pdfUrl });
      } else {
        throw e;
      }
    }

    res.status(200).json({
      success: true,
      elapsedMs: Date.now() - t0,
      verdict,
      passCount,
      failCount,
      pdf: { name: filename, url: pdfUrl },
    });
  } catch (e: any) {
    console.error(`[qc-finalize] failed:`, e);
    res.status(500).json({ error: String(e?.message || e), elapsedMs: Date.now() - t0 });
  } finally {
    inFlightQcFinalize.delete(id);
  }
}
