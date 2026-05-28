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
  fetchRateCardCatalog,
  fetchRegionRates,
  uploadFile,
  updateInspection,
} from '@/lib/hubspot';
import { resolveSections, type SectionInstance } from '@/lib/sections';
import { calculateLine } from '@/lib/rateCardMath';
import { renderMasterPdf } from '@/lib/pdfMaster';
import { renderChargebackPdf } from '@/lib/pdfChargeback';
import { renderVendorPdfs } from '@/lib/pdfVendor';
import type { PdfBuildContext, PdfSectionGroup, PdfLineRow } from '@/lib/pdfShared';

export const config = {
  api: {
    // Finalize involves rendering up to ~10 PDFs and uploading them, plus the
    // ZIP. Bump the response body limit headroom for safety; per-request
    // duration ceiling is set in vercel.json.
    responseLimit: false,
  },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'Missing inspection id' });

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

    const [answers, regions, catalog] = await Promise.all([
      fetchAnswersForInspection(id),
      fetchRegionRates(),
      fetchRateCardCatalog(),
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

        const storedDescription = ans.answerValue || '';
        const hasCustomDescription = !!storedDescription && storedDescription !== catalogItem.laborShortDescription;

        const line: PdfLineRow = {
          externalId: ans.answerIdExternal,
          section: ans.section,
          category: catalogItem.category,
          subcategory: catalogItem.subcategory,
          lineItemCode: rc.lineItemCode,
          laborShortDescription: catalogItem.laborShortDescription,
          laborFullDescription: hasCustomDescription ? storedDescription : catalogItem.laborFullDescription,
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
        group.vendorTotal += calc.vendorCost;
        group.clientTotal += calc.clientCost;
        group.tenantTotal += calc.tenantCost;
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

    // ---- 4. Render PDFs ----
    // Sequential to avoid running out of memory on Vercel's lambda. (Each PDF
    // render in @react-pdf can transiently allocate 100+ MB.)
    const masterBuf = await renderMasterPdf(ctx);
    const chargebackBuf = await renderChargebackPdf(ctx);
    const vendorBufs = await renderVendorPdfs(ctx);

    // Pretty file naming. Uses the outer templateLabel computed before ctx.
    const safeAddress = (ctx.propertyName || 'property')
      .replace(/[^a-zA-Z0-9_\-\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    const datePart = new Date(ctx.generatedAtIso).toISOString().slice(0, 10);
    // Master + Chargeback follow the same naming convention as vendor PDFs:
    //   "{Template Label} - {Address} - {Variant} - {Date}.pdf"
    const masterFilename = `${templateLabel} - ${safeAddress} - Master - ${datePart}.pdf`;
    const chargebackFilename = `${templateLabel} - ${safeAddress} - Tenant Chargeback - ${datePart}.pdf`;
    function vendorFilename(vendor: string) {
      const v = vendor.replace(/[^a-zA-Z0-9_\-\s]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
      return `${templateLabel} - ${safeAddress} - ${v} - ${datePart}.pdf`;
    }

    // ---- 5. Upload PDFs to HubSpot Files ----
    // Sequential to stay polite with HubSpot's rate limit.
    // overwrite=true so re-running Finalize on a reopened inspection REPLACES
    // the old PDFs in place (same URL, same record) instead of leaving them
    // as orphans + creating "-1.pdf" duplicates.
    const masterUrl = await uploadFile(masterBuf, masterFilename, 'application/pdf', '/inspection_pdfs', true);

    let chargebackUrl: string | null = null;
    if (chargebackBuf) {
      chargebackUrl = await uploadFile(chargebackBuf, chargebackFilename, 'application/pdf', '/inspection_pdfs', true);
    }

    const vendorUrls: Record<string, string> = {};
    for (const [vendor, buf] of vendorBufs.entries()) {
      const url = await uploadFile(buf, vendorFilename(vendor), 'application/pdf', '/inspection_pdfs', true);
      vendorUrls[vendor] = url;
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

    const elapsed = Date.now() - t0;
    return res.status(200).json({
      success: true,
      elapsedMs: elapsed,
      generatedAt: nowIso,
      pdfs: {
        master: { name: masterFilename, url: masterUrl },
        chargeback: chargebackBuf ? { name: chargebackFilename, url: chargebackUrl } : null,
        vendors: Object.entries(vendorUrls).map(([vendor, url]) => ({
          vendor,
          name: vendorFilename(vendor),
          url,
        })),
      },
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
    return res.status(500).json({ error: String(e?.message || e), elapsedMs: elapsed });
  }
}
