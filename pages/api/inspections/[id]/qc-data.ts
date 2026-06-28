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
import { resolveSections } from '@/lib/sections';

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
    // Run the three slow reads CONCURRENTLY instead of serially: the QC's own
    // answers, the SOURCE scope's "before" photos (another full answer fetch),
    // and the catalog. This roughly halves the re-inspect's open time on a real
    // connection (it was inspection → answers → catalog → source, one after the
    // other). Source photos / catalog are best-effort (don't fail the load).
    const [answers, beforePhotos, catalog] = await Promise.all([
      fetchAnswersForInspection(id),
      inspection.sourceRateCardId
        ? fetchSourceSectionPhotos(inspection.sourceRateCardId).catch((e) => {
            console.warn(`[qc-data] could not load source before-photos for ${id}:`, e);
            return {} as Record<string, string[]>;
          })
        : Promise.resolve({} as Record<string, string[]>),
      getCachedCatalog().catch((e) => {
        console.warn('[qc-data] catalog load failed; columns will be sparse:', e);
        return [] as Awaited<ReturnType<typeof getCachedCatalog>>;
      }),
    ]);

    // Catalog lookup (code -> category/subcategory/unit) to enrich the copied
    // lines so the QC view can show the same columns as the Scope Rate Card.
    const lineAnswers = answers.filter((a) => a.answerType === 'rate_card_line');
    const catByCode: Record<string, { category: string; subcategory: string; unit: string; shortDescription: string; subtext: string }> = {};
    for (const c of catalog) {
      catByCode[c.lineItemCode] = {
        category: c.category || '',
        subcategory: c.subcategory || '',
        unit: c.laborMeas || '',
        shortDescription: c.laborShortDescription || '',
        subtext: (c.laborSubtext && c.laborSubtext.trim()) || c.laborFullDescription || '',
      };
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
        // Read-only reference: the comment the inspector left on this line in the
        // source Scope (copied onto the QC line at create) — so the QC reviewer
        // knows exactly what to look for.
        scopeNote: a.note || '',
        // The QC reviewer's own failure explanation (required on fail).
        qcFailureNote: a.qcFailureNote || '',
      };
    });

    // Order the QC lines to MIRROR the Scope template's room order (the QC was
    // snapshotted from it, but HubSpot returns answers in storage order, which
    // reads as a confusing jumble). Build the canonical section order from the
    // inspection's own section layout (copied from the source scope) and sort by
    // it; unmatched sections fall to the end in their original order.
    // Canonical room list (used for ordering AND, when there's no source scope,
    // as the room set the standalone QC renders so after-photos can be captured
    // per room even with zero line items).
    const ordered = resolveSections(
      inspection.sectionListJson,
      inspection.bedroomsAtInspection || 0,
      inspection.bathroomsAtInspection || 0,
    );
    const roomSections = ordered.map((s) => ({
      key: `${s.label}||${s.location || ''}`,
      displayName: s.displayName || s.label,
      section: s.label,
      location: s.location || '',
    }));
    try {
      const orderIndex = new Map<string, number>();
      ordered.forEach((s, i) => {
        for (const k of [`${s.label}||${s.location}`, `${s.displayName}||${s.location}`, `${s.displayName}||`, `${s.label}||`, s.displayName, s.label, s.location]) {
          if (k && !orderIndex.has(k)) orderIndex.set(k, i);
        }
      });
      const rank = (section: string, location: string): number => {
        for (const k of [`${section}||${location}`, location, section]) {
          const v = k ? orderIndex.get(k) : undefined;
          if (v !== undefined) return v;
        }
        return Number.MAX_SAFE_INTEGER;
      };
      lines.forEach((l, i) => { (l as any)._i = i; }); // stable tiebreaker
      lines.sort((a, b) => (rank(a.section, a.location) - rank(b.section, b.location)) || ((a as any)._i - (b as any)._i));
      lines.forEach((l) => { delete (l as any)._i; });
    } catch (e) {
      console.warn('[qc-data] section ordering skipped:', e);
    }

    // QC's own "after" section photos, keyed by composite + location.
    const afterPhotos: Record<string, { recordId: string; urls: string[]; passFail?: string; note?: string }> = {};
    for (const a of answers) {
      if (a.answerType === 'section_photo') {
        const key = `${a.section || ''}||${a.location || ''}`;
        // pass_fail / note are the standalone-QC room verdict + room note carried
        // on the after-photo record (see buildSectionPhotoAnswerProps).
        afterPhotos[key] = { recordId: a.recordId, urls: a.photoUrls || [], passFail: a.passFail || '', note: a.note || '' };
      }
    }

    // (beforePhotos was loaded above, in parallel with the answers + catalog.)

    // Maintenance-ticket Q&A (the "new items not on the original scope" prompt),
    // persisted as synthetic qa answers — restored so a reopened QC re-inspect
    // shows the inspector's selection + description.
    let maintTicketWanted = '';
    let maintTicketDescription = '';
    let maintTicketRequestRecordId = '';
    let maintTicketDescriptionRecordId = '';
    for (const a of answers) {
      if (a.questionIdExternal === 'maint_ticket_request') { maintTicketWanted = (a.answerValue || '').trim(); maintTicketRequestRecordId = a.recordId || ''; }
      else if (a.questionIdExternal === 'maint_ticket_description') { maintTicketDescription = a.answerValue || ''; maintTicketDescriptionRecordId = a.recordId || ''; }
    }

    res.status(200).json({
      inspection,
      propertyRecordId: data.propertyIdRef,
      propertySquareFootage: data.propertySquareFootage,
      sourceRateCardId: inspection.sourceRateCardId,
      sourceRateCardName: inspection.sourceRateCardName,
      qcVerdict: inspection.qcVerdict,
      qcOverallNote: inspection.qcOverallNote,
      qcPassCount: inspection.qcPassCount,
      qcFailCount: inspection.qcFailCount,
      lines,
      sections: roomSections,
      afterPhotos,
      beforePhotos,
      maintTicketWanted,
      maintTicketDescription,
      maintTicketRequestRecordId,
      maintTicketDescriptionRecordId,
    });
  } catch (e: any) {
    console.error(`[qc-data] GET ${id} failed:`, e);
    res.status(500).json({ error: String(e?.message || e) });
  }
}
