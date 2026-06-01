// GET /api/inspections/[id]/qc-data
//
// Bundles everything the QC Turn Re-Inspect form needs:
//   - the QC's copied rate_card_line answers (with current pass_fail)
//   - the QC's own section "after" photos
//   - the SOURCE inspection's section photos (shown as "before")
//   - the overall verdict + counts (if already set)
//
// The QC's lines were snapshotted at create time, so this reads the QC's own
// answer records (not the source's live lines).

import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import {
  fetchInspectionWithPropertyRef,
  fetchAnswersForInspection,
  fetchSourceSectionPhotos,
} from '@/lib/hubspot';
import { getCachedCatalog } from '@/pages/api/rate-card/catalog';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
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

  try {
    const data = await fetchInspectionWithPropertyRef(id);
    if (!data) {
      res.status(404).json({ error: 'Inspection not found' });
      return;
    }
    const inspection = data.inspection;
    const answers = await fetchAnswersForInspection(id);

    // Catalog lookup (code -> category/subcategory/unit) to enrich the copied
    // lines so the QC view can show the same columns as the Scope Rate Card.
    const lineAnswers = answers.filter((a) => a.answerType === 'rate_card_line');
    let catByCode: Record<string, { category: string; subcategory: string; unit: string; shortDescription: string; subtext: string }> = {};
    if (lineAnswers.length > 0) {
      try {
        const catalog = await getCachedCatalog();
        for (const c of catalog) {
          catByCode[c.lineItemCode] = {
            category: c.category || '',
            subcategory: c.subcategory || '',
            unit: c.laborMeas || '',
            shortDescription: c.laborShortDescription || '',
            subtext: (c.laborSubtext && c.laborSubtext.trim()) || c.laborFullDescription || '',
          };
        }
      } catch (e) {
        console.warn('[qc-data] catalog load failed; columns will be sparse:', e);
      }
    }

    // QC's copied line items, enriched with catalog category/sub/unit.
    const lines = lineAnswers.map((a) => {
      const code = a.rateCardLine?.lineItemCode || '';
      const cat = catByCode[code] || { category: '', subcategory: '', unit: '', shortDescription: '', subtext: '' };
      // The stored answer_value is the user's override (if any) or the catalog
      // subtext/short. Prefer the catalog short description for the title line;
      // fall back to the stored value when the catalog isn't available.
      const shortDesc = cat.shortDescription || a.answerValue || '';
      // Subtext line: the catalog subtext, but only if it differs from the
      // short title (avoid showing the same text twice). If the stored value
      // was a manual override, prefer that as the subtext.
      const stored = a.answerValue || '';
      const overrode = stored && stored !== cat.shortDescription && stored !== cat.subtext;
      const subtext = overrode ? stored : (cat.subtext && cat.subtext !== shortDesc ? cat.subtext : '');
      return {
        recordId: a.recordId,
        section: a.section,
        location: a.location,
        lineItemCode: code,
        category: cat.category,
        subcategory: cat.subcategory,
        unit: cat.unit,
        // Title line (short) + optional subtext line below it.
        description: shortDesc,
        subtext,
        quantity: a.quantity,
        vendor: a.assignedTo,
        vendorCost: a.rateCardLine?.vendorCost ?? null,
        passFail: a.passFail || '',
        photoUrls: a.photoUrls || [],
      };
    });

    // QC's own "after" section photos, keyed by composite + location.
    const afterPhotos: Record<string, { recordId: string; urls: string[] }> = {};
    for (const a of answers) {
      if (a.answerType === 'section_photo') {
        const key = `${a.section || ''}||${a.location || ''}`;
        afterPhotos[key] = { recordId: a.recordId, urls: a.photoUrls || [] };
      }
    }

    // Source inspection's section photos -> "before" (multi-keyed).
    let beforePhotos: Record<string, string[]> = {};
    if (inspection.sourceRateCardId) {
      try {
        beforePhotos = await fetchSourceSectionPhotos(inspection.sourceRateCardId);
      } catch (e) {
        console.warn(`[qc-data] could not load source before-photos for ${id}:`, e);
      }
    }

    res.status(200).json({
      inspection,
      propertyRecordId: data.propertyIdRef,
      propertySquareFootage: data.propertySquareFootage,
      sourceRateCardId: inspection.sourceRateCardId,
      sourceRateCardName: inspection.sourceRateCardName,
      qcVerdict: inspection.qcVerdict,
      qcPassCount: inspection.qcPassCount,
      qcFailCount: inspection.qcFailCount,
      lines,
      afterPhotos,
      beforePhotos,
    });
  } catch (e: any) {
    console.error(`[qc-data] GET ${id} failed:`, e);
    res.status(500).json({ error: String(e?.message || e) });
  }
}
