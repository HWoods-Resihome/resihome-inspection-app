// Finalize a Rate Card inspection:
//   1. Load all line items + section photos from HubSpot
//   2. Render 4 PDF types (Master, Chargeback, Per-Vendor, ZIP bundle)
//      Skip docs with no content (no chargeback lines, no lines for a vendor).
//   3. Upload each PDF to HubSpot Files
//   4. Write the URLs to inspection properties (pdf_master_url, pdf_chargeback_url,
//      pdf_vendor_urls_json, pdf_zip_url, pdf_generated_at)
//   5. Flip status to 'completed'
//   6. Return the URLs so the client can offer immediate downloads
//
// Email delivery is intentionally deferred to a follow-up phase. Once Resend
// is set up the URLs returned here can be piped into a separate sendEmail
// step right before the response is sent.

import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { postScopeApproved } from '@/lib/scopeApprovalSlack';
import {
  fetchInspectionWithPropertyRef,
  fetchAnswersForInspection,
  fetchActiveListingForProperty,
  parseListingSnapshot,
  stampListingSnapshotAtCompletion,
  readInspectionProps,
  uploadFileWithId,
  attachFilesToInspectionRecord,
  updateInspection,
  answerHasAfterPhotoProperty,
  stampFirstCompleted,
  stampPropertyStatusAtCompletion,
  upsertAnswers,
  populateBillingFields,
} from '@/lib/hubspot';
import { buildQaAnswerProps } from '@/lib/answerProps';
import { isFinalizeAdmin } from '@/lib/finalizeAccess';
import { externalWriteDenial } from '@/lib/inspectionGuard';
import { isInternalResolution } from '@/lib/vendors';
import { recordAuditEvent } from '@/lib/auditLog';
import { reportServerError } from '@/lib/serverErrorReporter';
import { beginFinalizeJob, completeFinalizeJob, type FinalizeMode } from '@/lib/finalizeJobs';
import { sendPushToUser } from '@/lib/pushSender';
import { getCachedRegions } from '@/pages/api/rate-card/regions';
import { getCachedCatalog } from '@/pages/api/rate-card/catalog';
import { bustInspectionsCache } from '@/pages/api/inspections';
import { templateLabel as templateLabelFor } from '@/lib/templateLabels';
import { resolveSections, resolveStateCode, type SectionInstance } from '@/lib/sections';
import { calculateLine, roundMoney } from '@/lib/rateCardMath';
import { renderMasterPdf } from '@/lib/pdfMaster';
import { renderChargebackPdf } from '@/lib/pdfChargeback';
import { renderVendorPdfs } from '@/lib/pdfVendor';
import { renderChargebackXlsx } from '@/lib/xlsxChargeback';
import { composeInspectionEmail } from '@/lib/email';
import { sendInspectionEmail } from '@/lib/gmail';
import { uploadToSftp, type SftpUploadResult } from '@/lib/sftp';
import { enqueueSftpWatch, WATCH_WINDOW_MS } from '@/lib/sftpWatch';
import { getGmailRefreshToken, encryptToken } from '@/lib/gmailAuth';
import { createMaintenanceTicket, buildTicketDescription, buildTicketUrl, TICKET_TYPE_EVICTION, TICKET_CATEGORY_EVICTION, TICKET_CATEGORY_CAPEX, type CreateTicketResult } from '@/lib/maintenanceAi';
import { vendorTicketKind } from '@/lib/vendors';
import { buildShortLink } from '@/lib/shortLinks';
import type { PdfBuildContext, PdfSectionGroup, PdfLineRow } from '@/lib/pdfShared';
import { buildEmbeddedPhotoMap } from '@/lib/pdfImages';
import { summarizeFinalChecklist, finalChecklistPhotos, finalChecklistAnswerRecords, fcMissingLineCodes, fcSmartHomeStamps, fcPoolStamps, type FcAnswers, type FcCompletionCtx, type FcSummaryGroup } from '@/lib/finalChecklist';

export const config = {
  api: {
    // Finalize involves rendering up to ~10 PDFs and uploading them, plus the
    // ZIP. Bump the response body limit headroom for safety; per-request
    // duration ceiling is set in vercel.json.
    responseLimit: false,
  },
};

// In-flight finalize lock (per server instance). Prevents a double-tap /
// slow-network retry from kicking off two concurrent PDF-generation passes for
// the same inspection. A Map with a start timestamp so a crashed/abandoned
// finalize can't wedge the lock forever — entries older than the window are
// treated as stale and overwritten.
const inFlightFinalize = new Map<string, number>();
const FINALIZE_LOCK_MS = 5 * 60 * 1000;

// Durable cross-instance lock. Serverless instances don't share the Map above,
// so we mark a HubSpot datetime/text property while finalize runs to guard
// against a concurrent double-finalize from another device/tab. Defaults to the
// `finalize_in_progress` property (now created in HubSpot); override the name
// via FINALIZE_LOCK_PROPERTY if needed. Fail-safe: every read/write is wrapped,
// so if the property is missing or a different type, finalize behaves exactly
// as before (per-instance guard only). HubSpot has no conditional write, so
// this is best-effort, but it closes the common concurrent-double window.
const FINALIZE_LOCK_PROP = process.env.FINALIZE_LOCK_PROPERTY || 'finalize_in_progress';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'Missing inspection id' });

  // Rate Card finalize is internal-only; deny external (1099) users (defense-in-depth).
  {
    const xDenial = await externalWriteDenial(session.email, id);
    if (xDenial) return res.status(403).json({ error: xDenial });
  }

  // "Regenerate PDFs only" mode (the /admin/regenerate-pdfs tool). Rebuilds +
  // uploads the PDFs and refreshes their stored URLs IN PLACE, but PRESERVES the
  // inspection's current status and skips ALL outbound side effects (no email,
  // ticket, SFTP, approver stamp, status flip). This makes it safe to run on
  // submitted / pending_approval reports — it never completes them, bypasses
  // approval, or re-sends emails — as well as completed ones.
  const regenerateOnly = !!(req.body || {}).regenerateOnly;
  // "Zero Dollar Turn" mode: the inspector submits a final turn with NO line
  // items (total $0) in one tap from the scope. It completes directly (no
  // pending-approval / second reviewer / AI review), still generates the PDFs
  // and raises the Turnkey ticket (description "Zero Dollar Turn"), but does NOT
  // do the tenant charge import (there are no chargebacks). Section photos are
  // still required (enforced client-side before this call).
  const zeroDollarTurn = !!(req.body || {}).zeroDollarTurn;

  // Selective regeneration (admin Regenerate-PDFs tool): when regenerateOnly is
  // set, `regenerateTypes` limits WHICH PDFs are rebuilt so an admin can refresh
  // just the Master (or just one vendor) without re-rendering everything. Values:
  // 'master' | 'chargeback' | 'vendor'. `regenerateVendor` narrows 'vendor' to a
  // single vendor by name. Empty/absent ⇒ regenerate ALL (the original behavior).
  // Kinds NOT regenerated keep their existing stored URLs untouched.
  const regenerateTypes: string[] = regenerateOnly && Array.isArray((req.body || {}).regenerateTypes)
    ? (req.body.regenerateTypes as any[]).map((s) => String(s).trim().toLowerCase()).filter(Boolean)
    : [];
  const regenerateVendor = regenerateOnly && typeof (req.body || {}).regenerateVendor === 'string'
    ? (req.body.regenerateVendor as string).trim() : '';
  const selectiveRegen = regenerateTypes.length > 0;
  const genMaster = !selectiveRegen || regenerateTypes.includes('master');
  const genChargeback = !selectiveRegen || regenerateTypes.includes('chargeback');
  const genVendor = !selectiveRegen || regenerateTypes.includes('vendor');

  // ONE preflight read of every inspection property the pre-flight gates need —
  // the self-approval lockout, the durable cross-instance lock, and the
  // partial-failure resume stamps — instead of three sequential HubSpot reads.
  // Fail-open: on any read error each gate below behaves as if its property was
  // absent (exactly the prior per-gate try/catch behavior).
  const preflightProps = ['submitted_by_email', 'submitted_at', 'hbmm_ticket_id', 'hbmm_eviction_ticket_id', 'hbmm_capex_ticket_id', 'finalize_email_sent_at', 'chargeback_import_sent_at'];
  if (FINALIZE_LOCK_PROP) preflightProps.push(FINALIZE_LOCK_PROP);
  const preflight: Record<string, any> | null = await readInspectionProps(id, preflightProps).catch((e) => {
    console.warn('[finalize] preflight property read failed (gates fail open):', e);
    return {};
  });

  // Dual-approval lockout: the person who submitted an inspection for approval
  // can NEVER finalize it themselves — a second reviewer (any OTHER signed-in
  // user) must. This is the approval layer. A finalize admin is exempt and may
  // finalize their own work. (regenerateOnly is an admin-only PDF refresh that
  // changes no status / sends nothing, so it is not subject to this lock.)
  // A Zero Dollar Turn is finalized in one tap by the inspector (there's nothing
  // to approve at $0), so it's exempt from the dual-approval lock.
  if (!regenerateOnly && !zeroDollarTurn) {
    const submitter = String(preflight?.submitted_by_email || '').trim().toLowerCase();
    if (submitter && submitter === session.email.trim().toLowerCase() && !isFinalizeAdmin(session.email)) {
      return res.status(423).json({
        error: `You submitted this inspection for approval, so it needs a second reviewer to finalize it. Another signed-in user can finalize it now.`,
        selfApprovalLocked: true,
      });
    }
  }

  const lockNow = Date.now();
  const localStartedAt = inFlightFinalize.get(id);
  if (localStartedAt && lockNow - localStartedAt < FINALIZE_LOCK_MS) {
    return res.status(409).json({ error: 'This inspection is already being finalized. Please wait.' });
  }
  inFlightFinalize.set(id, lockNow);

  // Best-effort durable lock across instances (opt-in via env). Fail-safe: any
  // error (property missing, read failure) just skips the durable check.
  let durableLockHeld = false;
  if (FINALIZE_LOCK_PROP) {
    try {
      // Reuse the preflight read (no second round-trip) for the lock value.
      const prev = preflight?.[FINALIZE_LOCK_PROP];
      const prevMs = prev ? Date.parse(String(prev)) || Number(prev) || 0 : 0;
      if (prevMs && lockNow - prevMs < FINALIZE_LOCK_MS) {
        inFlightFinalize.delete(id);
        return res.status(409).json({ error: 'This inspection is already being finalized on another device. Please wait.' });
      }
      // Epoch-ms string: accepted by a HubSpot datetime property AND fine for a
      // single-line text property (the read parses either form).
      await updateInspection(id, { [FINALIZE_LOCK_PROP]: String(lockNow) });
      durableLockHeld = true;
    } catch (e) {
      console.warn('[finalize] durable lock unavailable (continuing without it):', e);
    }
  }

  const t0 = Date.now();
  // Finalize job tracking — visibility into attempts that die mid-pipeline.
  let finalizeJobId: string | null = null;
  let finalizePhase = 'preflight';
  let finalizeMode: FinalizeMode = regenerateOnly ? 'regenerate' : 'finalize';
  try {
    // ---- 1. Load all the data we need to generate PDFs ----
    const inspectionData = await fetchInspectionWithPropertyRef(id);
    if (!inspectionData) {
      return res.status(404).json({ error: 'Inspection not found' });
    }
    const inspection = inspectionData.inspection;
    if (inspection.templateType !== 'pm_scope_rate_card') {
      return res.status(400).json({ error: 'Finalize is only supported for Rate Card inspections.' });
    }

    // Whether this is a RE-finalize (inspection was already completed and is
    // being regenerated after a reopen). We still regenerate PDFs, but we do
    // NOT re-send the damages email — that would duplicate it to soda@ + team.
    const priorStatus = (inspection.status || '').trim().toLowerCase();
    // regenerateOnly is treated as a re-finalize for the purpose of skipping the
    // one-time outbound steps (email / ticket / SFTP / xlsx / approver stamp).
    const isRefinalize = regenerateOnly
      || priorStatus === 'completed' || priorStatus === 'complete' || priorStatus === 'submitted';

    finalizeMode = regenerateOnly ? 'regenerate' : isRefinalize ? 'refinalize' : 'finalize';
    finalizePhase = 'loading';
    finalizeJobId = await beginFinalizeJob({ inspectionId: id, mode: finalizeMode, actorEmail: session.email });

    // Partial-failure resumability: finalize fires several IRREVERSIBLE outbound
    // steps (create maintenance ticket, send the damages email). If a previous
    // attempt completed those but died before flipping status to 'completed',
    // a retry would DUPLICATE them (isRefinalize is false because status is
    // still pending). So we read the per-step stamps and skip anything already
    // done. `hbmm_ticket_id` is an existing property; `finalize_email_sent_at`
    // is read/written best-effort — if it isn't on the schema yet, the read is
    // empty and we behave exactly as before (create the property to activate
    // full email-resume). See scripts/ for adding the property. Values come from
    // the single preflight read above (no extra round-trip).
    const ticketAlreadyCreated = !!String(preflight?.hbmm_ticket_id || '').trim();
    const emailAlreadySent = !!String(preflight?.finalize_email_sent_at || '').trim();
    // Durable "the tenant-charge import already went to SFTP" stamp. MUST be a
    // stamp, NOT isRefinalize: the supported reopen→resubmit→finalize path lands
    // on priorStatus 'pending_approval' (isRefinalize=false, same as a FIRST
    // finalize), so gating the xlsx regen + SFTP drop on isRefinalize re-dropped
    // the import and DOUBLE-BILLED the tenant. reopen.ts does not clear this
    // stamp (like finalize_email_sent_at / hbmm_ticket_id), so it survives a
    // reopen and the import fires exactly once. Empty until the property exists
    // (then the guard is inert and we fall back to the prior isRefinalize gate).
    const chargebackAlreadyImported = !!String(preflight?.chargeback_import_sent_at || '').trim();

    // Persist a finalize idempotency STAMP durably. The dedup that stops a
    // re-finalize / partial-failure resume from repeating an irreversible
    // side-effect (a DUPLICATE vendor ticket, a re-sent damages email, or a
    // re-dropped tenant-charge import) relies ENTIRELY on the stamp being stored,
    // so retry a few times and log LOUDLY if it ultimately fails. Defined here
    // (before the render/SFTP section) so the SFTP-import stamp can be written the
    // instant the drop succeeds, minimizing the crash-before-stamp window.
    const storeFinalizeStamp = async (prop: string, value: string | number | undefined, dupConsequence: string): Promise<void> => {
      const val = String(value || '');
      if (!val) return;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try { await updateInspection(id, { [prop]: val }); return; }
        catch (e) {
          if (attempt === 3) {
            console.error(`[finalize] FAILED to store ${prop}=${val} after 3 attempts — ${dupConsequence}. Ensure the ${prop} property exists in HubSpot.`, e);
          } else {
            console.warn(`[finalize] could not store ${prop} (attempt ${attempt}/3) — retrying:`, e);
            await new Promise((r) => setTimeout(r, 300 * attempt));
          }
        }
      }
    };
    const storeTicketId = (prop: string, ticketId: number | undefined) =>
      storeFinalizeStamp(prop, ticketId, 'a re-finalize could create a DUPLICATE ticket');

    const [answers, regions, catalog] = await Promise.all([
      fetchAnswersForInspection(id),
      getCachedRegions(),
      getCachedCatalog(),
    ]);

    // Code↔catalog drift guard: the Final Checklist auto-add buttons reference
    // hardcoded catalog codes. If a catalog rename/removal orphaned one, log it
    // loudly here (and /api/admin/config-check surfaces it on demand). Cheap and
    // non-blocking — it just makes a silent breakage visible.
    if (inspection.templateType === 'pm_scope_rate_card') {
      const missingFcCodes = fcMissingLineCodes(new Set(catalog.map((c) => c.lineItemCode)));
      if (missingFcCodes.length) {
        console.warn(`[finalize] WARN: Final Checklist references catalog codes missing from the live catalog: ${missingFcCodes.join(', ')} — those FC add-line buttons are broken.`);
      }
    }

    // ---- 2. Build the section list (using stored section_list_json) ----
    const sectionInstances: SectionInstance[] = resolveSections(
      inspection.sectionListJson,
      inspection.bedroomsAtInspection || 0,
      inspection.bathroomsAtInspection || 0,
    );

    // Group answers by section/location for fast lookup.
    // We join on `location` (immutable per section instance — e.g.
    // "bedroom-1", "yard_exterior") rather than `label` because the label
    // can be renamed via Manage Sections after lines were saved, which
    // would silently drop those lines from the finalized PDFs.
    const sectionLookup = new Map<string, SectionInstance>();
    for (const s of sectionInstances) {
      // Unique key per instance: label + location.
      sectionLookup.set(`${s.label}||${s.location}`, s);
      // Location-only key ONLY for repeating sections (non-empty location, e.g.
      // "Bedroom 1") so a renamed bedroom/bathroom still matches. Static, non-
      // repeating sections (Yard, Kitchen, Whole House, …) have location "" —
      // NEVER key on "" or every static section collides onto the last one
      // (which dumped all their lines + photos into Smart Home / Locks).
      if (s.location) sectionLookup.set(s.location, s);
    }
    // Resolve the section for an answer: prefer the unique label||location key,
    // then fall back to location-only (repeating, renamed sections only).
    const resolveSection = (section: string, location: string): SectionInstance | undefined =>
      sectionLookup.get(`${section}||${location}`) || (location ? sectionLookup.get(location) : undefined);

    // ---- 3. Build PdfSectionGroup[] with re-computed math ----
    // We re-run the math here using current rates so PDFs always reflect the
    // most recent calculation logic. (Snapshots on the answer record exist
    // for HubSpot reporting but the PDFs prefer fresh.)
    const sectionGroups = new Map<string, PdfSectionGroup>();
    for (const s of sectionInstances) {
      sectionGroups.set(s.id, {
        label: s.label,
        displayName: s.displayName,
        lines: [],
        photoUrls: [],
        vendorTotal: 0,
        clientTotal: 0,
        tenantTotal: 0,
      });
    }
    // Safety net for a line whose section was RENAMED after it was saved. A static
    // section (Yard/Kitchen/Whole House…) has location "" so resolveSection's
    // location-only fallback can't recover it once the label changes — and
    // DROPPING the line silently UNDER-BILLS (missing from PDFs + every total).
    // Instead, group unresolved lines under a synthetic section keyed by their
    // stored label so they still render and count toward the grand totals (under
    // the old label — finalize has no old→new rename mapping). Logged separately.
    let recoveredNoSection = 0;
    const getOrCreateUnresolvedGroup = (section: string, location: string): PdfSectionGroup => {
      const key = `__unresolved__:${section}||${location}`;
      let g = sectionGroups.get(key);
      if (!g) {
        g = { label: section || location || 'Other', displayName: section || location || 'Other', lines: [], photoUrls: [], vendorTotal: 0, clientTotal: 0, tenantTotal: 0 };
        sectionGroups.set(key, g);
      }
      return g;
    };

    // Grouping/integrity guard: count how many rate-card lines we couldn't place
    // (no matching section, or catalog miss). A non-trivial drop rate means a
    // grouping/catalog regression — we log loudly and surface it in the response.
    let totalLineAnswers = 0;
    let droppedNoSection = 0;
    let droppedCatalogMiss = 0;
    const droppedDetail: string[] = [];

    for (const ans of answers) {
      if (ans.answerType === 'rate_card_line' && ans.rateCardLine) {
        totalLineAnswers++;
        const s = resolveSection(ans.section, ans.location);
        let group: PdfSectionGroup | undefined;
        if (s) {
          group = sectionGroups.get(s.id);
        } else {
          // Renamed static section (or stale label): recover under the stored
          // label rather than drop → the line still bills. (Was a silent drop.)
          recoveredNoSection++;
          if (droppedDetail.length < 20) droppedDetail.push(`recovered-no-section: ${ans.rateCardLine.lineItemCode} (section="${ans.section}" location="${ans.location}")`);
          console.warn(`[finalize] no matching section for answer ${ans.answerIdExternal} (section="${ans.section}" location="${ans.location}") — recovering under the stored label (likely a renamed section).`);
          group = getOrCreateUnresolvedGroup(ans.section, ans.location);
        }
        if (!group) continue;

        const rc = ans.rateCardLine;
        const catalogItem = catalog.find((c) => c.lineItemCode === rc.lineItemCode);
        if (!catalogItem) {
          droppedCatalogMiss++;
          if (droppedDetail.length < 20) droppedDetail.push(`catalog-miss: ${rc.lineItemCode}`);
          console.warn(`[finalize] catalog miss for ${rc.lineItemCode}; skipping line`);
          continue;
        }

        // Determine vendor from `assigned_to` field (we re-use that field as the
        // vendor selector in the rate card form).
        const vendor = ans.assignedTo || 'Unassigned';

        // Re-run math with current rates
        const calc = calculateLine(
          catalogItem,
          inspection.regionSnapshot || '',
          regions,
          {
            quantity: rc.quantityDecimal,
            tenantBillBackPercent: rc.tenantBillBackPercent,
            customLaborRate: rc.customLaborRate ?? null,
            customAdjustedMaterialCost: rc.customAdjustedMaterialCost ?? null,
            customVendorCost: rc.customVendorCost ?? null,
          }
        );

        // Preferred catalog description is the newer subtext, falling back to
        // the full description for items without one.
        const catalogDesc = (catalogItem.laborSubtext && catalogItem.laborSubtext.trim()) || catalogItem.laborFullDescription || '';
        const storedDescription = ans.answerValue || '';
        // Treat the stored value as a custom/override description if it differs
        // from both the short description and the preferred catalog description.
        const hasCustomDescription = !!storedDescription
          && storedDescription !== catalogItem.laborShortDescription
          && storedDescription !== catalogDesc;

        const line: PdfLineRow = {
          externalId: ans.answerIdExternal,
          section: ans.section,
          category: catalogItem.category,
          subcategory: catalogItem.subcategory,
          lineItemCode: rc.lineItemCode,
          laborShortDescription: catalogItem.laborShortDescription,
          laborFullDescription: hasCustomDescription ? storedDescription : catalogDesc,
          hasCustomDescription,
          laborMeas: catalogItem.laborMeas || '',
          quantity: rc.quantityDecimal,
          vendor,
          vendorCost: calc.vendorCost,
          clientCost: calc.clientCost,
          tenantBillBackPercent: rc.tenantBillBackPercent,
          tenantCost: calc.tenantCost,
          afterPhotoUrls: ans.afterPhotoUrls || [],
        };

        group.lines.push(line);
        // Round each line then sum (matches per-line stored totals + the form's
        // grand totals) so the PDF can't drift a cent from the stored values.
        group.vendorTotal += roundMoney(calc.vendorCost);
        group.clientTotal += roundMoney(calc.clientCost);
        group.tenantTotal += roundMoney(calc.tenantCost);
      } else if (ans.answerType === 'section_photo') {
        const s = resolveSection(ans.section, ans.location);
        // Recover a renamed section's photos too (same rationale as lines above),
        // so a renamed section's evidence photos aren't dropped from the report.
        const group = s ? sectionGroups.get(s.id) : getOrCreateUnresolvedGroup(ans.section, ans.location);
        if (!group) continue;
        group.photoUrls = ans.photoUrls || [];
      }
    }

    // Grand totals
    let grandVendor = 0;
    let grandClient = 0;
    let grandTenant = 0;
    let grandLineCount = 0;
    for (const g of sectionGroups.values()) {
      grandVendor += g.vendorTotal;
      grandClient += g.clientTotal;
      grandTenant += g.tenantTotal;
      grandLineCount += g.lines.length;
    }

    // Zero line items normally means a mistake — but a Zero Dollar Turn is the
    // explicit, intended $0 case, so allow it through.
    if (grandLineCount === 0 && !zeroDollarTurn) {
      return res.status(400).json({
        error: 'Cannot finalize: no line items have been added to this inspection.',
      });
    }

    // Early-warning guard: if a meaningful share of lines couldn't be placed, a
    // grouping/catalog regression likely shipped. Log loudly (and we attach the
    // summary to the response below). Threshold kept low so it can't go unnoticed.
    // NOTE: no-section lines are now RECOVERED (grouped under their stored label),
    // not dropped — so only a catalog miss is a genuine drop. recoveredNoSection
    // is surfaced separately so a spike (e.g. many renamed sections) is visible.
    const droppedTotal = droppedNoSection + droppedCatalogMiss;
    const dropRate = totalLineAnswers > 0 ? droppedTotal / totalLineAnswers : 0;
    let groupingWarning: { totalLines: number; dropped: number; droppedNoSection: number; droppedCatalogMiss: number; recoveredNoSection: number; dropRate: number; sample: string[] } | null = null;
    if (droppedTotal > 0 || recoveredNoSection > 0) {
      groupingWarning = {
        totalLines: totalLineAnswers, dropped: droppedTotal,
        droppedNoSection, droppedCatalogMiss, recoveredNoSection,
        dropRate: Math.round(dropRate * 1000) / 1000,
        sample: droppedDetail,
      };
      const sev = dropRate >= 0.1 ? 'ERROR' : 'warn';
      console.warn(`[finalize] ${sev}: ${droppedTotal}/${totalLineAnswers} lines dropped (${Math.round(dropRate * 100)}%) — ${droppedNoSection} no-section, ${droppedCatalogMiss} catalog-miss, ${recoveredNoSection} recovered-under-stored-label. Sample: ${droppedDetail.join(' | ')}`);
    }

    // Per-line Internal Resolution timing: "Complete Later" lines are exempt
    // from the after-photo requirement. The map is persisted at submit
    // (resolution_timing_json) so the approver — on any device — and this
    // server gate both honor it. Also accept a map in the request body as a
    // fallback (same-device finalize / older inspections).
    const laterLineIds = new Set<string>();
    const applyTimingMap = (raw: any) => {
      if (raw && typeof raw === 'object') {
        for (const [extId, v] of Object.entries(raw)) {
          if (v === 'later') laterLineIds.add(extId);
        }
      }
    };
    try { applyTimingMap(JSON.parse(inspection.resolutionTimingJson || '{}')); } catch { /* ignore */ }
    applyTimingMap((req.body || {}).resolutionTimings);

    // Internal Resolution lines REQUIRE after-photos (in-house proof of work),
    // UNLESS marked "Complete Later". Gated on the property existing so this
    // can't block before the migration (a first re-finalize is exempt — it's a
    // regeneration, not a fresh submit).
    if (!isRefinalize && await answerHasAfterPhotoProperty()) {
      const missingAfter: string[] = [];
      for (const g of sectionGroups.values()) {
        for (const line of g.lines) {
          if (isInternalResolution(line.vendor)
            && !laterLineIds.has(line.externalId)
            && (line.afterPhotoUrls?.length ?? 0) === 0) {
            missingAfter.push(`${g.displayName}: ${line.laborShortDescription}`);
          }
        }
      }
      if (missingAfter.length > 0) {
        return res.status(400).json({
          error: 'After photos are required on every Internal Resolution line before finalizing.',
          missingAfterPhotos: missingAfter,
        });
      }
    }

    // Clean, parenthesis-free template name for cover headers and filenames —
    // the same short label shown in the selector and on the cards.
    const templateLabel = templateLabelFor(inspection.templateType) || 'Rate Card';

    // Final Checklist (scope only) → Master PDF Q&A block. Read the single qa
    // record (JSON in note) and summarize it for display. The parsed answers +
    // completion context are hoisted so step 6c can ALSO materialize each item
    // as its own structured HubSpot answer record (the fc__all blob stays the
    // form's working store; these are an idempotent reporting projection).
    let finalChecklistGroups: FcSummaryGroup[] | undefined;
    let finalChecklistPhotoUrls: string[] | undefined;
    let fcAnswers: FcAnswers | null = null;
    let fcCtx: FcCompletionCtx | null = null;
    // Only render the block when this inspection actually has checklist data.
    // Pre-existing reports (pending approval / completed before this feature)
    // have no fc__all record → no block, so they're unaffected.
    const fcRec = answers.find((a) => a.answerType === 'qa' && a.questionIdExternal === 'fc__all');
    if (inspection.templateType === 'pm_scope_rate_card' && fcRec?.note) {
      let parsed: FcAnswers = {};
      try { parsed = JSON.parse(fcRec.note); } catch { parsed = {}; }
      fcAnswers = parsed;
      fcCtx = {
        septicFee: inspectionData.propertySepticFee ?? null,
        poolFee: inspectionData.propertyPoolFee ?? null,
        airQtyPrefill: inspectionData.propertyAirFiltersTotal ?? null,
        gasProvider: inspectionData.propertyGasProvider ?? null,
        filterOptionsAvailable: true,
        filterPrefills: [
          inspectionData.propertyAirFiltersType1 ?? null,
          inspectionData.propertyAirFiltersType2 ?? null,
          inspectionData.propertyAirFiltersType3 ?? null,
        ],
      };
      finalChecklistGroups = summarizeFinalChecklist(parsed, fcCtx);
      const fcPhotos = finalChecklistPhotos(parsed);
      if (fcPhotos.length > 0) finalChecklistPhotoUrls = fcPhotos;
    }

    // Signed gallery base so every PDF's photos link to a browsable in-app
    // gallery (left/right across all the inspection's photos). Computed from the
    // request origin here (the later shareBase is built after rendering).
    const galleryHost = req.headers['x-forwarded-host'] || req.headers.host || '';
    const galleryProto = (req.headers['x-forwarded-proto'] as string) || 'https';
    const galleryOrigin = galleryHost ? `${galleryProto}://${galleryHost}` : '';
    const photoGalleryBase = galleryOrigin ? buildShortLink(galleryOrigin, id, 'photos') : undefined;

    // Listing line for the header (status · price · listed · Move-In). Prefer the
    // FROZEN snapshot (set at first finalize / re-finalize) so regenerated PDFs
    // keep the listing as it was at completion; fall back to a live lookup on the
    // first finalize before the snapshot exists. Best-effort.
    const listingSnap = parseListingSnapshot(inspectionData.listingSnapshotJson);
    const listing = listingSnap
      || await fetchActiveListingForProperty(inspectionData.propertyIdRef).catch(() => null);
    // Pest/pet marks: frozen snapshot when present (re-finalize/regenerate), else
    // the live property values from this inspection load.
    const pestControlEnrolled = listingSnap ? !!listingSnap.pestControlEnrolled : inspectionData.propertyPestControlEnrolled;
    const tenantHasPet = listingSnap ? !!listingSnap.tenantHasPet : inspectionData.propertyTenantHasPet;

    const ctx: PdfBuildContext = {
      inspectionRecordId: id,
      templateLabel,
      propertyName: inspection.propertyAddressSnapshot || `Property ${inspectionData.propertyIdRef}`,
      inspectorName: inspection.inspectorName || '(Unknown inspector)',
      bedrooms: inspection.bedroomsAtInspection || 0,
      bathrooms: inspection.bathroomsAtInspection || 0,
      squareFootage: inspectionData.propertySquareFootage,
      region: inspection.regionSnapshot || null,
      listingStatus: listing?.listingStatus ?? null,
      listingPrice: listing?.listingPrice ?? null,
      listingDate: listing?.listingDate ?? null,
      moveInDate: listing?.moveInDate ?? null,
      tenantHasPet,
      pestControlEnrolled,
      generatedAtIso: new Date().toISOString(),
      // Submit/approve stamps for the Master PDF. Approver = the current
      // finalizer (or the previously-recorded approver on a re-finalize).
      submittedAtIso: inspection.submittedAt || null,
      approverName: (isRefinalize ? inspection.approvedByName : (session.name || session.email)) || null,
      approvedAtIso: (isRefinalize ? inspection.approvedAt : new Date().toISOString()) || null,
      // Preserve the section instance ordering
      sections: sectionInstances.map((s) => sectionGroups.get(s.id)!).filter(Boolean),
      grandTotals: { vendor: grandVendor, client: grandClient, tenant: grandTenant, lineCount: grandLineCount },
      finalChecklist: finalChecklistGroups,
      finalChecklistPhotos: finalChecklistPhotoUrls,
      photoGalleryBase,
    };

    // Resolve the state code once: prefer property.state_code, else first two
    // letters of the region ("AL: Birmingham" -> "AL"). Used by the xlsx, the
    // email subject, and the team{ST}@resihome.com CC. Blank if neither works.
    const resolvedStateCode = resolveStateCode(
      inspectionData.propertyStateCode,
      inspection.regionSnapshot,
    );

    // ---- 3b. Downscale every embedded photo ONCE ----
    // The cells are tiny (90×65pt) but photos are stored at ~1280px/600KB —
    // embedding them full-size made finalized PDFs tens of MB and slow to scroll.
    // Fetch + shrink each unique photo to a small thumbnail data URI up front and
    // hand the map to every PDF (the photo LINK still points at the full gallery).
    // Best-effort: on failure the map is partial/empty and the renderer falls back
    // to the full URL, so a hiccup never blocks finalize.
    try {
      const photoEntries: string[] = [];
      for (const g of sectionGroups.values()) {
        photoEntries.push(...(g.photoUrls || []));
        for (const l of g.lines) if (l.afterPhotoUrls?.length) photoEntries.push(...l.afterPhotoUrls);
      }
      if (finalChecklistPhotoUrls?.length) photoEntries.push(...finalChecklistPhotoUrls);
      if (photoEntries.length > 0) {
        ctx.embeddedPhotoByUrl = await buildEmbeddedPhotoMap(photoEntries);
      }
    } catch (e) {
      console.warn('[finalize] photo downscale pre-pass failed (embedding full-size):', e);
    }

    // ---- 4. Render PDFs ----
    // Render the Master FIRST and alone. Two reasons: (1) it always exists, so
    // it's the natural warm-up, and (2) @react-pdf's yoga-layout WASM engine has
    // a one-time async-init race — kicking off concurrent renders before it's
    // initialized throws ("Expected … Config"). After this first render yoga is
    // warm, so the rest can safely overlap.
    //
    // Then render Chargeback + the per-vendor PDFs concurrently. renderVendorPdfs
    // uses its OWN bounded pool (2-wide) so peak concurrent renders stay capped
    // (each transiently allocates 100+ MB). Every render is self-contained — the
    // photo-gallery base flows through React context, not a shared global — so
    // overlapping them can't cross-wire one PDF's gallery links into another.
    // Render only the requested kinds (selective regen rebuilds a subset; a full
    // finalize / unfiltered regen renders all three). @react-pdf needs ONE render
    // awaited alone first to warm yoga — whichever kind renders first serves as
    // that warm-up, then the remaining kinds overlap.
    const renderVendor = () => renderVendorPdfs(ctx, regenerateVendor ? { onlyVendor: regenerateVendor } : undefined);
    let masterBuf: Buffer | null = null;
    let chargebackBuf: Buffer | null = null;
    let vendorBufs: Map<string, Buffer> = new Map();
    if (genMaster) {
      masterBuf = await renderMasterPdf(ctx);
      const [cb, vb] = await Promise.all([
        genChargeback ? renderChargebackPdf(ctx) : Promise.resolve<Buffer | null>(null),
        genVendor ? renderVendor() : Promise.resolve(new Map<string, Buffer>()),
      ]);
      chargebackBuf = cb; vendorBufs = vb;
    } else if (genChargeback) {
      chargebackBuf = await renderChargebackPdf(ctx);
      if (genVendor) vendorBufs = await renderVendor();
    } else if (genVendor) {
      vendorBufs = await renderVendor();
    }

    // Pretty file naming. New format puts the file TYPE first so files sort
    // and read clearly:
    //   "{Type} Rate Card - {street} {city} {ST} {zip} - {M/D/YY}.pdf"
    // e.g. "Master Rate Card - 3020 Walker St Fultondale AL 35068 - 5/29/26.pdf"
    //
    // Build a full address from the property fields (street/city/state/zip),
    // falling back to the snapshot if the structured fields are missing.
    const fullAddressParts = [
      inspectionData.propertyAddressStreet || '',
      inspectionData.propertyCity || '',
      resolvedStateCode,
      inspectionData.propertyZip || '',
    ].map((s) => (s || '').trim()).filter(Boolean);
    const rawAddress = fullAddressParts.length > 0
      ? fullAddressParts.join(' ')
      : (ctx.propertyName || 'property');
    const safeAddress = rawAddress
      .replace(/[^a-zA-Z0-9_\-\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 90);
    // Date as M/D/YY (e.g. "5/29/26"). Slashes are illegal in filenames on
    // most filesystems, so render with hyphens: "5-29-26".
    const d = new Date(ctx.generatedAtIso);
    const datePart = `${d.getMonth() + 1}-${d.getDate()}-${String(d.getFullYear()).slice(2)}`;

    // "Rate Card" suffix is constant; the leading word is the file type.
    const masterFilename = `Master Rate Card - ${safeAddress} - ${datePart}.pdf`;
    const chargebackFilename = `Tenant Chargeback Rate Card - ${safeAddress} - ${datePart}.pdf`;
    function vendorFilename(vendor: string) {
      const v = vendor.replace(/[^a-zA-Z0-9_\-\s]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
      return `${v} Rate Card - ${safeAddress} - ${datePart}.pdf`;
    }
    const chargebackXlsxFilename = `Tenant Chargeback Import - ${safeAddress} - ${datePart}.xlsx`;

    // ---- 4b. Generate Tenant Chargeback xlsx (importer file) ----
    // Only generated if there are chargeback lines. Pulled property fields
    // (entity_id, last_primary_tenant, address, city, state_code, zip_code)
    // come from inspectionData. Missing fields render as blank cells.
    //
    // Re-finalize of a previously-completed scope ONLY refreshes the PDFs: the
    // xlsx is NOT regenerated and NOT re-dropped to SFTP (and the email +
    // maintenance ticket are already skipped below). A re-save just makes the
    // PDFs latest — nothing outbound fires again.
    // Zero Dollar Turn has no chargeback lines → skip the xlsx render AND the
    // SFTP tenant-charge import entirely (both keyed off this buffer).
    // Skip the xlsx regen + SFTP drop when: already imported (durable stamp —
    // survives reopen, so the corrected re-finalize can't re-bill), a Zero Dollar
    // Turn (no chargeback), or any isRefinalize (prior guard — still covers a
    // status=completed re-finalize even before the stamp property is provisioned,
    // so there's no regression until it exists).
    const chargebackXlsxBuf = (chargebackAlreadyImported || isRefinalize || zeroDollarTurn) ? null : await renderChargebackXlsx(ctx, {
      entityId: inspectionData.propertyEntityId || '',
      primaryTenantName: inspectionData.propertyLastPrimaryTenant || '',
      addressStreet: inspectionData.propertyAddressStreet || '',
      city: inspectionData.propertyCity || '',
      stateCode: resolvedStateCode,
      zipCode: inspectionData.propertyZip || '',
      dueDate: new Date(),
    });

    // ---- 5. Upload PDFs to HubSpot Files ----
    // Upload every generated file to HubSpot CONCURRENTLY (rendering above is
    // already parallel). uploadFileWithId routes through the shared HubSpot
    // request governor, so this respects our configured concurrency cap.
    // overwrite=true so re-running Finalize on a reopened inspection REPLACES
    // the old PDFs in place (same URL, same record) instead of leaving them
    // as orphans + creating "-1.pdf" duplicates. The Tenant Charge Import SFTP
    // push is independent of the HubSpot uploads, so it rides along in parallel.
    const vendorEntries = [...vendorBufs.entries()];
    const [masterUp, chargebackUp, chargebackXlsxUp, vendorUps, sftpRes] = await Promise.all([
      masterBuf
        ? uploadFileWithId(masterBuf, masterFilename, 'application/pdf', '/inspection_pdfs', true)
        : Promise.resolve(null),
      chargebackBuf
        ? uploadFileWithId(chargebackBuf, chargebackFilename, 'application/pdf', '/inspection_pdfs', true)
        : Promise.resolve(null),
      chargebackXlsxBuf
        ? uploadFileWithId(chargebackXlsxBuf, chargebackXlsxFilename, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '/inspection_pdfs', true)
        : Promise.resolve(null),
      Promise.all(vendorEntries.map(([vendor, buf]) =>
        uploadFileWithId(buf, vendorFilename(vendor), 'application/pdf', '/inspection_pdfs', true)
          .then((up) => [vendor, up] as const))),
      chargebackXlsxBuf
        // uploadToSftp is designed not to throw, but stay defensive.
        ? uploadToSftp(chargebackXlsxFilename, chargebackXlsxBuf).catch((e: any) =>
            ({ ok: false, configured: true, error: String(e?.message || e).slice(0, 220) } as SftpUploadResult))
        : Promise.resolve(null),
    ]);

    // Existing stored URLs — preserved for any kind NOT regenerated this run, so
    // a selective regen (e.g. Master only) never blanks the vendor/chargeback URLs.
    const existingVendorUrls: Record<string, string> = (() => {
      try { const o = JSON.parse(inspection.pdfVendorUrlsJson || '{}'); return o && typeof o === 'object' ? o : {}; }
      catch { return {}; }
    })();

    // Assemble results in a deterministic order (master, chargeback, xlsx, vendors).
    const attachmentFileIds: string[] = [];
    // Master URL: the freshly-uploaded one when regenerated, else the stored one.
    const masterUrl = masterUp ? masterUp.url : (inspection.pdfMasterUrl || '');
    if (masterUp?.id) attachmentFileIds.push(masterUp.id);

    // Chargeback URL: fresh when regenerated; when NOT regenerated, keep stored;
    // when regenerated but there are no chargeback lines, it's correctly cleared.
    let chargebackUrl: string | null = genChargeback ? null : (inspection.pdfChargebackUrl || null);
    if (chargebackUp) {
      chargebackUrl = chargebackUp.url;
      if (chargebackUp.id) attachmentFileIds.push(chargebackUp.id);
    }

    // Tenant Chargeback Import xlsx — only uploaded if there were chargeback lines
    let chargebackXlsxUrl: string | null = null;
    if (chargebackXlsxUp) {
      chargebackXlsxUrl = chargebackXlsxUp.url;
      if (chargebackXlsxUp.id) attachmentFileIds.push(chargebackXlsxUp.id);
    }

    // Vendor URLs. When vendors weren't regenerated, keep the stored map. When
    // they were, start from the freshly-uploaded set; but if only ONE vendor was
    // targeted (regenerateVendor), MERGE onto the stored map so the other vendors'
    // URLs survive.
    const vendorUrls: Record<string, string> = genVendor
      ? (regenerateVendor ? { ...existingVendorUrls } : {})
      : { ...existingVendorUrls };
    for (const [vendor, up] of vendorUps) {
      vendorUrls[vendor] = up.url;
      if (up.id) attachmentFileIds.push(up.id);
    }

    // ---- 5b. Tenant Charge Import SFTP result (pushed in parallel above) ----
    // Best-effort: NEVER blocks finalize. Reported as a line in the finalize
    // email ("Tenant Charge Import: Successful / Unsuccessful"). No-ops
    // (configured:false) until the SFTP_* env vars are set on Vercel.
    const sftpResult: SftpUploadResult | null = sftpRes;
    if (sftpResult) {
      if (sftpResult.ok) {
        console.log(`[finalize] tenant charge import uploaded to SFTP: ${sftpResult.remotePath}`);
        // Stamp "imported" the INSTANT the drop succeeds (before the status flip
        // and the rest of the pipeline), so a reopen→resubmit→finalize — or a
        // crash-resume — reads chargebackAlreadyImported and does NOT re-drop the
        // xlsx and double-bill the tenant.
        await storeFinalizeStamp('chargeback_import_sent_at', new Date().toISOString(), 'a reopen/re-finalize could RE-IMPORT the tenant charge (double-bill)');
      } else if (sftpResult.configured) {
        console.warn(`[finalize] tenant charge import SFTP upload failed: ${sftpResult.error}`);
      } else {
        console.warn('[finalize] tenant charge import SFTP not configured — skipped.');
      }
    }

    // Attach every generated file to the inspection's Attachments card
    // (best-effort; never blocks finalize).
    if (attachmentFileIds.length > 0) {
      await attachFilesToInspectionRecord(id, attachmentFileIds, 'Move Out Scope report files');
    }

    // ---- 6. Short, clean, signed share links (resolve to the real files) ----
    // /d/<id>/<type>/<sig> on our own domain → 302 to the real HubSpot file.
    // Computed here so they can be stored on the record AND shared in email/ticket.
    const shareHost = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
    const shareProto = (req.headers['x-forwarded-proto'] as string) || 'https';
    const shareBase = `${shareProto}://${shareHost}`;
    // Gate on the EFFECTIVE URLs (which include preserved-from-storage values for
    // kinds not regenerated this run) so a selective regen never blanks a link.
    const shareMasterUrl = masterUrl ? buildShortLink(shareBase, id, 'master') : null;
    const shareChargebackUrl = chargebackUrl ? buildShortLink(shareBase, id, 'chargeback') : null;
    const shareXlsxUrl = (chargebackXlsxBuf && chargebackXlsxUrl) ? buildShortLink(shareBase, id, 'xlsx') : null;
    const shareVendorLinks: Record<string, string> = {};
    for (const vendor of Object.keys(vendorUrls)) {
      shareVendorLinks[vendor] = buildShortLink(shareBase, id, 'vendor', vendor);
    }

    // ---- 6b. Write URLs + short links + completed status back to HubSpot ----
    // Be defensive: if pdf_*/link_* properties don't exist yet (migration not
    // run), we'd 500 here. Catch + retry with just status so the user isn't
    // completely blocked.
    const nowIso = new Date().toISOString();
    const fullUpdate: Record<string, any> = {
      // regenerateOnly refreshes the PDFs in place — keep the CURRENT status
      // (never flip submitted/pending_approval to completed, and don't stamp a
      // completion time). A normal finalize sets completed.
      ...(regenerateOnly ? {} : { status: 'completed', completed_at: nowIso }),
      // Rolled-up scope totals — keep the inspection object authoritative at the
      // moment of approval/finalize (also kept live on every edit via
      // recomputeInspectionTotals in the line-save endpoint).
      total_vendor_cost: ctx.grandTotals.vendor,
      total_client_cost: ctx.grandTotals.client,
      total_tenant_cost: ctx.grandTotals.tenant,
      pdf_master_url: masterUrl,
      pdf_chargeback_url: chargebackUrl || '',
      pdf_vendor_urls_json: JSON.stringify(vendorUrls),
      pdf_generated_at: nowIso,
      // Clean short links (run scripts/short_links to create these properties).
      link_master: shareMasterUrl || '',
      link_chargeback: shareChargebackUrl || '',
      link_vendors_json: JSON.stringify(shareVendorLinks),
      // xlsx is generated + SFTP-dropped on the FIRST finalize only; a re-finalize
      // leaves the stored xlsx url/link untouched (no regen, no re-drop).
      // Write the xlsx URL/link only when we actually generated one this run —
      // NOT gated on !isRefinalize, which would write '' on a reopen re-finalize
      // (where the xlsx was intentionally skipped) and BLANK the stored link.
      ...(chargebackXlsxUrl ? { pdf_chargeback_xlsx_url: chargebackXlsxUrl, link_xlsx: shareXlsxUrl || '' } : {}),
      // Approver stamp (the finalize IS the approval). Set on first finalize so
      // a later regeneration doesn't overwrite the original approver.
      // Approver stamp (the finalize IS the approval). approved_at is a HubSpot
      // datetime → write epoch-ms (ISO strings show as "Invalid date"). Set on
      // first finalize so a later regeneration doesn't overwrite the approver.
      ...(!isRefinalize ? { approved_by_name: session.name || session.email, approved_at: new Date(nowIso).getTime() } : {}),
    };
    finalizePhase = 'persisting-status';
    try {
      await updateInspection(id, fullUpdate);
    } catch (e: any) {
      const msg = String(e?.message || e);
      // If a property is missing on the schema, retry with just status.
      // PDFs are still available to the client via the response below.
      if (msg.includes('PROPERTY_DOESNT_EXIST') || msg.includes('Property') && msg.includes('does not exist')) {
        console.warn('[finalize] pdf_*/link_* properties not on schema — run scripts/rate_card_phase4 + scripts/short_links. Falling back to status-only update.');
        // regenerateOnly must NOT change status even in the fallback.
        if (!regenerateOnly) await updateInspection(id, { status: 'completed', completed_at: nowIso });
      } else {
        throw e;
      }
    }
    // Stamp the FIRST completion timestamp (kept even if re-finalized later)
    // AND freeze the property status for the historical record. Skipped for
    // regenerateOnly — it isn't a completion.
    if (!regenerateOnly) {
      await stampFirstCompleted(id, nowIso);
      await stampPropertyStatusAtCompletion(id);
      await stampListingSnapshotAtCompletion(id);
      // Guarantee a non-null vendor cost on the completed record ($0, or the
      // matched agent's value). Best-effort — never blocks finalize.
      try { await populateBillingFields(id); } catch (e) { console.warn('[finalize] billing populate failed (continuing):', e); }
      // Smart Home Tech → dedicated inspection fields (Device Installed + Serial
      // Number). Best-effort; no-op until the fields are provisioned (/admin/setup).
      if (fcAnswers) {
        try {
          const stamps = fcSmartHomeStamps(fcAnswers);
          const pool = fcPoolStamps(fcAnswers);
          await updateInspection(id, { device_type: stamps.deviceType, device_installed: stamps.deviceInstalled, serial_number: stamps.serialNumber, pool_condition: pool.poolCondition, pool_feedback: pool.poolFeedback, pool_photo_urls: pool.poolPhotoUrls });
        } catch (e) { console.warn('[finalize] smart-home field stamp skipped (provision via /admin/setup):', e); }
      }
    }
    finalizePhase = 'side-effects'; // status is now persisted; remaining steps are best-effort

    // Audit trail: the finalize IS the approval. Distinguish first approval from
    // a re-finalize (regenerated PDFs after a reopen) and a PDFs-only regenerate.
    void recordAuditEvent({
      inspectionId: id,
      action: regenerateOnly ? 'regenerate' : isRefinalize ? 'refinalize' : 'approve',
      actorEmail: session.email,
      actorName: session.name,
      detail: regenerateOnly ? 'Regenerated PDFs' : isRefinalize ? 'Re-finalized (PDFs regenerated)' : 'Approved & finalized',
      meta: { vendor: ctx.grandTotals.vendor, client: ctx.grandTotals.client, tenant: ctx.grandTotals.tenant },
    });

    // Approval alert: notify the inspector who SUBMITTED this for approval, on
    // the first approval only (not re-finalize/regenerate, and never to the
    // approver themselves). Best-effort — inert until VAPID env is configured.
    if (!regenerateOnly && !isRefinalize) {
      const submitter = String(preflight?.submitted_by_email || '').trim().toLowerCase();
      if (submitter && submitter !== session.email.trim().toLowerCase()) {
        const addr = (inspectionData as any)?.property?.full_address || (inspection as any)?.propertyAddressSnapshot || (inspection as any)?.inspectionName || '';
        void sendPushToUser(submitter, {
          title: 'Inspection approved ✓',
          body: `${addr ? addr + ' — ' : ''}approved by ${session.name || session.email}.`,
          url: `/inspection/${id}`,
          tag: `approved-${id}`,
        }).then((r) => console.log(`[push] approval → ${submitter}: ${JSON.stringify(r)}`)).catch(() => {});
      }

      // Scope APPROVED Slack notification (ported from HubSpot Workflow B): post
      // the threaded blue reply on the original pending card + recolor it APPROVED.
      // First approval only. Best-effort — never blocks finalize.
      try {
        const r = await postScopeApproved(id);
        console.log(`[finalize] scope approved Slack for ${id}: ${r.status}${r.error ? ' — ' + r.error : ''}`);
      } catch (e) {
        console.warn('[finalize] scope approved Slack skipped (continuing):', e);
      }
    }

    // ---- 6c. Materialize the Final Checklist as structured answer records ----
    // The form persists the whole checklist as ONE opaque qa blob (fc__all) so it
    // can round-trip the rich state offline. For HubSpot REPORTING we also emit
    // one qa answer record per visible checklist item — each with a readable
    // value (identical to the PDF) plus the raw per-question state in `note`.
    // Idempotent via a stable external id (FC-<inspId>-<questionId>), so a
    // re-finalize updates them in place. Best-effort: it NEVER blocks finalize.
    let fcMaterializeWarning: string | null = null;
    if (fcAnswers && fcCtx) {
      try {
        const existingByExt = new Map(answers.map((x) => [x.answerIdExternal, x.recordId]));
        const fcUpserts = finalChecklistAnswerRecords(fcAnswers, fcCtx).map((rec) => {
          const answerIdExternal = `FC-${id}-${rec.questionId}`;
          return {
            recordId: existingByExt.get(answerIdExternal),
            answerProps: buildQaAnswerProps({
              answerIdExternal,
              inspectionIdExternal: inspection.inspectionIdExternal || '',
              questionIdExternal: rec.questionId,
              questionText: rec.questionText,
              section: `Final Checklist · ${rec.sectionName}`,
              summaryInstanceLabel: '',
              answerValue: rec.value,
              note: JSON.stringify(rec.state || {}),
            }, { isScope: true }),
            questionHubspotRecordId: null,
          };
        });
        if (fcUpserts.length > 0) {
          const fcResults = await upsertAnswers(id, fcUpserts);
          const failed = fcResults.filter((r) => r.failed).length;
          if (failed > 0) fcMaterializeWarning = `${failed} of ${fcUpserts.length} Final Checklist items did not save to HubSpot reporting.`;
        }
      } catch (e) {
        fcMaterializeWarning = `Final Checklist reporting records did not save (${String((e as any)?.message || e).slice(0, 120)}).`;
        console.warn('[finalize] Final Checklist structured-answer materialization failed (non-fatal):', e);
      }
    }

    // ---- 7. Create a maintenance ticket (best-effort, first finalize only) ----
    // Runs BEFORE the email so its pass/fail + ticket link can be reported there.
    // Posts to the Maintenance AI API on the SAME property (hbmm_property_id),
    // with our fixed intro + per-vendor scope-document SHORT links. Never blocks
    // finalize; no-ops until MAINTENANCE_AI_API_KEY is set. Skipped on re-finalize
    // so a reopen doesn't create duplicate tickets.
    let ticketResult: CreateTicketResult | null = null;
    if (ticketAlreadyCreated) {
      // A prior (possibly failed) attempt already created the ticket — don't
      // make a duplicate. Reconstruct the result from the stored id.
      const existingTicketId = Number(String(preflight?.hbmm_ticket_id || '').trim());
      console.log(`[finalize] maintenance ticket already created (#${existingTicketId}) — skipping re-create.`);
      ticketResult = { ok: true, configured: true, ticketId: Number.isFinite(existingTicketId) ? existingTicketId : undefined } as CreateTicketResult;
    } else if (!regenerateOnly) {
      // Gate on the idempotency STAMP (ticketAlreadyCreated above), NOT on
      // isRefinalize: the status flips to 'completed' BEFORE this ticket step,
      // so a crash/timeout in between would make a retry look like a re-finalize
      // and skip the ticket FOREVER. Using !regenerateOnly lets a partial-failure
      // resume re-create the ticket (deduped by the stamp + the tight re-read
      // below), while still never creating one on an admin PDFs-only regenerate.
      try {
        const hbmmId = Number(inspectionData.propertyHbmmId || '');
        if (!inspectionData.propertyHbmmId || !Number.isFinite(hbmmId)) {
          console.warn('[finalize] maintenance ticket skipped — property has no hbmm_property_id.');
          ticketResult = { ok: false, configured: true, error: 'Property has no hbmm_property_id.' };
        } else if (await (async () => {
          // Tight re-read RIGHT before the irreversible create: the preflight
          // marker was read seconds ago (before the whole PDF pipeline), so a
          // CONCURRENT finalize (durable lock fails open / not configured) could
          // have created the ticket in the meantime. Re-checking here shrinks the
          // double-create window from the pipeline duration to ~milliseconds.
          const fresh = await readInspectionProps(id, ['hbmm_ticket_id']).catch(() => null);
          const freshId = Number(String(fresh?.hbmm_ticket_id || '').trim());
          if (freshId && Number.isFinite(freshId)) {
            console.log(`[finalize] maintenance ticket created concurrently (#${freshId}) — skipping re-create.`);
            ticketResult = { ok: true, configured: true, ticketId: freshId } as CreateTicketResult;
            return true; // already created — skip the create branch below
          }
          return false;
        })()) {
          // handled in the IIFE above (ticketResult set)
        } else {
          // Vendor PDFs route across up to three tickets: the Turnkey ticket takes
          // the standard trades; eviction-Future and CapEx are raised on their own
          // tickets (below). If NO turnkey-routed work remains (scope is only
          // eviction/CapEx), the Turnkey ticket is still created as the overall
          // record but CALLED OUT as a $0 Turn.
          const turnkeyHasWork = Object.entries(vendorUrls).some(([v, u]) => (u || '').trim() && vendorTicketKind(v) === 'turnkey');
          ticketResult = await createMaintenanceTicket({
            propertyId: hbmmId,
            description: (zeroDollarTurn || !turnkeyHasWork)
              ? `Zero Dollar Turn${shareMasterUrl ? `\n\nMaster: ${shareMasterUrl}` : ''}`
              : buildTicketDescription(shareVendorLinks, shareMasterUrl, { kind: 'turnkey' }),
          });
          if (ticketResult.ok) {
            const tu = ticketResult.typeUpdate;
            console.log(`[finalize] maintenance ticket created: #${ticketResult.ticketId} on property ${hbmmId}`
              + (tu ? ` · type update ${tu.ok ? 'OK' : `FAILED (status ${tu.status ?? '-'}) ${tu.error || tu.body || ''}`}` : ''));
            // Persist the ticket id (durably — the re-finalize/resume dedup
            // depends on it) for visibility + background doc-upload retries.
            await storeTicketId('hbmm_ticket_id', ticketResult.ticketId);
          } else if (ticketResult.configured) {
            console.warn(`[finalize] maintenance ticket failed: ${ticketResult.error}`);
          } else {
            console.warn('[finalize] maintenance ticket skipped — MAINTENANCE_AI not configured.');
          }
        }
      } catch (e: any) {
        ticketResult = { ok: false, configured: true, error: String(e?.message || e).slice(0, 300) };
        console.warn('[finalize] maintenance ticket threw (caught, finalize continues):', e);
      }
    }
    const ticketUrl = ticketResult?.ok ? buildTicketUrl(ticketResult.ticketId) : null;

    // ---- 7b. Routed extra tickets: Eviction (Future) → its own Evictions-type
    // ticket; CapEx → its own Maintenance-type ticket (NOT forced to Turnkey).
    // Each is created at most ONCE (idempotent via its own stored id), skipped on
    // re-finalize, and never blocks finalize. The matching PDF is attached by the
    // client's per-ticket upload-ticket-docs call (which=eviction|capex).
    let evictionTicketResult: CreateTicketResult | null = null;
    let capexTicketResult: CreateTicketResult | null = null;
    {
      const hbmmId = Number(inspectionData.propertyHbmmId || '');
      // Gate on !regenerateOnly (not !isRefinalize) for the same reason as the
      // Turnkey ticket above: status is already 'completed' by now, so a resumed
      // partial finalize must still be allowed to create these — each is deduped
      // by its own stored id (`existing`) checked below.
      const canRoute = !regenerateOnly && !!inspectionData.propertyHbmmId && Number.isFinite(hbmmId);
      const hasKind = (k: 'eviction' | 'capex') =>
        Object.entries(vendorUrls).some(([v, u]) => (u || '').trim() && vendorTicketKind(v) === k);
      // Tight re-read of BOTH routed ticket ids RIGHT before the irreversible
      // creates (mirrors the Turnkey re-read above): the preflight markers were
      // read before the ~30s PDF pipeline, so a CONCURRENT finalize on another
      // serverless instance (the in-flight Map is per-instance; the durable lock
      // is best-effort) could have created these in the meantime. Re-reading here
      // shrinks the double-create window from the pipeline duration to ~ms.
      const routedFresh = (canRoute && (hasKind('eviction') || hasKind('capex')))
        ? await readInspectionProps(id, ['hbmm_eviction_ticket_id', 'hbmm_capex_ticket_id']).catch(() => null)
        : null;
      const freshEvictionId = String(routedFresh?.hbmm_eviction_ticket_id ?? preflight?.hbmm_eviction_ticket_id ?? '').trim();
      const freshCapexId = String(routedFresh?.hbmm_capex_ticket_id ?? preflight?.hbmm_capex_ticket_id ?? '').trim();
      // Eviction (Future) ticket.
      if (canRoute && hasKind('eviction')) {
        const existing = Number(freshEvictionId);
        if (existing && Number.isFinite(existing)) {
          evictionTicketResult = { ok: true, configured: true, ticketId: existing } as CreateTicketResult;
          console.log(`[finalize] eviction ticket already created (#${existing}) — skipping re-create.`);
        } else {
          try {
            evictionTicketResult = await createMaintenanceTicket({
              propertyId: hbmmId,
              description: buildTicketDescription(shareVendorLinks, shareMasterUrl, { kind: 'eviction' }),
              categoryIds: [TICKET_CATEGORY_EVICTION],
              ticketTypeId: TICKET_TYPE_EVICTION,
            });
            if (evictionTicketResult.ok) {
              console.log(`[finalize] eviction ticket created: #${evictionTicketResult.ticketId} (type ${TICKET_TYPE_EVICTION}) on property ${hbmmId}`);
              await storeTicketId('hbmm_eviction_ticket_id', evictionTicketResult.ticketId);
            } else if (evictionTicketResult.configured) {
              console.warn(`[finalize] eviction ticket failed: ${evictionTicketResult.error}`);
            }
          } catch (e: any) {
            evictionTicketResult = { ok: false, configured: true, error: String(e?.message || e).slice(0, 300) };
            console.warn('[finalize] eviction ticket threw (caught, finalize continues):', e);
          }
        }
      }
      // CapEx ticket — Maintenance (default) type: never force Turnkey.
      if (canRoute && hasKind('capex')) {
        const existing = Number(freshCapexId);
        if (existing && Number.isFinite(existing)) {
          capexTicketResult = { ok: true, configured: true, ticketId: existing } as CreateTicketResult;
          console.log(`[finalize] capex ticket already created (#${existing}) — skipping re-create.`);
        } else {
          try {
            capexTicketResult = await createMaintenanceTicket({
              propertyId: hbmmId,
              description: buildTicketDescription(shareVendorLinks, shareMasterUrl, { kind: 'capex' }),
              categoryIds: [TICKET_CATEGORY_CAPEX],
              skipTypeUpdate: true, // leave the type as the API default (Maintenance)
            });
            if (capexTicketResult.ok) {
              console.log(`[finalize] capex ticket created: #${capexTicketResult.ticketId} (default/Maintenance type) on property ${hbmmId}`);
              await storeTicketId('hbmm_capex_ticket_id', capexTicketResult.ticketId);
            } else if (capexTicketResult.configured) {
              console.warn(`[finalize] capex ticket failed: ${capexTicketResult.error}`);
            }
          } catch (e: any) {
            capexTicketResult = { ok: false, configured: true, error: String(e?.message || e).slice(0, 300) };
            console.warn('[finalize] capex ticket threw (caught, finalize continues):', e);
          }
        }
      }
    }
    const evictionTicketUrl = evictionTicketResult?.ok ? buildTicketUrl(evictionTicketResult.ticketId) : null;
    const capexTicketUrl = capexTicketResult?.ok ? buildTicketUrl(capexTicketResult.ticketId) : null;

    // ---- 8. Email notification (Gmail send) ----
    // Composed regardless of whether Gmail is connected, so the result
    // modal can still preview where it WOULD have gone. Actual send may
    // no-op until OAuth is wired up. Wrapped in try/catch so an email
    // failure never blocks finalize completion.
    let emailResult: Awaited<ReturnType<typeof sendInspectionEmail>> | null = null;
    if (emailAlreadySent) {
      // The damages email already went out on a prior finalize (its send stamped
      // finalize_email_sent_at) — don't re-send. Checked FIRST, and gating on the
      // STAMP rather than isRefinalize is deliberate: status flips to 'completed'
      // BEFORE the email step, so a crash/timeout in between would make a retry
      // look like a re-finalize and skip the email FOREVER (the damages email to
      // soda@ + team silently never sends). The stamp is the true "already sent"
      // signal — a genuine reopen has it set (skip here); a post-flip resume does
      // NOT (falls through and sends). regenerateOnly is an admin PDF refresh, so
      // it must never send.
      emailResult = {
        sent: false,
        reason: 'already_sent',
        message: 'Email already sent on a previous finalize attempt; not re-sending.',
      } as any;
    } else if (regenerateOnly) {
      emailResult = {
        sent: false,
        reason: 'regenerate_skipped',
        message: 'Email not sent — PDFs-only regeneration.',
      } as any;
    } else {
    try {
      // Inspection URLs for the body. The app URL uses the request's host;
      // the HubSpot URL uses sandbox portal 51415639 (placeholder per Hayden).
      const appHost = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
      const appProto = (req.headers['x-forwarded-proto'] as string) || 'https';
      const appUrl = `${appProto}://${appHost}/inspection/${id}`;
      const inspectionTypeId = process.env.HUBSPOT_INSPECTION_TYPE_ID || '';
      // Portal ID for building the HubSpot record link in the email. Reads from
      // env so prod points at the prod portal; falls back to the sandbox id.
      const HUBSPOT_PORTAL_ID = process.env.HUBSPOT_PORTAL_ID || '51415639';
      const hubspotUrl = inspectionTypeId
        ? `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/${inspectionTypeId}/${id}`
        : `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-1/${id}`;

      const payload = composeInspectionEmail({
        ctx,
        prop: {
          addressStreet: inspectionData.propertyAddressStreet || '',
          city: inspectionData.propertyCity || '',
          stateCode: resolvedStateCode,
          zipCode: inspectionData.propertyZip || '',
          teamGroupEmail: inspectionData.propertyTeamGroupEmail,
        },
        links: { appUrl, hubspotUrl },
        // CC the inspector (from the HubSpot inspection record) on the finalize
        // email so they get a copy of the scope report they completed.
        inspectorEmail: inspection.inspectorEmail,
        attachments: {
          masterPdf: { name: masterFilename, url: masterUrl },
          chargebackPdf: chargebackBuf && chargebackUrl ? { name: chargebackFilename, url: chargebackUrl } : null,
          chargebackXlsx: chargebackXlsxBuf && chargebackXlsxUrl ? { name: chargebackXlsxFilename, url: chargebackXlsxUrl } : null,
          vendorPdfs: Object.entries(vendorUrls).map(([vendor, url]) => ({
            vendor, url, name: vendorFilename(vendor),
          })),
        },
        // Report the SFTP delivery status of the Tenant Chargeback Import xlsx.
        // Only included when we actually had an xlsx to push.
        tenantImport: chargebackXlsxBuf && sftpResult
          ? {
              ok: sftpResult.ok,
              configured: sftpResult.configured,
              remotePath: sftpResult.remotePath,
              error: sftpResult.error,
            }
          : null,
        // Clean short links (resolve to the real files) for the body/Files
        // section. Attachments above still use the real URLs for fetching.
        shareLinks: {
          masterPdf: shareMasterUrl,
          chargebackPdf: shareChargebackUrl,
          chargebackXlsx: shareXlsxUrl,
          vendorPdfs: shareVendorLinks,
        },
        // Maintenance ticket result → "Maintenance Ticket: ✅ #123 [View]" line.
        maintenanceTicket: ticketResult
          ? {
              ok: ticketResult.ok,
              configured: ticketResult.configured,
              ticketId: ticketResult.ticketId,
              url: ticketUrl,
              error: ticketResult.error,
            }
          : null,
      });

      emailResult = await sendInspectionEmail(payload, session.email, req);
      // Stamp that the email actually went out, so a later resume/reopen won't
      // re-send it (this stamp is now the sole "already sent" guard). Retried
      // for reliability — a lost stamp is what would let a resume send a
      // duplicate. Needs the `finalize_email_sent_at` property to exist.
      if (emailResult?.sent) {
        await storeFinalizeStamp('finalize_email_sent_at', new Date().toISOString(), 'a resume/reopen could send a DUPLICATE email');
      }
    } catch (e: any) {
      console.error('[finalize] email send threw (caught, finalize continues):', e);
      emailResult = {
        sent: false,
        reason: 'send_failed',
        message: String(e?.message || e).slice(0, 300),
      };
    }
    }

    // ---- Background SFTP watch ----
    // We dropped the Tenant Chargeback xlsx and emailed the inspection. Now kick
    // off a SILENT background watch (no app/desktop alerts): the cron polls the
    // SFTP Errors/Processed folders for ~10 min; if the importer errors the file,
    // it replies to THIS email with the error file attached. Only when we have
    // everything needed to act later: a successful drop, a sent email we can
    // thread a reply to, and the sender's Gmail token to send it.
    try {
      // Arm the watch for EVERY successful drop — not only when the finalize
      // email sent. A pre-check/import error must never be silently missed.
      // If the email sent, we reply in that thread; otherwise the sweep sends a
      // standalone notification to the submitter. With no Gmail token at all, the
      // sweep still records the error on the inspection in HubSpot.
      if (chargebackXlsxBuf && sftpResult?.ok) {
        const refreshToken = getGmailRefreshToken(req);
        const droppedAt = Date.now();
        const submitter = String(preflight?.submitted_by_email || '').trim();
        const replyTo = (emailResult?.sent && emailResult.recipients?.to?.length)
          ? emailResult.recipients.to
          : [submitter || session.email].filter(Boolean);
        await enqueueSftpWatch({
          id: `${id}-${droppedAt}`,
          inspectionId: id,
          droppedFilename: chargebackXlsxFilename,
          addressKey: safeAddress,
          droppedAt,
          watchUntil: droppedAt + WATCH_WINDOW_MS,
          reply: {
            to: replyTo,
            cc: (emailResult?.sent && emailResult.recipients?.cc) || [],
            subject: emailResult?.subject || `Tenant Chargeback Import — ${safeAddress}`,
            messageId: (emailResult?.sent && emailResult.messageId) || '',
            threadId: (emailResult?.sent && emailResult.threadId) || undefined,
            fromEmail: session.email,
          },
          encToken: refreshToken ? encryptToken(refreshToken) : '',
        });
        if (!refreshToken) {
          console.warn('[finalize] SFTP watch armed WITHOUT a Gmail token — import errors will be recorded in HubSpot but not emailed.');
        }
        // Mark it pending so the outcome is visible in HubSpot while we watch.
        try {
          await updateInspection(id, { sftp_import_result: 'pending', sftp_import_checked_at: droppedAt });
        } catch { /* properties may not exist yet — non-fatal */ }
      }
    } catch (e) {
      console.warn('[finalize] could not enqueue SFTP watch (non-fatal):', e);
    }

    bustInspectionsCache(); // status → completed; reflect in the list at once
    const elapsed = Date.now() - t0;
    void completeFinalizeJob(finalizeJobId, { inspectionId: id, mode: finalizeMode, status: 'succeeded', phase: 'completed', elapsedMs: elapsed, actorEmail: session.email });
    return res.status(200).json({
      success: true,
      elapsedMs: elapsed,
      generatedAt: nowIso,
      pdfs: {
        // Hand the client the clean short links (resolve to the real files) so
        // the post-finalize "Downloads" use them everywhere.
        master: { name: masterFilename, url: shareMasterUrl || masterUrl },
        chargeback: chargebackUrl ? { name: chargebackFilename, url: shareChargebackUrl || chargebackUrl } : null,
        chargebackXlsx: chargebackXlsxBuf ? { name: chargebackXlsxFilename, url: shareXlsxUrl || chargebackXlsxUrl } : null,
        vendors: Object.entries(vendorUrls).map(([vendor, url]) => ({
          vendor,
          name: vendorFilename(vendor),
          url: shareVendorLinks[vendor] || url,
        })),
      },
      email: emailResult,
      ...(fcMaterializeWarning ? { fcMaterializeWarning } : {}),
      maintenanceTicket: ticketResult ? { ...ticketResult, url: ticketUrl } : null,
      maintenanceTicketEviction: evictionTicketResult ? { ...evictionTicketResult, url: evictionTicketUrl } : null,
      maintenanceTicketCapex: capexTicketResult ? { ...capexTicketResult, url: capexTicketUrl } : null,
      totals: {
        vendor: ctx.grandTotals.vendor,
        client: ctx.grandTotals.client,
        tenant: ctx.grandTotals.tenant,
        lineCount: ctx.grandTotals.lineCount,
      },
      lineGroupingWarning: groupingWarning,
    });
  } catch (e: any) {
    const elapsed = Date.now() - t0;
    // Finalize is the most consequential server path — surface failures to the
    // monitoring channel (with the phase it died in) instead of only the logs.
    reportServerError(e, { route: 'POST /api/inspections/[id]/finalize', method: 'POST', userEmail: session.email, inspectionId: id, phase: finalizePhase, extra: { mode: finalizeMode, elapsedMs: elapsed } });
    void completeFinalizeJob(finalizeJobId, { inspectionId: id, mode: finalizeMode, status: 'failed', phase: finalizePhase, error: String(e?.message || e), elapsedMs: elapsed, actorEmail: session.email });
    return res.status(500).json({ error: 'Finalize failed. Please try again.', elapsedMs: elapsed });
  } finally {
    inFlightFinalize.delete(id);
    // Release the durable lock so a legitimate re-finalize isn't blocked.
    if (durableLockHeld) {
      try { await updateInspection(id, { [FINALIZE_LOCK_PROP]: '' }); } catch { /* non-fatal */ }
    }
  }
}
