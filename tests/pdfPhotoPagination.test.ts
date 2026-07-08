import { describe, it, expect } from 'vitest';
import { renderQcPdf, type QcPdfContext } from '@/lib/pdfQc';
import { renderMasterPdf } from '@/lib/pdfMaster';
import { renderVendorPdfs } from '@/lib/pdfVendor';
import type { PdfBuildContext, PdfSectionGroup } from '@/lib/pdfShared';

// Regression guard for the "photos sliced across the page break / bleeding into
// the footer" disaster. Root cause: a section's photo grid was rendered INSIDE a
// wrap={false} block, so a section with enough photos formed one atomic block
// taller than a page — which react-pdf CLIPS (it can't split a wrap={false}
// view) instead of paginating. The fix keeps only the label/header atomic and
// lets PdfSectionPhotos (per-row wrap={false}) flow across pages.
//
// A grid that paginates correctly produces a MULTI-PAGE PDF; a clipped atomic
// block stays crammed on one page. We render far more photos than fit on a
// LETTER page and assert the PDF spans multiple pages.

// 1x1 transparent PNG — embedded so no network fetch is needed at render time.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';

// Count page objects in the raw PDF bytes.
function pageCount(buf: Buffer): number {
  const text = buf.toString('latin1');
  const m = text.match(/\/Type\s*\/Page[^s]/g);
  return m ? m.length : 0;
}
const isPdf = (b: Buffer) => b.length > 1000 && b.slice(0, 5).toString() === '%PDF-';

// N photo URLs + an embedded-thumbnail map covering all of them.
function photos(prefix: string, n: number): { urls: string[]; embedded: Record<string, string> } {
  const urls: string[] = [];
  const embedded: Record<string, string> = {};
  for (let i = 0; i < n; i++) {
    const u = `https://files.example.com/${prefix}-${i}.jpg`;
    urls.push(u);
    embedded[u] = PNG;
  }
  return { urls, embedded };
}

describe('PDF photo grids paginate instead of clipping', () => {
  it('QC report: a section with many before+after photos spans multiple pages', async () => {
    const before = photos('before', 60);
    const after = photos('after', 60);
    const ctx: QcPdfContext = {
      templateLabel: 'Turn Re-Inspect QC',
      propertyName: '47 E Indigo St, Mesa, AZ, 85201',
      inspectorName: 'Tester',
      bedrooms: 3, bathrooms: 2, squareFootage: 1591,
      region: 'AZ: Phoenix', sourceRateCardName: null,
      generatedAtIso: new Date().toISOString(),
      verdict: 'pass', passCount: 1, failCount: 0,
      embeddedByUrl: { ...before.embedded, ...after.embedded },
      sections: [{
        displayName: 'Whole House',
        lines: [{
          category: 'Cleaning', subcategory: 'Sales Clean', unit: 'SF',
          description: 'Level 1 whole-house sales clean', quantity: 1424,
          vendor: 'Vendor 1', vendorCost: 203.85, passFail: 'pass',
        }],
        beforePhotos: before.urls,
        afterPhotos: after.urls,
        passCount: 1, failCount: 0,
      }],
    };
    const buf = await renderQcPdf(ctx);
    expect(isPdf(buf)).toBe(true);
    // 120 photos at 5/row = 24 rows ≈ well over 2 LETTER pages. Clipping would
    // trap them on one page; correct pagination spreads them out.
    expect(pageCount(buf)).toBeGreaterThanOrEqual(3);
  });

  it('Master + Vendor: a line with many after-photos paginates', async () => {
    const after = photos('after', 60);
    const section: PdfSectionGroup = {
      label: 'Kitchen', displayName: 'Kitchen', photoUrls: [],
      vendorTotal: 100, clientTotal: 120, tenantTotal: 60,
      lines: [{
        externalId: 'L1', section: 'Kitchen', category: 'Cleaning', subcategory: 'Kitchen',
        lineItemCode: 'CLN1', laborShortDescription: 'Clean kitchen', laborFullDescription: 'Clean kitchen',
        hasCustomDescription: false, laborMeas: 'EA', quantity: 1, vendor: 'Internal Resolution',
        vendorCost: 100, clientCost: 120, tenantBillBackPercent: 50, tenantCost: 60,
        afterPhotoUrls: after.urls,
      }],
    };
    const base: PdfBuildContext = {
      inspectionRecordId: '12345', templateLabel: 'Scope Rate Card',
      propertyName: '123 Test St', inspectorName: 'Tester',
      bedrooms: 3, bathrooms: 2, squareFootage: 1500,
      region: 'GA: Atlanta', generatedAtIso: new Date().toISOString(),
      sections: [section],
      grandTotals: { vendor: 100, client: 120, tenant: 60, lineCount: 1 },
      embeddedPhotoByUrl: after.embedded,
    };
    const master = await renderMasterPdf(base);
    expect(isPdf(master)).toBe(true);
    expect(pageCount(master)).toBeGreaterThanOrEqual(2);

    const vendorPdfs = await renderVendorPdfs(base);
    const first = [...vendorPdfs.values()][0];
    expect(isPdf(first)).toBe(true);
    expect(pageCount(first)).toBeGreaterThanOrEqual(2);
  });
});
