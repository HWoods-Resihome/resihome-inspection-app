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
import { externalWriteDenial } from '@/lib/inspectionGuard';
import { recordAuditEvent } from '@/lib/auditLog';
import {
  fetchInspectionWithPropertyRef,
  fetchAnswersForInspection,
  fetchActiveListingForProperty,
  parseListingSnapshot,
  stampListingSnapshotAtCompletion,
  fetchSourceSectionPhotos,
  uploadFileWithId,
  attachFilesToInspectionRecord,
  updateInspection,
  readInspectionProps,
  stampFirstCompleted,
  stampPropertyStatusAtCompletion,
  populateBillingFields,
} from '@/lib/hubspot';
import { celebrateInspectionMilestoneIfHit } from '@/lib/inspectionMilestones';
import { getCachedCatalog } from '@/pages/api/rate-card/catalog';
import { resolveSections } from '@/lib/sections';
import { bustInspectionsCache } from '@/pages/api/inspections';
import { templateLabel as templateLabelFor } from '@/lib/templateLabels';
import { renderQcPdf, type QcPdfContext, type QcPdfSection, type QcPdfLine } from '@/lib/pdfQc';
import { buildShortLink } from '@/lib/shortLinks';
import { resolveImagesInParallel } from '@/lib/pdf-images';
import { getPosterUrl } from '@/lib/media';

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

// In-flight lock — prevents double-tap from running two QC finalizations.
const inFlightQcFinalize = new Set<string>();
// Durable cross-instance lock (mirrors submit.ts): serverless instances don't
// share the Set above, so a double-tap landing on two instances could both pass
// the per-instance guard + terminal check and render/attach TWO QC reports. A
// short-lived stamp on the record closes that window. Best-effort (HubSpot has no
// conditional write); time-boxed so a crash can't wedge it.
// Aligned to this route's maxDuration (vercel.json = 300s): the platform kills the
// function at that ceiling, so a lock older than it is provably stale (holder dead)
// and a timed-out run frees up for retry right after. Keep equal to maxDuration.
const QC_LOCK_MS = 300_000;
const QC_LOCK_PROP = process.env.QC_FINALIZE_LOCK_PROPERTY || 'qc_finalize_in_progress';

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

  // QC is internal-only; deny external (1099) users (defense-in-depth).
  const xDenial = await externalWriteDenial(session.email, id);
  if (xDenial) { res.status(403).json({ error: xDenial }); return; }

  const verdict = (req.body?.verdict || '').toString().toLowerCase();
  const overallNote = (req.body?.overallNote || '').toString().trim().slice(0, 2000);
  if (verdict !== 'pass' && verdict !== 'fail') {
    res.status(400).json({ error: 'verdict must be "pass" or "fail"' });
    return;
  }

  if (inFlightQcFinalize.has(id)) {
    res.status(409).json({ error: 'This inspection is already being submitted. Please wait.' });
    return;
  }
  inFlightQcFinalize.add(id);

  // Durable cross-instance lock — reject a concurrent finalize landing on another
  // serverless instance before it renders/attaches a duplicate report.
  const lockNow = Date.now();
  if (QC_LOCK_PROP) {
    try {
      const lockProps = await readInspectionProps(id, [QC_LOCK_PROP]).catch(() => null);
      const prev = lockProps?.[QC_LOCK_PROP];
      const prevMs = prev ? (Date.parse(String(prev)) || Number(prev) || 0) : 0;
      if (prevMs && lockNow - prevMs < QC_LOCK_MS) {
        inFlightQcFinalize.delete(id);
        res.status(409).json({ error: 'This inspection is already being submitted on another device. Please wait.' });
        return;
      }
      await updateInspection(id, { [QC_LOCK_PROP]: String(lockNow) });
    } catch (e) {
      console.warn('[qc-finalize] durable lock unavailable (continuing without it):', e);
    }
  }

  const t0 = Date.now();
  try {
    const data = await fetchInspectionWithPropertyRef(id);
    if (!data) {
      res.status(404).json({ error: 'Inspection not found' });
      return;
    }
    const inspection = data.inspection;
    // Terminal-state guard (mirrors submit.ts): a stale tab / queued retry / a
    // concurrent request on another instance must not re-finalize an already
    // completed QC — that would FLIP the verdict from the request body, attach a
    // DUPLICATE report note, and drift completed_at. The supported reopen path
    // sets status back to in_progress first, so a legitimate re-finalize is never
    // in the completed state here.
    const curStatus = (inspection.status || '').trim().toLowerCase();
    if (curStatus === 'completed' || curStatus === 'complete') {
      res.status(409).json({ error: 'This inspection is already completed. Reopen it before finalizing again.', alreadyCompleted: true });
      return;
    }
    const answers = await fetchAnswersForInspection(id);

    // Group lines + after-photos by section instance (location), preserving
    // the order they appear in the answer list.
    const lineAnswers = answers.filter((a) => a.answerType === 'rate_card_line');

    // Catalog lookup to enrich each line with category/subcategory/unit.
    let catByCode: Record<string, { category: string; subcategory: string; unit: string }> = {};
    if (lineAnswers.length > 0) {
      try {
        const catalog = await getCachedCatalog();
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
        const urls = a.photoUrls || [];
        // Key by composite, bare location, and bare section so the line-side
        // lookup below matches regardless of how the section was keyed.
        afterByLoc[`${a.section || ''}||${a.location || ''}`] = urls;
        if (a.location) afterByLoc[a.location] = urls;
        if (a.section && !(a.section in afterByLoc)) afterByLoc[a.section] = urls;
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
        // Photos: match composite, then bare location, then section.
        const before = beforeByLoc[key] || beforeByLoc[loc] || beforeByLoc[sectionLabel] || [];
        const after = afterByLoc[key] || afterByLoc[loc] || afterByLoc[sectionLabel] || [];
        sectionMap.set(key, {
          displayName: loc || sectionLabel || 'Section',
          lines: [],
          beforePhotos: before,
          afterPhotos: after,
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

    // Standalone-QC rooms: the section_photo records carry the room's after
    // photos + optional verdict + note (no line items). Build/augment sections
    // from them so the report shows every inspected room, and count room
    // verdicts (only for rooms WITHOUT lines, so line verdicts aren't
    // double-counted).
    for (const a of answers) {
      if (a.answerType !== 'section_photo') continue;
      const loc = a.location || '';
      const sectionLabel = a.section || '';
      const key = `${sectionLabel}||${loc}`;
      const pf = (a.passFail === 'pass' || a.passFail === 'fail') ? a.passFail : '';
      const note = (a as any).note || '';
      const hasPhotos = (a.photoUrls || []).length > 0;
      if (!sectionMap.has(key)) {
        // Skip a completely-ignored room (no verdict AND no photos) from the
        // report — both the summary page and the detail pages. A note alone
        // isn't enough to include it.
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

    // Order sections to MIRROR THE ACTUAL INSPECTION layout (Yard/Exterior first,
    // bedrooms in order, …) — the summary table and detail pages both follow this.
    // `sectionOrder` is otherwise answer/record order, which can start mid-list
    // (e.g. "Bedroom 2" first). resolveSections is the canonical order the app
    // renders the inspection in; sort by it, keeping any unmatched rooms
    // (Review/Sign-Off, custom) after the known ones in first-seen order.
    const canonical = resolveSections(
      inspection.sectionListJson,
      inspection.bedroomsAtInspection || 0,
      inspection.bathroomsAtInspection || 0,
    );
    const orderIndex = new Map<string, number>();
    canonical.forEach((s, i) => {
      const put = (k: string) => { if (k && !orderIndex.has(k)) orderIndex.set(k, i); };
      put(`${s.label}||${s.location}`);
      if (s.location) put(s.location);
      put(s.label);
    });
    const indexForKey = (key: string): number => {
      const at = key.indexOf('||');
      const label = at >= 0 ? key.slice(0, at) : key;
      const loc = at >= 0 ? key.slice(at + 2) : '';
      const composite = orderIndex.get(`${label}||${loc}`);
      if (composite != null) return composite;
      if (loc && orderIndex.has(loc)) return orderIndex.get(loc)!;
      if (orderIndex.has(label)) return orderIndex.get(label)!;
      return Number.MAX_SAFE_INTEGER; // unknown → after the canonical rooms
    };
    // Stable sort (Node ≥ 11): equal keys keep their first-seen relative order.
    sectionOrder.sort((a, b) => indexForKey(a) - indexForKey(b));

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
    // Keep the ORIGINAL urls on the sections (so the PDF can LINK each photo to
    // its full-size file / gallery — clickable) and pass the poster→thumbnail
    // map separately for the embedded (small) image.
    const embeddedByUrl: Record<string, string> = {};
    for (const [url, dataUri] of resolved) embeddedByUrl[getPosterUrl(url)] = dataUri;

    // Listing line for the header — prefer the frozen snapshot (re-runs stay
    // frozen), else a live lookup on first finalize. Best-effort.
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
      verdict: verdict as 'pass' | 'fail',
      overallNote: verdict === 'fail' ? overallNote : '',
      passCount,
      failCount,
      sections,
      embeddedByUrl,
    };

    // Photos in the QC PDF link to the browsable in-app gallery too.
    {
      const ghost = req.headers['x-forwarded-host'] || req.headers.host || '';
      const gproto = (req.headers['x-forwarded-proto'] as string) || 'https';
      const gorigin = ghost ? `${gproto}://${ghost}` : '';
      if (gorigin) (ctx as any).photoGalleryBase = buildShortLink(gorigin, id, 'photos');
    }
    const pdfBuf = await renderQcPdf(ctx);

    // Filename: "Turn Re-Inspect QC - {address} - {date} - {shortId}.pdf"
    // The short inspection-id suffix guarantees uniqueness so two QC
    // inspections on the same property/day don't collide in HubSpot Files
    // (which can dedupe identical paths and hand back the OLD file's URL).
    const safeAddress = (ctx.propertyName || 'property')
      .replace(/[^a-zA-Z0-9_\-\s]/g, '').replace(/\s+/g, ' ').trim().slice(0, 90);
    const d = new Date(ctx.generatedAtIso);
    const datePart = `${d.getMonth() + 1}-${d.getDate()}-${String(d.getFullYear()).slice(2)}`;
    const idSuffix = String(id).slice(-6);
    const filename = `Turn Re-Inspect QC - ${safeAddress} - ${datePart} - ${idSuffix}.pdf`;

    const { url: pdfUrl, id: pdfFileId } = await uploadFileWithId(pdfBuf, filename, 'application/pdf', '/inspection_pdfs', true);

    // Attach the PDF to the inspection record's Attachments card (best-effort).
    if (pdfFileId) {
      await attachFilesToInspectionRecord(id, [pdfFileId], `Turn Re-Inspect QC report (${verdict.toUpperCase()})`);
    }

    // Persist verdict + counts + status + PDF url. Defensive fallback if the
    // QC schema fields aren't present yet. We TRACK what actually persisted so
    // the response can confirm the verdict synced (instead of silently dropping
    // it) — the client surfaces a warning if it didn't.
    const nowIso = new Date().toISOString();
    const fullUpdate: Record<string, any> = {
      status: 'completed',
      completed_at: nowIso,
      qc_verdict: verdict,
      qc_pass_count: passCount,
      qc_fail_count: failCount,
      inspection_result: verdict,   // standardized Pass/Fail field (phase5_step2)
      pdf_attachment_url: pdfUrl,
      pdf_master_url: pdfUrl,
      pdf_generated_at: nowIso,
    };
    let verdictSynced = false;          // qc_verdict + qc_pass_count + qc_fail_count
    let inspectionResultSynced = false; // the standardized inspection_result enum
    try {
      await updateInspection(id, fullUpdate);
      verdictSynced = true;
      inspectionResultSynced = true;
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (msg.includes('PROPERTY_DOESNT_EXIST') || (msg.includes('Property') && msg.includes('does not exist'))) {
        console.warn('[qc-finalize] a result prop is missing on schema. Retrying without inspection_result, then status-only.');
        // Step down: drop only the newest field (inspection_result) first so the
        // verdict + counts still persist if that's the one missing.
        try {
          const { inspection_result, ...withoutResult } = fullUpdate;
          await updateInspection(id, withoutResult);
          verdictSynced = true; // qc_verdict + counts persisted; inspection_result missing
          console.warn('[qc-finalize] inspection_result is missing — run scripts/rate_card_phase5/phase5_step2_add_inspection_result.py. qc_verdict + counts DID persist.');
        } catch (e2: any) {
          console.warn('[qc-finalize] QC result props missing — run phase5_step1_add_qc_fields.py + phase5_step2_add_inspection_result.py. Verdict NOT persisted (status-only fallback).');
          await updateInspection(id, { status: 'completed', completed_at: nowIso, pdf_attachment_url: pdfUrl });
        }
      } else {
        throw e;
      }
    }

    // Inspection-count milestone (1k/2.5k/5k/10k) → celebrate the inspector.
    // QC finalize rejects an already-completed record above, so this is always a
    // first completion. Never throws; awaited so it runs before the freeze.
    await celebrateInspectionMilestoneIfHit(id);

    // Overall failure comment — written separately (best-effort) so a not-yet-
    // provisioned qc_overall_note can never disturb the verdict/counts update
    // above. Stored only on a Fail; cleared on Pass. Run /admin/setup to create it.
    try {
      await updateInspection(id, { qc_overall_note: verdict === 'fail' ? overallNote : '' });
    } catch (e) {
      console.warn('[qc-finalize] qc_overall_note write skipped (property may not exist yet — run /admin/setup):', e);
    }

    // Audit trail: the QC finalize completes the inspection with a Pass/Fail
    // verdict (there's no separate submit/approve step for QC). Best-effort.
    void recordAuditEvent({
      inspectionId: id,
      action: 'complete',
      actorEmail: session.email,
      actorName: session.name,
      detail: `QC ${verdict.toUpperCase()} — completed (${passCount} pass / ${failCount} fail)`,
      meta: { verdict, passCount, failCount },
    });

    // Clean short links (resolve to this PDF) for the record + UI. Separate
    // best-effort write so a missing link_* property never disturbs the QC
    // update/fallback above. Run scripts/short_links to create the properties.
    try {
      const qcHost = req.headers['x-forwarded-host'] || req.headers.host || '';
      const qcProto = (req.headers['x-forwarded-proto'] as string) || 'https';
      if (qcHost) {
        const qcBase = `${qcProto}://${qcHost}`;
        await updateInspection(id, {
          link_report: buildShortLink(qcBase, id, 'report'),
          link_master: buildShortLink(qcBase, id, 'master'),
        });
      }
    } catch (e) {
      console.warn('[qc-finalize] link_* write skipped (properties may not exist yet):', e);
    }

    await stampFirstCompleted(id, nowIso); // first completion timestamp (kept on re-runs)
    await stampPropertyStatusAtCompletion(id); // freeze property status for the record
    await stampListingSnapshotAtCompletion(id); // freeze the listing snapshot too
    // Guarantee a non-null vendor cost on the completed record ($0, or the
    // matched agent's value). Best-effort — never blocks the completion.
    try { await populateBillingFields(id); } catch (e) { console.warn('[qc-finalize] billing populate failed (continuing):', e); }
    await bustInspectionsCache(); // status → completed; reflect in the list at once
    res.status(200).json({
      success: true,
      elapsedMs: Date.now() - t0,
      verdict,
      passCount,
      failCount,
      pdf: { name: filename, url: pdfUrl },
      // Confirms the overall Pass/Fail synced to the inspection object. If
      // verdictSynced is false, the HubSpot QC properties are missing (run the
      // phase5 scripts); the client surfaces this so it isn't lost silently.
      resultSync: {
        verdictSynced,
        inspectionResultSynced,
        fields: verdictSynced
          ? ['qc_verdict', 'qc_pass_count', 'qc_fail_count', ...(inspectionResultSynced ? ['inspection_result'] : [])]
          : [],
      },
    });
  } catch (e: any) {
    console.error(`[qc-finalize] failed:`, e);
    res.status(500).json({ error: String(e?.message || e), elapsedMs: Date.now() - t0 });
  } finally {
    inFlightQcFinalize.delete(id);
  }
}
