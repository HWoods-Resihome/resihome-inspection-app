/**
 * GET/POST /api/services/[id]/proof-refresh — ADMIN backfill for the
 * proof-of-service enrichment on a service that already closed out.
 *
 * For an order whose vendor attached a proof-of-service document, this (re)runs
 * just the enrichment: extracts the job photos from inside the PDF and asks the
 * AI for a neutral summary of the document, then PATCHes ONLY
 * `proof_photo_urls` + `proof_summary`. Status / verdict / notes / costs are
 * NEVER touched — safe on a completed order. The service PDFs render on demand,
 * so they pick the enrichment up immediately.
 *
 * Built for backfilling services reviewed before the enrichment existed (new
 * submissions get it automatically during AI review).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { fetchServiceWorkOrder, patchServiceWorkOrder, readServiceAiChecks, provisionServicesSchema } from '@/lib/hubspot';
import { reviewOne } from '@/lib/services/aiReview';
import { extractProofPhotos } from '@/lib/services/proofExtract';
import { PROOF_URL_KEY } from '@/lib/services/model';
import { SAMPLE_AI_CHECKS, type AiCheck } from '@/lib/services/aiKnowledge';

export const config = { maxDuration: 120 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.realEmail || session.email).catch(() => false))) {
    return res.status(403).json({ error: 'Admin only.' });
  }
  const id = String(req.query.id || '');
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'A valid service id is required.' });

  try {
    const rec = await fetchServiceWorkOrder(id);
    if (!rec) return res.status(404).json({ error: 'Service not found (or object not configured).' });
    const answers = (() => { try { return JSON.parse(rec.props.answers_json || '{}'); } catch { return {}; } })();
    const proofUrl = String(answers[PROOF_URL_KEY] || '').trim();
    if (!/^https?:\/\//i.test(proofUrl)) {
      return res.status(400).json({ error: 'This service has no proof-of-service document to enrich from.' });
    }

    // Photos out of the vendor's PDF + the AI's document summary, in parallel.
    // reviewOne is READ-ONLY (returns a verdict object; writes nothing) — we use
    // it purely for its proof-mode summary so the wording matches live reviews.
    const savedChecks = await readServiceAiChecks().catch(() => null);
    const checks: AiCheck[] = savedChecks && savedChecks.length ? (savedChecks as AiCheck[]) : SAMPLE_AI_CHECKS;
    const [photos, verdict] = await Promise.all([
      extractProofPhotos(proofUrl, id),
      reviewOne(rec, checks).catch((e) => { console.warn('[proof-refresh] summary call failed:', e); return null; }),
    ]);

    const props: Record<string, any> = {};
    if (photos.length) props.proof_photo_urls = photos.join('\n');
    if (verdict?.proofSummary) props.proof_summary = verdict.proofSummary;
    if (!Object.keys(props).length) {
      return res.status(200).json({ ok: false, message: 'Nothing extracted — no embedded JPEG photos found and no summary produced.', photos: 0 });
    }

    // Persist AND VERIFY. The resilient work-order write silently STRIPS
    // properties HubSpot doesn't know yet — so before the proof fields are
    // provisioned, a plain patch "succeeds" while saving nothing. Re-read to
    // check; if the values didn't stick, run the (additive, idempotent) Services
    // provisioner to create the fields, patch again, and verify once more.
    const stored = async (): Promise<boolean> => {
      const fresh = await fetchServiceWorkOrder(id).catch(() => null);
      const fp = fresh?.props || {};
      const wantPhotos = !props.proof_photo_urls || !!String(fp.proof_photo_urls || '').trim();
      const wantSummary = !props.proof_summary || !!String(fp.proof_summary || '').trim();
      return wantPhotos && wantSummary;
    };
    await patchServiceWorkOrder(id, props);
    let persisted = await stored();
    let provisioned = false;
    if (!persisted) {
      try { await provisionServicesSchema(true); provisioned = true; } catch (e) {
        console.warn('[proof-refresh] provisioning failed:', e);
      }
      await patchServiceWorkOrder(id, props);
      persisted = await stored();
    }
    if (!persisted) {
      return res.status(500).json({
        ok: false, photos: photos.length, summary: verdict?.proofSummary || null,
        error: 'Extraction worked but the proof fields would not persist — the proof_summary / proof_photo_urls properties are missing on the Service Work Order object and auto-provisioning did not create them. Run /api/services/admin/provision?apply=1 and retry.',
      });
    }
    return res.status(200).json({
      ok: true, photos: photos.length, summary: verdict?.proofSummary || null, provisioned,
      message: `Enriched: ${photos.length} photo(s)${verdict?.proofSummary ? ' + document summary' : ''}${provisioned ? ' (fields were auto-provisioned first)' : ''}. The vendor/client PDFs now include them.`,
    });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
