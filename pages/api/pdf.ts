import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { renderToBuffer } from '@react-pdf/renderer';
import React from 'react';
import { InspectionPdf, PdfData, PdfAnswer } from '@/lib/pdf';
import { uploadFileWithId, attachPdfUrlToInspection, attachFilesToInspectionRecord, updateInspection } from '@/lib/hubspot';
import { buildShortLink } from '@/lib/shortLinks';
import { resolveImagesInParallel } from '@/lib/pdf-images';
import { isVideoEntry, getPosterUrl, getVideoUrl, makeVideoEntry } from '@/lib/media';
import type { AnswerInput } from '@/lib/types';

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
  inspectorName: string;
  bedrooms: number;
  bathrooms: number;
  completedAt: string;
  answers: AnswerInput[];
  sectionPhotoUrls: Record<string, string[]>;
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

    // Step 2: pre-fetch + resize all in parallel (the big perf win).
    const t1 = Date.now();
    const urlToDataUri = await resolveImagesInParallel(allUrls);
    const tImg = Date.now() - t1;
    console.log(`[pdf] resolved ${urlToDataUri.size} images in ${tImg}ms`);

    // Step 3: build PDF data, swapping each URL for its resolved data URI. For a
    // video entry, we embed the poster data URI but preserve the video URL in the
    // same `poster#v=video` encoding so the PDF can link to the playable file.
    const swap = (urls?: string[]) =>
      urls?.map((u) => {
        const posterData = urlToDataUri.get(getPosterUrl(u)) || getPosterUrl(u);
        return isVideoEntry(u) ? makeVideoEntry(posterData, getVideoUrl(u)) : posterData;
      });

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
        photoUrls: a.photoUrls && a.photoUrls.length > 0 ? swap(a.photoUrls) : undefined,
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
      sectionPhotosBy[sec] = swap(urls) || [];
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
      inspectorName: body.inspectorName,
      bedrooms: body.bedrooms,
      bathrooms: body.bathrooms,
      completedAt: body.completedAt,
      totalAnswered: body.answers.length,
      totalPhotos,
      triggeredCount,
      hubspotRecordId: body.inspectionRecordId,
      sectionsInOrder,
      answersBySection,
      sectionPhotosBy,
      triggeredValues,
    };

    // Step 4: render the PDF
    const t2 = Date.now();
    const pdfBuffer = await renderToBuffer(React.createElement(InspectionPdf, { data }) as any);
    const tRender = Date.now() - t2;
    console.log(`[pdf] rendered in ${tRender}ms (${(pdfBuffer.length/1024).toFixed(0)}KB)`);

    // Step 5: upload to HubSpot Files
    const t3 = Date.now();
    const safeName = body.inspectionName.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60);
    const filename = `${safeName}_${body.externalId}.pdf`;
    const { url: pdfUrl, id: pdfFileId } = await uploadFileWithId(pdfBuffer, filename, 'application/pdf', '/inspection_pdfs', true);
    const tUpload = Date.now() - t3;
    console.log(`[pdf] uploaded in ${tUpload}ms`);

    // Step 6: patch Inspection record with PDF URL + attach to Attachments card.
    await attachPdfUrlToInspection(body.inspectionRecordId, pdfUrl);
    // Store the clean short link (resolves to this PDF) so the record + UI show
    // a tidy URL. Best-effort: skip silently if the property doesn't exist yet.
    try {
      const host = req.headers['x-forwarded-host'] || req.headers.host || '';
      const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
      if (host) {
        await updateInspection(body.inspectionRecordId, {
          link_report: buildShortLink(`${proto}://${host}`, body.inspectionRecordId, 'report'),
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

    const total = Date.now() - t0;
    console.log(`[pdf] total ${total}ms (images ${tImg}ms / render ${tRender}ms / upload ${tUpload}ms)`);
    return res.status(200).json({ success: true, pdfUrl, timing: { total, tImg, tRender, tUpload } });
  } catch (e: any) {
    console.error('POST /api/pdf failed:', e);
    return res.status(500).json({ success: false, error: String(e.message || e) });
  }
}
