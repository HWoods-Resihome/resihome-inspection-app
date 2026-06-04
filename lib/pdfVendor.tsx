// Per-Vendor PDFs — one document per vendor with assigned line items.
// Cover header reads "{Vendor} {Template Label}" (e.g. "Internal Resolution
// Scope Rate Card"). Filename mirrors that, set by the finalize endpoint.

import React from 'react';
import { Document, Page, Text, View, renderToBuffer } from '@react-pdf/renderer';
import {
  pdfStyles,
  ensureFontRegistered,
  PdfHeaderStrip,
  PdfFooter,
  PdfSectionHeader,
  PdfGalleryBaseProvider,
  PdfSectionPhotos,
  formatMoneyPdf,
  formatQtyPdf,
  isoToHumanDate,
  type PdfBuildContext,
  type PdfSectionGroup,
} from './pdfShared';
import { vendorGetsOwnPdf } from './vendors';
import { slugifyVendor } from '@/lib/shortLinks';

// Max @react-pdf renders running at once. Each transiently allocates 100+ MB,
// so this caps peak memory on the lambda while still overlapping work.
const VENDOR_RENDER_CONCURRENCY = 2;

// Vendor column layout (Vendor-focused, no Client/Tenant):
//   Cat 12 | Sub 12 | Description 55 | Qty 6 | Unit 5 | Ven$ 10
const COL = {
  category: '12%',
  subcategory: '12%',
  description: '55%',
  qty: '6%',
  unit: '5%',
  vendorCost: '10%',
};

function VendorDoc(props: {
  ctx: PdfBuildContext;
  vendor: string;
  vendorSections: PdfSectionGroup[];
  vendorTotal: number;
  lineCount: number;
}) {
  ensureFontRegistered();
  const { ctx, vendor, vendorSections, vendorTotal, lineCount } = props;
  const generatedAtLabel = isoToHumanDate(ctx.generatedAtIso);
  const docTitle = `${vendor} ${ctx.templateLabel}`;
  // Scope this vendor's gallery to its own photos (section photos + this
  // vendor's line after-photos). Supplied via context so the render is
  // self-contained and parallel-safe.
  const galleryBase = ctx.photoGalleryBase ? `${ctx.photoGalleryBase}?k=vendor&v=${slugifyVendor(vendor)}` : undefined;

  return (
    <Document
      title={`${docTitle} — ${ctx.propertyName}`}
      author="ResiHome"
      subject={docTitle}
    >
      <PdfGalleryBaseProvider base={galleryBase}>
      <Page size="LETTER" style={pdfStyles.page} wrap>
        <PdfHeaderStrip
          docTitle={docTitle}
          propertyName={ctx.propertyName}
          inspectorName={ctx.inspectorName}
          region={ctx.region}
          squareFootage={ctx.squareFootage}
          bedrooms={ctx.bedrooms}
          bathrooms={ctx.bathrooms}
          generatedAtLabel={generatedAtLabel}
          summary={
            <>
              <Text style={pdfStyles.headerRightLabel}>Vendor Total</Text>
              <Text style={pdfStyles.headerRightValue}>${formatMoneyPdf(vendorTotal)}</Text>
            </>
          }
        />

        <View style={pdfStyles.grandTotalsStrip}>
          <View style={pdfStyles.grandTotalsItem}>
            <Text style={pdfStyles.grandTotalsLabel}>Scope Items</Text>
            <Text style={pdfStyles.grandTotalsValue}>{lineCount}</Text>
          </View>
          <View style={pdfStyles.grandTotalsItem}>
            <Text style={pdfStyles.grandTotalsLabel}>Vendor Total</Text>
            <Text style={pdfStyles.grandTotalsValueBrand}>${formatMoneyPdf(vendorTotal)}</Text>
          </View>
        </View>

        {vendorSections.map((section) => (
          <VendorSection key={section.label} section={section} />
        ))}

        <PdfFooter docName={vendor} propertyName={ctx.propertyName} />
      </Page>
      </PdfGalleryBaseProvider>
    </Document>
  );
}

function VendorSection(props: { section: PdfSectionGroup }) {
  const s = props.section;
  return (
    <View>
      <PdfSectionHeader title={s.displayName} photoUrls={s.photoUrls} />

      <View style={pdfStyles.tableHeaderRow}>
        <Text style={[pdfStyles.tableHeaderCell, { width: COL.category, textAlign: 'center' }]}>Category</Text>
        <Text style={[pdfStyles.tableHeaderCell, { width: COL.subcategory, textAlign: 'center' }]}>{'Sub-\ncategory'}</Text>
        <Text style={[pdfStyles.tableHeaderCell, { width: COL.description }]}>Description</Text>
        <Text style={[pdfStyles.tableHeaderCell, { width: COL.qty, textAlign: 'center' }]}>Qty</Text>
        <Text style={[pdfStyles.tableHeaderCell, { width: COL.unit, textAlign: 'center' }]}>Unit</Text>
        <Text style={[pdfStyles.tableHeaderCell, { width: COL.vendorCost, textAlign: 'right' }]}>Vendor $</Text>
      </View>

      {s.lines.map((line) => (
        <React.Fragment key={line.externalId}>
          <View style={pdfStyles.tableRow} wrap={false}>
            <Text style={[pdfStyles.tableCellCentered, { width: COL.category }]}>{line.category}</Text>
            <Text style={[pdfStyles.tableCellCentered, { width: COL.subcategory }]}>{line.subcategory}</Text>
            <View style={{ width: COL.description }}>
              <Text style={pdfStyles.tableCell}>{line.laborShortDescription}</Text>
              {line.laborFullDescription && line.laborFullDescription !== line.laborShortDescription && (
                <Text style={pdfStyles.tableCellDescription}>{line.laborFullDescription}</Text>
              )}
            </View>
            <Text style={[pdfStyles.tableCellCentered, { width: COL.qty }]}>{formatQtyPdf(line.quantity)}</Text>
            <Text style={[pdfStyles.tableCellCentered, { width: COL.unit }]}>{line.laborMeas}</Text>
            <Text style={[pdfStyles.tableCellNumeric, { width: COL.vendorCost }]}>${formatMoneyPdf(line.vendorCost)}</Text>
          </View>
          {(line.afterPhotoUrls?.length ?? 0) > 0 && (
            <View style={{ marginTop: 2, marginBottom: 5, paddingLeft: 8 }} wrap={false}>
              <Text style={{ fontSize: 8, color: '#6b7280', marginBottom: 2 }}>
                After Photos — {line.laborShortDescription}
              </Text>
              <PdfSectionPhotos photoUrls={line.afterPhotoUrls!} />
            </View>
          )}
        </React.Fragment>
      ))}

      <View style={pdfStyles.subtotalRow} wrap={false}>
        <Text style={[pdfStyles.subtotalCell, { width: '90%', textAlign: 'right' }]}>Section Subtotal</Text>
        <Text style={[pdfStyles.subtotalCellTenant, { width: COL.vendorCost }]}>${formatMoneyPdf(s.vendorTotal)}</Text>
      </View>
    </View>
  );
}

export async function renderVendorPdfs(ctx: PdfBuildContext): Promise<Map<string, Buffer>> {
  // Group lines by vendor across sections
  const byVendor = new Map<string, PdfSectionGroup[]>();
  const lineCountByVendor = new Map<string, number>();
  const vendorTotals = new Map<string, number>();

  for (const section of ctx.sections) {
    const sectionLinesByVendor = new Map<string, typeof section.lines>();
    for (const line of section.lines) {
      const v = line.vendor || 'Unassigned';
      const arr = sectionLinesByVendor.get(v) || [];
      arr.push(line);
      sectionLinesByVendor.set(v, arr);
    }

    for (const [vendor, lines] of sectionLinesByVendor.entries()) {
      const vendorTotal = lines.reduce((sum, l) => sum + l.vendorCost, 0);
      const clientTotal = lines.reduce((sum, l) => sum + l.clientCost, 0);
      const tenantTotal = lines.reduce((sum, l) => sum + l.tenantCost, 0);

      const sectionForVendor: PdfSectionGroup = {
        label: section.label,
        displayName: section.displayName,
        lines,
        // Vendor PDFs include section photos too (per latest feedback —
        // photos inline by section makes the report self-contained).
        photoUrls: section.photoUrls,
        vendorTotal,
        clientTotal,
        tenantTotal,
      };
      const existing = byVendor.get(vendor) || [];
      existing.push(sectionForVendor);
      byVendor.set(vendor, existing);
      lineCountByVendor.set(vendor, (lineCountByVendor.get(vendor) || 0) + lines.length);
      vendorTotals.set(vendor, (vendorTotals.get(vendor) || 0) + vendorTotal);
    }
  }

  // Vendors that actually get their own packet. (Some, e.g. Eviction Vendor
  // (Past), don't — their lines still ride the Master + Tenant Chargeback PDFs.)
  const vendors = [...byVendor.entries()].filter(([v, s]) => s.length > 0 && vendorGetsOwnPdf(v));

  // Render with BOUNDED concurrency. Each @react-pdf render transiently
  // allocates 100+ MB, so we never run more than VENDOR_RENDER_CONCURRENCY at
  // once — that caps peak memory (safe on the lambda) while still overlapping
  // renders for a real wall-clock win when there are several vendors. Each
  // render is self-contained (gallery base flows through context), so there's
  // no shared mutable state to race.
  const result = new Map<string, Buffer>();
  let cursor = 0;
  const worker = async () => {
    while (cursor < vendors.length) {
      const idx = cursor++;
      const [vendor, sections] = vendors[idx];
      const buf = await renderToBuffer(
        <VendorDoc
          ctx={ctx}
          vendor={vendor}
          vendorSections={sections}
          vendorTotal={vendorTotals.get(vendor) || 0}
          lineCount={lineCountByVendor.get(vendor) || 0}
        />
      );
      result.set(vendor, buf);
    }
  };
  await Promise.all(Array.from({ length: Math.min(VENDOR_RENDER_CONCURRENCY, vendors.length) }, worker));

  return result;
}
