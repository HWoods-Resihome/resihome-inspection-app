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
import JSZip from 'jszip';
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

    // Group answers by section/location for fast lookup
    const sectionLookup = new Map<string, SectionInstance>();
    for (const s of sectionInstances) {
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
        const s = sectionLookup.get(`${ans.section}||${ans.location}`);
        if (!s) continue;   // orphaned answer (section was deleted) — skip
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
        const s = sectionLookup.get(`${ans.section}||${ans.location}`);
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

    const ctx: PdfBuildContext = {
      inspectionRecordId: id,
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

    // Pretty file naming
    const safeAddress = (ctx.propertyName || 'property')
      .replace(/[^a-zA-Z0-9_\-\s]/g, '')
      .replace(/\s+/g, '_')
      .slice(0, 60);
    const datePart = new Date(ctx.generatedAtIso).toISOString().slice(0, 10);
    const masterFilename = `${safeAddress}_Master_${datePart}.pdf`;
    const chargebackFilename = `${safeAddress}_TenantChargeback_${datePart}.pdf`;
    const zipFilename = `${safeAddress}_Inspection_${datePart}.zip`;
    function vendorFilename(vendor: string) {
      const v = vendor.replace(/[^a-zA-Z0-9_\-\s]/g, '').replace(/\s+/g, '_').slice(0, 40);
      return `${safeAddress}_Vendor_${v}_${datePart}.pdf`;
    }

    // ---- 5. Build ZIP bundle ----
    const zip = new JSZip();
    zip.file(masterFilename, masterBuf);
    if (chargebackBuf) zip.file(chargebackFilename, chargebackBuf);
    for (const [vendor, buf] of vendorBufs.entries()) {
      zip.file(vendorFilename(vendor), buf);
    }
    const manifestLines = [
      `ResiHome Inspection — ${ctx.propertyName}`,
      `Inspector: ${ctx.inspectorName}`,
      `Generated: ${ctx.generatedAtIso}`,
      `Lines: ${ctx.grandTotals.lineCount}`,
      `Vendor Total: $${ctx.grandTotals.vendor.toFixed(2)}`,
      `Client Total: $${ctx.grandTotals.client.toFixed(2)}`,
      `Tenant Total: $${ctx.grandTotals.tenant.toFixed(2)}`,
      '',
      'Files included:',
      `  ${masterFilename} (Master report)`,
      ...(chargebackBuf ? [`  ${chargebackFilename} (Tenant Chargeback)`] : []),
      ...Array.from(vendorBufs.keys()).map((v) => `  ${vendorFilename(v)} (Work order for ${v})`),
    ];
    zip.file('manifest.txt', manifestLines.join('\n'));
    const zipBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

    // ---- 6. Upload all files to HubSpot Files ----
    // Sequential to stay polite with HubSpot's rate limit.
    const uploads: { name: string; url: string }[] = [];

    const masterUrl = await uploadFile(masterBuf, masterFilename, 'application/pdf', '/inspection_pdfs');
    uploads.push({ name: masterFilename, url: masterUrl });

    let chargebackUrl: string | null = null;
    if (chargebackBuf) {
      chargebackUrl = await uploadFile(chargebackBuf, chargebackFilename, 'application/pdf', '/inspection_pdfs');
      uploads.push({ name: chargebackFilename, url: chargebackUrl });
    }

    const vendorUrls: Record<string, string> = {};
    for (const [vendor, buf] of vendorBufs.entries()) {
      const url = await uploadFile(buf, vendorFilename(vendor), 'application/pdf', '/inspection_pdfs');
      vendorUrls[vendor] = url;
      uploads.push({ name: vendorFilename(vendor), url });
    }

    const zipUrl = await uploadFile(zipBuf, zipFilename, 'application/zip', '/inspection_pdfs');
    uploads.push({ name: zipFilename, url: zipUrl });

    // ---- 7. Write URLs + completed status back to HubSpot ----
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
      pdf_zip_url: zipUrl,
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
        zip: { name: zipFilename, url: zipUrl },
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
