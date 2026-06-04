import { describe, it, expect, beforeAll } from 'vitest';
import { renderMasterPdf } from '@/lib/pdfMaster';
import { renderVendorPdfs } from '@/lib/pdfVendor';
import type { PdfBuildContext, PdfSectionGroup } from '@/lib/pdfShared';

// Guards the #10 parallelization: PDFs now render CONCURRENTLY, and each one's
// photo-gallery base is supplied through React context (not a shared mutable
// global). These tests prove (a) react-pdf accepts the context provider we put
// inside each Document — renders don't throw and produce real PDF bytes — and
// (b) concurrent renders with DIFFERENT gallery bases don't cross-wire: each
// PDF embeds only its OWN scoped gallery links. If the old global came back,
// the racing renders would leak each other's base and this would fail.

const PHOTO = 'https://files.example.com/photo-MASTERROOM.jpg';
const AFTER = 'https://files.example.com/after-PPWLINE.jpg';

function section(): PdfSectionGroup {
  return {
    label: 'Kitchen',
    displayName: 'Kitchen',
    photoUrls: [PHOTO],
    vendorTotal: 100, clientTotal: 120, tenantTotal: 60,
    lines: [{
      externalId: 'L1', section: 'Kitchen', category: 'Cleaning', subcategory: 'Kitchen',
      lineItemCode: 'CLN1', laborShortDescription: 'Clean kitchen', laborFullDescription: 'Clean kitchen',
      hasCustomDescription: false, laborMeas: 'EA', quantity: 1, vendor: 'PPW',
      vendorCost: 100, clientCost: 120, tenantBillBackPercent: 50, tenantCost: 60,
      afterPhotoUrls: [AFTER],
    }],
  };
}

const ctx = (galleryBase?: string): PdfBuildContext => ({
  inspectionRecordId: '12345',
  templateLabel: 'Scope Rate Card',
  propertyName: '123 Test St',
  inspectorName: 'Tester',
  bedrooms: 3, bathrooms: 2, squareFootage: 1500,
  region: 'GA: Atlanta', generatedAtIso: new Date().toISOString(),
  sections: [section()],
  grandTotals: { vendor: 100, client: 120, tenant: 60, lineCount: 1 },
  photoGalleryBase: galleryBase,
});

// PDF link annotations store the URI uncompressed in the file, so we can scan
// the bytes for the gallery URL. Decode latin1 to keep raw bytes intact.
const asText = (b: Buffer) => b.toString('latin1');
const isPdf = (b: Buffer) => b.length > 1000 && b.slice(0, 5).toString() === '%PDF-';

describe('PDF gallery base under concurrent rendering', () => {
  // Warm @react-pdf's yoga-layout WASM with ONE sequential render before any
  // concurrency — exactly what finalize does (render Master first, alone). The
  // engine has a one-time cold-init race; warming it makes concurrent renders
  // reliable. This mirrors production, so the test exercises the real flow.
  beforeAll(async () => { await renderMasterPdf(ctx('https://resiwalk.com/d/0/photos/warm')); }, 30000);

  it('renders Master + Vendor PDFs concurrently without throwing, producing valid PDFs', async () => {
    const base = 'https://resiwalk.com/d/12345/photos/sig';
    const [master, vendors] = await Promise.all([
      renderMasterPdf(ctx(base)),
      renderVendorPdfs(ctx(base)),
    ]);
    expect(isPdf(master)).toBe(true);
    const ppw = vendors.get('PPW');
    expect(ppw && isPdf(ppw)).toBe(true);
  });

  it('keeps each PDF scoped to its OWN gallery base when rendered in parallel', async () => {
    const base = 'https://resiwalk.com/d/12345/photos/sig';
    // Kick off both renders together; the vendor render uses a vendor-scoped
    // base (?k=vendor&v=ppw), the master uses the bare base. A shared global
    // would let one overwrite the other mid-render.
    const [master, vendors] = await Promise.all([
      renderMasterPdf(ctx(base)),
      renderVendorPdfs(ctx(base)),
    ]);
    const masterTxt = asText(master);
    const ppwTxt = asText(vendors.get('PPW')!);

    // Master photo links to the bare (un-scoped) gallery base.
    expect(masterTxt).toContain('photos/sig');
    expect(masterTxt).not.toContain('k=vendor'); // must NOT have leaked the vendor scope

    // Vendor PDF links are scoped to this vendor.
    expect(ppwTxt).toContain('k=vendor');
    expect(ppwTxt).toContain('v=ppw');
  });

  it('falls back to raw file links when no gallery base is set', async () => {
    const master = await renderMasterPdf(ctx(undefined));
    const txt = asText(master);
    expect(txt).not.toContain('/photos/');
    expect(txt).toContain('photo-MASTERROOM'); // raw file URL used instead
  });
});
