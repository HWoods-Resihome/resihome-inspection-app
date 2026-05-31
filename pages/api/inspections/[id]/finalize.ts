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
import {
  fetchInspectionWithPropertyRef,
  fetchAnswersForInspection,
  readInspectionProps,
  uploadFileWithId,
  attachFilesToInspectionRecord,
  updateInspection,
} from '@/lib/hubspot';
import { getCachedRegions } from '@/pages/api/rate-card/regions';
import { getCachedCatalog } from '@/pages/api/rate-card/catalog';
import { resolveSections, resolveStateCode, type SectionInstance } from '@/lib/sections';
import { calculateLine, roundMoney } from '@/lib/rateCardMath';
import { renderMasterPdf } from '@/lib/pdfMaster';
import { renderChargebackPdf } from '@/lib/pdfChargeback';
import { renderVendorPdfs } from '@/lib/pdfVendor';
import { renderChargebackXlsx } from '@/lib/xlsxChargeback';
import { composeInspectionEmail } from '@/lib/email';
import { sendInspectionEmail } from '@/lib/gmail';
import type { PdfBuildContext, PdfSectionGroup, PdfLineRow } from '@/lib/pdfShared';

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
      const props = await readInspectionProps(id, [FINALIZE_LOCK_PROP]);
      const prev = props?.[FINALIZE_LOCK_PROP];
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
    const isRefinalize = priorStatus === 'completed' || priorStatus === 'complete' || priorStatus === 'submitted';

    const [answers, regions, catalog] = await Promise.all([
      fetchAnswersForInspection(id),
      getCachedRegions(),
      getCachedCatalog(),
    ]);

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
      // Primary key: location only.
      sectionLookup.set(s.location, s);
      // Secondary key for legacy answers saved before this fix: also accept
      // label||location combos. Harmless duplicate when both are set.
      sectionLookup.set(`${s.label}||${s.location}`, s);
    }

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

    for (const ans of answers) {
      if (ans.answerType === 'rate_card_line' && ans.rateCardLine) {
        // Prefer location-only match (works even if section was renamed);
        // fall back to label||location for very old answers that didn't
        // populate location.
        const s = sectionLookup.get(ans.location) || sectionLookup.get(`${ans.section}||${ans.location}`);
        if (!s) {
          console.warn(`[finalize] no section for answer ${ans.answerIdExternal} (section="${ans.section}" location="${ans.location}")`);
          continue;
        }
        const group = sectionGroups.get(s.id);
        if (!group) continue;

        const rc = ans.rateCardLine;
        const catalogItem = catalog.find((c) => c.lineItemCode === rc.lineItemCode);
        if (!catalogItem) {
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
        };

        group.lines.push(line);
        // Round each line then sum (matches per-line stored totals + the form's
        // grand totals) so the PDF can't drift a cent from the stored values.
        group.vendorTotal += roundMoney(calc.vendorCost);
        group.clientTotal += roundMoney(calc.clientCost);
        group.tenantTotal += roundMoney(calc.tenantCost);
      } else if (ans.answerType === 'section_photo') {
        const s = sectionLookup.get(ans.location) || sectionLookup.get(`${ans.section}||${ans.location}`);
        if (!s) continue;
        const group = sectionGroups.get(s.id);
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

    if (grandLineCount === 0) {
      return res.status(400).json({
        error: 'Cannot finalize: no line items have been added to this inspection.',
      });
    }

    // Strip "(PM) "/"(QC) " prefixes from the template label to get a clean
    // template name for cover headers and filenames. Map from internal
    // template type to a display name (same map as TEMPLATE_LABELS in the UI).
    const TEMPLATE_DISPLAY: Record<string, string> = {
      pm_scope_inspection: 'Scope',
      pm_scope_rate_card: 'Scope Rate Card',
      pm_turn_inspection: 'Turn',
      pm_community_inspection: 'Community',
      pm_property_visit_inspection: 'Property Visit',
      qc_completed_unit_inspection: 'QC Completed Unit',
      preleasing_property_inspection: 'Pre-leasing Property',
      leasing_agent_1099_property_inspection: '1099 Leasing Agent Property',
    };
    const templateLabel = TEMPLATE_DISPLAY[inspection.templateType] || 'Rate Card';

    const ctx: PdfBuildContext = {
      inspectionRecordId: id,
      templateLabel,
      propertyName: inspection.propertyAddressSnapshot || `Property ${inspectionData.propertyIdRef}`,
      inspectorName: inspection.inspectorName || '(Unknown inspector)',
      bedrooms: inspection.bedroomsAtInspection || 0,
      bathrooms: inspection.bathroomsAtInspection || 0,
      squareFootage: inspectionData.propertySquareFootage,
      region: inspection.regionSnapshot || null,
      generatedAtIso: new Date().toISOString(),
      // Preserve the section instance ordering
      sections: sectionInstances.map((s) => sectionGroups.get(s.id)!).filter(Boolean),
      grandTotals: { vendor: grandVendor, client: grandClient, tenant: grandTenant, lineCount: grandLineCount },
    };

    // Resolve the state code once: prefer property.state_code, else first two
    // letters of the region ("AL: Birmingham" -> "AL"). Used by the xlsx, the
    // email subject, and the team{ST}@resihome.com CC. Blank if neither works.
    const resolvedStateCode = resolveStateCode(
      inspectionData.propertyStateCode,
      inspection.regionSnapshot,
    );

    // ---- 4. Render PDFs ----
    // Sequential to avoid running out of memory on Vercel's lambda. (Each PDF
    // render in @react-pdf can transiently allocate 100+ MB.)
    const masterBuf = await renderMasterPdf(ctx);
    const chargebackBuf = await renderChargebackPdf(ctx);
    const vendorBufs = await renderVendorPdfs(ctx);

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
    const chargebackXlsxBuf = await renderChargebackXlsx(ctx, {
      entityId: inspectionData.propertyEntityId || '',
      primaryTenantName: inspectionData.propertyLastPrimaryTenant || '',
      addressStreet: inspectionData.propertyAddressStreet || '',
      city: inspectionData.propertyCity || '',
      stateCode: resolvedStateCode,
      zipCode: inspectionData.propertyZip || '',
      dueDate: new Date(),
    });

    // ---- 5. Upload PDFs to HubSpot Files ----
    // Sequential to stay polite with HubSpot's rate limit.
    // overwrite=true so re-running Finalize on a reopened inspection REPLACES
    // the old PDFs in place (same URL, same record) instead of leaving them
    // as orphans + creating "-1.pdf" duplicates.
    const attachmentFileIds: string[] = [];
    const masterUp = await uploadFileWithId(masterBuf, masterFilename, 'application/pdf', '/inspection_pdfs', true);
    const masterUrl = masterUp.url;
    if (masterUp.id) attachmentFileIds.push(masterUp.id);

    let chargebackUrl: string | null = null;
    if (chargebackBuf) {
      const up = await uploadFileWithId(chargebackBuf, chargebackFilename, 'application/pdf', '/inspection_pdfs', true);
      chargebackUrl = up.url;
      if (up.id) attachmentFileIds.push(up.id);
    }

    // Tenant Chargeback Import xlsx — only uploaded if there were chargeback lines
    let chargebackXlsxUrl: string | null = null;
    if (chargebackXlsxBuf) {
      const up = await uploadFileWithId(
        chargebackXlsxBuf,
        chargebackXlsxFilename,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '/inspection_pdfs',
        true,
      );
      chargebackXlsxUrl = up.url;
      if (up.id) attachmentFileIds.push(up.id);
    }

    const vendorUrls: Record<string, string> = {};
    for (const [vendor, buf] of vendorBufs.entries()) {
      const up = await uploadFileWithId(buf, vendorFilename(vendor), 'application/pdf', '/inspection_pdfs', true);
      vendorUrls[vendor] = up.url;
      if (up.id) attachmentFileIds.push(up.id);
    }

    // Attach every generated file to the inspection's Attachments card
    // (best-effort; never blocks finalize).
    if (attachmentFileIds.length > 0) {
      await attachFilesToInspectionRecord(id, attachmentFileIds, 'Move Out Scope report files');
    }

    // ---- 6. Write URLs + completed status back to HubSpot ----
    // Be defensive: if pdf_* properties don't exist yet (migration not run),
    // we'd 500 here. Catch + try with just status update so the user isn't
    // completely blocked.
    const nowIso = new Date().toISOString();
    const fullUpdate: Record<string, any> = {
      status: 'completed',
      completed_at: nowIso,
      pdf_master_url: masterUrl,
      pdf_chargeback_url: chargebackUrl || '',
      pdf_chargeback_xlsx_url: chargebackXlsxUrl || '',
      pdf_vendor_urls_json: JSON.stringify(vendorUrls),
      pdf_generated_at: nowIso,
    };
    try {
      await updateInspection(id, fullUpdate);
    } catch (e: any) {
      const msg = String(e?.message || e);
      // If a PDF property is missing on the schema, retry with just status.
      // PDFs are still available to the client via the response below.
      if (msg.includes('PROPERTY_DOESNT_EXIST') || msg.includes('Property') && msg.includes('does not exist')) {
        console.warn('[finalize] PDF properties not on schema — run phase4_step1_add_pdf_fields.py. Falling back to status-only update.');
        await updateInspection(id, { status: 'completed', completed_at: nowIso });
      } else {
        throw e;
      }
    }

    // ---- 7. Email notification (Gmail send) ----
    // Composed regardless of whether Gmail is connected, so the result
    // modal can still preview where it WOULD have gone. Actual send may
    // no-op until OAuth is wired up. Wrapped in try/catch so an email
    // failure never blocks finalize completion.
    let emailResult: Awaited<ReturnType<typeof sendInspectionEmail>> | null = null;
    if (isRefinalize) {
      // Re-finalize after a reopen: PDFs are regenerated above, but don't
      // re-send the damages email (avoids duplicate emails to soda@ + team).
      emailResult = {
        sent: false,
        reason: 'refinalize_skipped',
        message: 'Email not re-sent because this inspection was already completed.',
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
        },
        links: { appUrl, hubspotUrl },
        attachments: {
          masterPdf: { name: masterFilename, url: masterUrl },
          chargebackPdf: chargebackBuf && chargebackUrl ? { name: chargebackFilename, url: chargebackUrl } : null,
          chargebackXlsx: chargebackXlsxBuf && chargebackXlsxUrl ? { name: chargebackXlsxFilename, url: chargebackXlsxUrl } : null,
          vendorPdfs: Object.entries(vendorUrls).map(([vendor, url]) => ({
            vendor, url, name: vendorFilename(vendor),
          })),
        },
      });

      emailResult = await sendInspectionEmail(payload, session.email, req);
    } catch (e: any) {
      console.error('[finalize] email send threw (caught, finalize continues):', e);
      emailResult = {
        sent: false,
        reason: 'send_failed',
        message: String(e?.message || e).slice(0, 300),
      };
    }
    }

    const elapsed = Date.now() - t0;
    return res.status(200).json({
      success: true,
      elapsedMs: elapsed,
      generatedAt: nowIso,
      pdfs: {
        master: { name: masterFilename, url: masterUrl },
        chargeback: chargebackBuf ? { name: chargebackFilename, url: chargebackUrl } : null,
        chargebackXlsx: chargebackXlsxBuf ? { name: chargebackXlsxFilename, url: chargebackXlsxUrl } : null,
        vendors: Object.entries(vendorUrls).map(([vendor, url]) => ({
          vendor,
          name: vendorFilename(vendor),
          url,
        })),
      },
      email: emailResult,
      totals: {
        vendor: ctx.grandTotals.vendor,
        client: ctx.grandTotals.client,
        tenant: ctx.grandTotals.tenant,
        lineCount: ctx.grandTotals.lineCount,
      },
    });
  } catch (e: any) {
    const elapsed = Date.now() - t0;
    console.error(`[finalize] failed after ${elapsed}ms:`, e);
    return res.status(500).json({ error: 'Finalize failed. Please try again.', elapsedMs: elapsed });
  } finally {
    inFlightFinalize.delete(id);
    // Release the durable lock so a legitimate re-finalize isn't blocked.
    if (durableLockHeld) {
      try { await updateInspection(id, { [FINALIZE_LOCK_PROP]: '' }); } catch { /* non-fatal */ }
    }
  }
}
