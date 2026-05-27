import type { NextApiRequest, NextApiResponse } from 'next';
import { renderToBuffer } from '@react-pdf/renderer';
import React from 'react';
import { InspectionPdf, PdfData, PdfAnswer } from '@/lib/pdf';
import { uploadFile, attachPdfUrlToInspection } from '@/lib/hubspot';
import { resolveImagesInParallel } from '@/lib/pdf-images';
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
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const t0 = Date.now();
  try {
    const body = req.body as GeneratePdfBody;

    // Step 1: collect every image URL referenced anywhere in the inspection.
    const allUrls: string[] = [];
    for (const a of body.answers) {
      if (a.photoUrls && a.photoUrls.length) allUrls.push(...a.photoUrls);
    }
    for (const urls of Object.values(body.sectionPhotoUrls || {})) {
      if (urls && urls.length) allUrls.push(...urls);
    }

    // Step 2: pre-fetch + resize all in parallel (the big perf win).
    const t1 = Date.now();
    const urlToDataUri = await resolveImagesInParallel(allUrls);
    const tImg = Date.now() - t1;
    console.log(`[pdf] resolved ${urlToDataUri.size} images in ${tImg}ms`);

    // Step 3: build PDF data, swapping each URL for its resolved data URI.
    const swap = (urls?: string[]) => urls?.map((u) => urlToDataUri.get(u) || u);

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
    const pdfUrl = await uploadFile(pdfBuffer, filename, 'application/pdf', '/inspection_pdfs');
    const tUpload = Date.now() - t3;
    console.log(`[pdf] uploaded in ${tUpload}ms`);

    // Step 6: patch Inspection record with PDF URL (fire-and-forget pattern would be
    // faster but lower reliability; keeping awaited for now)
    await attachPdfUrlToInspection(body.inspectionRecordId, pdfUrl);

    const total = Date.now() - t0;
    console.log(`[pdf] total ${total}ms (images ${tImg}ms / render ${tRender}ms / upload ${tUpload}ms)`);
    return res.status(200).json({ success: true, pdfUrl, timing: { total, tImg, tRender, tUpload } });
  } catch (e: any) {
    console.error('POST /api/pdf failed:', e);
    return res.status(500).json({ success: false, error: String(e.message || e) });
  }
}
