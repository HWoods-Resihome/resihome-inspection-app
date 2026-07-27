import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { renderToBuffer } from '@react-pdf/renderer';
import React from 'react';
import { InspectionPdf, PdfData, PdfAnswer } from '@/lib/pdf';
import { uploadFileWithId, attachPdfUrlToInspection, attachFilesToInspectionRecord, updateInspection, readInspectionProps, fetchInspectionById, fetchPropertyCommunityRrqcWalkEmail } from '@/lib/hubspot';
import { buildShortLink } from '@/lib/shortLinks';
import { reqOriginOf } from '@/lib/appUrl';
import { externalOwnedWriteDenial } from '@/lib/inspectionGuard';
import { buildEmbeddedPhotoMap } from '@/lib/pdfImages';
import { getPosterUrl } from '@/lib/media';
import type { AnswerInput } from '@/lib/types';
import { notifyInspectionCompleted } from '@/lib/notifications/triggers';
import { appBaseUrl } from '@/lib/notifications/send';
import { templateLabel } from '@/lib/templateLabels';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '5mb',
    },
    responseLimit: '10mb',
  },
};

interface GeneratePdfBody {
  inspectionRecordId: string;
  externalId: string;
  templateLabel: string;
  inspectionName: string;
  propertyAddress: string;
  lotNumber?: string | null;
  inspectorName: string;
  bedrooms: number;
  bathrooms: number;
  squareFootage?: number | null;
  propertyStatus?: string | null;
  region?: string | null;
  listingStatus?: string | null;
  listingPrice?: number | null;
  listingDate?: string | null;
  moveInDate?: string | null;
  completedAt: string;
  answers: AnswerInput[];
  sectionPhotoUrls: Record<string, string[]>;
  finalChecklist?: { name: string; rows: { label: string; value: string; photos?: string[] }[] }[];
  finalChecklistPhotos?: string[];
  communityName?: string | null;
  communityLocation?: string | null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Defense-in-depth: middleware already gates this, but verify the
  // session here too so the route is never reachable unauthenticated
  // even if the middleware matcher changes.
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const t0 = Date.now();
  try {
    const body = req.body as GeneratePdfBody;

    // This endpoint WRITES to the record (pdf_attachment_url, link_report, an
    // attached note), so external users must OWN the inspection — the read guard
    // allows viewing ANY 1099, which would let an external user overwrite another
    // user's report (IDOR). Ownership (fail-closed on blank owner), not the
    // completed-status block, is the right gate: regenerating your own completed
    // 1099's report is legitimate. No-op + no extra read for internal users.
    if (body.inspectionRecordId) {
      const denial = await externalOwnedWriteDenial(session.email, body.inspectionRecordId);
      if (denial) return res.status(403).json({ error: denial });
    }

    // Step 1: collect every image URL referenced anywhere in the inspection.
    // For video clips the entry is `poster#v=video`; we only fetch/embed the
    // POSTER image (getPosterUrl) — the video itself is linked, not embedded.
    const allUrls: string[] = [];
    for (const a of body.answers) {
      if (a.photoUrls && a.photoUrls.length) for (const u of a.photoUrls) allUrls.push(getPosterUrl(u));
    }
    for (const urls of Object.values(body.sectionPhotoUrls || {})) {
      if (urls && urls.length) for (const u of urls) allUrls.push(getPosterUrl(u));
    }
    if (body.finalChecklistPhotos?.length) {
      for (const u of body.finalChecklistPhotos) allUrls.push(getPosterUrl(u));
    }

    // Step 2: pre-fetch + downscale all in parallel (the big perf win), via the
    // shared embed helper — warm thumbnail cache + retry on CDN propagation lag +
    // a global time budget. This route's maxDuration is 60s (vercel.json), so cap
    // the image phase well under it; remaining photos fall back to clickable links
    // rather than timing the whole function out.
    const t1 = Date.now();
    const embeddedByUrl = await buildEmbeddedPhotoMap(allUrls, { deadlineMs: 40_000 });
    const tImg = Date.now() - t1;
    console.log(`[pdf] resolved ${Object.keys(embeddedByUrl).length} images in ${tImg}ms`);

    // Step 3: build PDF data. We KEEP the original photo URLs on the answers (so
    // the PDF can LINK each photo to its full-size file — clickable like the Scope
    // report); embeddedByUrl (poster URL → small data URI) supplies the drawn img.

    // Group answers by an effective "section display name":
    //   - non-repeating: just the section ("Yard / Exterior")
    //   - repeating: section + location ("Bedroom 1", "Bathroom 2", "Half Bath")
    function effectiveSection(a: { section: string; location?: string }): string {
      return a.location || a.section;
    }

    const sectionsInOrder: string[] = [];
    const answersBySection: Record<string, PdfAnswer[]> = {};
    let triggeredCount = 0;
    for (const a of body.answers) {
      const sec = effectiveSection(a);
      if (!answersBySection[sec]) {
        sectionsInOrder.push(sec);
        answersBySection[sec] = [];
      }
      answersBySection[sec].push({
        questionText: a.questionText,
        section: sec,
        location: a.location,
        answerValue: a.answerValue,
        note: a.note || undefined,
        quantity: a.quantity,
        assignedTo: a.assignedTo || undefined,
        photoUrls: a.photoUrls && a.photoUrls.length > 0 ? a.photoUrls : undefined,
      });
      if (a.note || a.quantity != null || a.assignedTo) triggeredCount++;
    }
    // sectionPhotoUrls is already keyed by display name (e.g., "Bedroom 1") from the form.
    // Ensure any section-photo-only sections still appear in order.
    for (const sec of Object.keys(body.sectionPhotoUrls || {})) {
      if (!sectionsInOrder.includes(sec)) {
        sectionsInOrder.push(sec);
        answersBySection[sec] = [];
      }
    }

    const sectionPhotosBy: Record<string, string[]> = {};
    for (const [sec, urls] of Object.entries(body.sectionPhotoUrls || {})) {
      sectionPhotosBy[sec] = urls || [];
    }

    const totalPhotos = allUrls.length;
    const triggeredValues = new Set<string>();
    for (const a of body.answers) {
      if (a.note || a.quantity != null) triggeredValues.add(a.answerValue);
    }

    const data: PdfData = {
      inspectionName: body.inspectionName,
      externalId: body.externalId,
      templateLabel: body.templateLabel,
      propertyAddress: body.propertyAddress,
      lotNumber: body.lotNumber ?? null,
      inspectorName: body.inspectorName,
      bedrooms: body.bedrooms,
      bathrooms: body.bathrooms,
      squareFootage: body.squareFootage ?? null,
      propertyStatus: body.propertyStatus ?? null,
      region: body.region ?? null,
      listingStatus: body.listingStatus ?? null,
      listingPrice: body.listingPrice ?? null,
      moveInDate: body.moveInDate ?? null,
      listingDate: body.listingDate ?? null,
      finalChecklist: body.finalChecklist,
      finalChecklistPhotos: body.finalChecklistPhotos,
      communityName: body.communityName ?? null,
      communityLocation: body.communityLocation ?? null,
      completedAt: body.completedAt,
      totalAnswered: body.answers.length,
      totalPhotos,
      triggeredCount,
      hubspotRecordId: body.inspectionRecordId,
      sectionsInOrder,
      answersBySection,
      sectionPhotosBy,
      triggeredValues,
      embeddedByUrl,
      photoGalleryBase: (() => {
        const origin = reqOriginOf(req);
        return origin ? buildShortLink(origin, body.inspectionRecordId, 'photos') : undefined;
      })(),
    };

    // Step 4: render the PDF
    const t2 = Date.now();
    const pdfBuffer = await renderToBuffer(React.createElement(InspectionPdf, { data }) as any);
    const tRender = Date.now() - t2;
    console.log(`[pdf] rendered in ${tRender}ms (${(pdfBuffer.length/1024).toFixed(0)}KB)`);

    // Step 5: upload to HubSpot Files
    const t3 = Date.now();
    const safeName = body.inspectionName.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60);
    // Versioned filename so a re-submit (reopen → resubmit) or regen lands on a
    // NEW CDN path. HubSpot's file CDN serves overwritten files by path and
    // ignores query strings, so overwriting the same name served stale bytes
    // (the "old PDF" problem). The clean short link resolves pdf_attachment_url,
    // so this is transparent to anyone using the /d/<id>/report link.
    const version = Date.now().toString(36);
    const filename = `${safeName}_${body.externalId}_v${version}.pdf`;
    const { url: pdfUrl, id: pdfFileId } = await uploadFileWithId(pdfBuffer, filename, 'application/pdf', '/inspection_pdfs', false);
    const tUpload = Date.now() - t3;
    console.log(`[pdf] uploaded in ${tUpload}ms`);

    // Completion email is sent ONCE per completion cycle, tracked by a dedicated
    // `completion_emailed_at` stamp — NOT inferred from the PDF's existence (that
    // proxy fired the email only on the very first PDF and, worse, its read was
    // fail-CLOSED, so a HubSpot 429 during a burst of completions silently dropped
    // the email for some of them). FAIL OPEN here: a read error → treat as
    // NOT-emailed and attempt the send (a missed completion email is worse than a
    // rare duplicate; the stamp written after a confirmed send prevents dupes in
    // the normal case). Reopen clears the stamp, so an edited/re-completed
    // inspection re-emails on its next PDF.
    let alreadyEmailed = false;
    try {
      const prior = await readInspectionProps(body.inspectionRecordId, ['completion_emailed_at']);
      alreadyEmailed = !!(prior?.completion_emailed_at || '').toString().trim();
    } catch { alreadyEmailed = false; /* fail OPEN — attempt the send */ }

    // Step 6: patch Inspection record with PDF URL + attach to Attachments card.
    await attachPdfUrlToInspection(body.inspectionRecordId, pdfUrl);
    // Store the clean short link (resolves to this PDF) so the record + UI show
    // a tidy URL. Best-effort: skip silently if the property doesn't exist yet.
    try {
      const origin = reqOriginOf(req);
      if (origin) {
        await updateInspection(body.inspectionRecordId, {
          link_report: buildShortLink(origin, body.inspectionRecordId, 'report'),
        });
      }
    } catch (e) {
      console.warn('[pdf] link_report write skipped (property may not exist yet):', e);
    }
    if (pdfFileId) {
      try {
        const noteId = await attachFilesToInspectionRecord(body.inspectionRecordId, [pdfFileId], 'Inspection report');
        console.log(`[pdf] attached file ${pdfFileId} to record ${body.inspectionRecordId} via note ${noteId}`);
      } catch (e) {
        console.error('[pdf] attachFilesToInspectionRecord failed (URL still saved):', e);
      }
    } else {
      console.warn('[pdf] no pdfFileId returned from upload; cannot attach to record');
    }

    // Completion email — sent HERE (not at submit) so the report PDF is actually
    // ready to attach. The submit endpoint fires before this PDF exists, which is
    // why the emailed report came through with no attachment. One-shot: only on the
    // first PDF, and only for a COMPLETED non-rate-card inspection (rate cards email
    // at finalize; QC uses its own finalize). Best-effort — never blocks the PDF.
    if (!alreadyEmailed) {
      try {
        const insp = await fetchInspectionById(body.inspectionRecordId);
        const st = (insp?.status || '').trim().toLowerCase();
        const isRateCard = (insp?.templateType || '') === 'pm_scope_rate_card';
        const completed = st === 'completed' || st === 'complete' || st === 'submitted';
        if (insp && completed && !isRateCard) {
          // New Construction RRQC: also send to the associated community's
          // rrqc_walk_email distribution address, if the property is linked to a
          // community and that field is set. Otherwise the email just goes to the
          // inspector. Fail-open — a lookup error never blocks the send.
          let extraTo: string[] = [];
          if ((insp.templateType || '') === 'qc_new_construction_rrqc' && insp.propertyRecordId) {
            const walkEmail = await fetchPropertyCommunityRrqcWalkEmail(insp.propertyRecordId).catch(() => null);
            if (walkEmail) extraTo = [walkEmail];
          }
          await notifyInspectionCompleted({
            inspectionId: body.inspectionRecordId,
            inspectorEmail: insp.inspectorEmail,
            templateLabel: templateLabel(insp.templateType),
            address: insp.propertyAddressSnapshot || insp.inspectionName || 'the property',
            pdfUrl,
            baseUrl: appBaseUrl(req),
            extraTo,
          });
          // Stamp AFTER a confirmed send so a later regenerate doesn't re-email
          // (and a burst that failed the read above still can't double-send).
          await updateInspection(body.inspectionRecordId, { completion_emailed_at: new Date().toISOString() }).catch(() => {});
        }
      } catch (e: any) { console.warn('[pdf] completion email skipped:', String(e?.message || e).slice(0, 140)); }
    }

    const total = Date.now() - t0;
    console.log(`[pdf] total ${total}ms (images ${tImg}ms / render ${tRender}ms / upload ${tUpload}ms)`);
    return res.status(200).json({ success: true, pdfUrl, timing: { total, tImg, tRender, tUpload } });
  } catch (e: any) {
    console.error('POST /api/pdf failed:', e);
    return res.status(500).json({ success: false, error: String(e.message || e) });
  }
}
