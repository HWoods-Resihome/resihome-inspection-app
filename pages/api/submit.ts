import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { submitInspection } from '@/lib/hubspot';
import type { SubmitPayload } from '@/lib/types';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '5mb',
    },
  },
};

function nowIso(): string {
  return new Date().toISOString();
}

function shortId(): string {
  // crypto.randomUUID (Node 18+) for collision-proof ids; strip dashes.
  if (typeof crypto !== 'undefined' && (crypto as any).randomUUID) {
    return (crypto as any).randomUUID().replace(/-/g, '');
  }
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
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
  try {
    const payload = req.body as SubmitPayload;
    if (!payload || !payload.templateType || !payload.propertyRecordId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const inspectionExternalId = `web_${shortId()}`;
    const inspectionName = `${payload.templateType.replace(/_/g, ' ')} -- ${payload.propertyAddressSnapshot} -- ${nowIso().slice(0, 10)}`;

    const inspectionProps: Record<string, any> = {
      inspection_id_external: inspectionExternalId,
      inspection_name: inspectionName,
      template_type: payload.templateType,
      status: 'completed',
      property_address_snapshot: payload.propertyAddressSnapshot,
      bedrooms_at_inspection: payload.bedrooms,
      bathrooms_at_inspection: payload.bathrooms,
      inspector_name: payload.inspectorName,
      inspector_email: payload.inspectorEmail || '',
      started_at: payload.startedAt,
      completed_at: payload.completedAt,
      total_questions_answered: payload.answers.length,
      confirm_reviewed: 'yes',
      property_id_ref: payload.propertyRecordId,
    };

    // (Removed in v0.8) -- previously computed total_score across all answers
    // and wrote to inspection_props.total_score. Hayden replaced the per-answer
    // "score" field with "quantity" and elected to drop the inspection-level
    // rollup. If you want a total_quantity rollup later, add it here.

    // Count photos
    const totalPhotos = payload.answers.reduce((acc, a) => acc + (a.photoUrls?.length || 0), 0)
      + Object.values(payload.sectionPhotoUrls || {}).reduce((acc, arr) => acc + arr.length, 0);
    inspectionProps.total_photos_attached = totalPhotos;

    // Build answer records
    type AnswerInputRecord = {
      answerProps: Record<string, any>;
      questionHubspotRecordId: string | null;
    };
    const answerRecords: AnswerInputRecord[] = [];

    // 1. One Q&A answer per answered question
    let answerCounter = 0;
    for (const a of payload.answers) {
      answerCounter++;
      const externalId = `${inspectionExternalId}_a${String(answerCounter).padStart(3, '0')}`;
      const summary = `${a.section}${a.location ? ' / ' + a.location : ''} / ${a.questionText.slice(0, 30)} / ${a.answerValue.slice(0, 30)}`;
      const props: Record<string, any> = {
        answer_id_external: externalId,
        answer_summary: summary,
        answer_type: 'qa',
        question_id_external: a.questionIdExternal,
        question_text_snapshot: a.questionText,
        answer_value: a.answerValue,
        section: a.section,
        submitted_at: payload.completedAt,
        inspection_id_external: inspectionExternalId,
      };
      if (a.location) props.location = a.location;
      if (a.note) props.note = a.note;
      if (a.quantity != null) props.quantity = a.quantity;
      if (a.assignedTo) props.assigned_to = a.assignedTo;
      if (a.photoUrls?.length) {
        props.photo_urls = a.photoUrls.join(';');
        props.photo_count = a.photoUrls.length;
      }
      answerRecords.push({
        answerProps: props,
        questionHubspotRecordId: a.questionHubspotRecordId || null,
      });
    }

    // 2. Section photo answers
    // sectionPhotoUrls is keyed by display name; for repeating sections this is
    // "Bedroom 1", "Bathroom 2", etc. We extract the location prefix and store
    // both the base section and the location for clean reporting.
    function splitSectionAndLocation(displayName: string): { section: string; location?: string } {
      const m = displayName.match(/^(Bedroom|Bathroom|Half Bath)\s*(\d+)?$/i);
      if (m) {
        const type = m[1];
        if (type.toLowerCase() === 'half bath') {
          return { section: 'Bathroom', location: 'Half Bath' };
        }
        // "Bedroom 1" -> section "Bedroom", location "Bedroom 1"
        return { section: type, location: displayName };
      }
      return { section: displayName };
    }

    for (const [section, urls] of Object.entries(payload.sectionPhotoUrls || {})) {
      if (!urls || !urls.length) continue;
      const { section: baseSection, location } = splitSectionAndLocation(section);
      answerCounter++;
      const externalId = `${inspectionExternalId}_sp${String(answerCounter).padStart(3, '0')}`;
      const props: Record<string, any> = {
        answer_id_external: externalId,
        answer_summary: `${section} / Section Photo (${urls.length})`,
        answer_type: 'section_photo',
        section: baseSection,
        photo_urls: urls.join(';'),
        photo_count: urls.length,
        submitted_at: payload.completedAt,
        inspection_id_external: inspectionExternalId,
      };
      if (location) props.location = location;
      answerRecords.push({ answerProps: props, questionHubspotRecordId: null });
    }

    const t0 = Date.now();
    const { inspectionId } = await submitInspection({
      inspectionProps,
      answersProps: answerRecords,
      propertyRecordId: payload.propertyRecordId,
    });
    const elapsedMs = Date.now() - t0;
    console.log(`[submit] inspectionId=${inspectionId} answers=${answerRecords.length} elapsed=${elapsedMs}ms`);
    if (elapsedMs > 8000) {
      console.warn(`[submit] WARNING: took ${elapsedMs}ms; close to Vercel Hobby 10s limit. Consider upgrading.`);
    }

    return res.status(200).json({
      success: true,
      inspectionRecordId: inspectionId,
      inspectionExternalId,
      inspectionName,
      hubspotUrl: `https://app.hubspot.com/contacts/51415639/record/${process.env.HUBSPOT_INSPECTION_TYPE_ID}/${inspectionId}`,
    });
  } catch (e: any) {
    console.error('POST /api/submit failed:', e);
    return res.status(500).json({ success: false, error: String(e.message || e) });
  }
}
