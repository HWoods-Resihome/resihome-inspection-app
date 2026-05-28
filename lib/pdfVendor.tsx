// Per-Vendor PDFs — one PDF per vendor that has assigned line items.
// Vendor-focused columns: Cat | Sub | Description | Qty | Unit | Vendor $
// Plus a section subtotal of Vendor $ only.

import React from 'react';
import { Document, Page, Text, View, renderToBuffer } from '@react-pdf/renderer';
import {
  pdfStyles,
  ensureFontRegistered,
  PdfCover,
  PdfFooter,
  formatMoneyPdf,
  formatQtyPdf,
  isoToHumanDate,
  type PdfBuildContext,
  type PdfSectionGroup,
} from './pdfShared';

// Vendor table: Cat 13 | Sub 13 | Description 49 | Qty 6 | Unit 6 | Ven$ 13
const COL = {
  category: '13%',
  subcategory: '13%',
  description: '49%',
  qty: '6%',
  unit: '6%',
  vendorCost: '13%',
};

function VendorDoc(props: { ctx: PdfBuildContext; vendor: string; vendorSections: PdfSectionGroup[]; vendorTotal: number; lineCount: number }) {
  ensureFontRegistered();
  const { ctx, vendor, vendorSections, vendorTotal, lineCount } = props;
  const generatedAtLabel = isoToHumanDate(ctx.generatedAtIso);

  return (
    <Document
      title={`Vendor Work Order — ${vendor} — ${ctx.propertyName}`}
      author="ResiHome"
      subject={`Work Order for ${vendor}`}
    >
      <Page size="LETTER" style={pdfStyles.page}>
        <PdfCover
          docTitle="Vendor Work Order"
          docSubtitle={`For ${vendor}`}
          propertyName={ctx.propertyName}
          inspectorName={ctx.inspectorName}
          region={ctx.region}
          squareFootage={ctx.squareFootage}
          bedrooms={ctx.bedrooms}
          bathrooms={ctx.bathrooms}
          generatedAtLabel={generatedAtLabel}
          summary={
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={pdfStyles.coverFooterLabel}>Vendor Total</Text>
              <Text style={pdfStyles.coverTenantTotal}>${formatMoneyPdf(vendorTotal)}</Text>
              <Text style={[pdfStyles.coverFooterLabel, { marginTop: 6 }]}>
                {lineCount} {lineCount === 1 ? 'line item' : 'line items'}
              </Text>
            </View>
          }
        />
      </Page>

      <Page size="LETTER" style={pdfStyles.page}>
        <View style={pdfStyles.pageHeader} fixed>
          <Text style={pdfStyles.pageHeaderTitle}>{vendor} — Work Order</Text>
          <Text style={pdfStyles.pageHeaderRight}>{ctx.propertyName}</Text>
        </View>

        {/* Vendor total strip */}
        <View style={pdfStyles.grandTotalsStrip}>
          <View>
            <Text style={pdfStyles.grandTotalsLabel}>Items</Text>
            <Text style={pdfStyles.grandTotalsValue}>{lineCount}</Text>
          </View>
          <View>
            <Text style={pdfStyles.grandTotalsLabel}>Vendor Total</Text>
            <Text style={pdfStyles.grandTotalsValueLarge}>${formatMoneyPdf(vendorTotal)}</Text>
          </View>
        </View>

        {vendorSections.map((section) => (
          <VendorSectionTable key={section.label} section={section} />
        ))}

        <PdfFooter docName={`Work Order — ${vendor}`} propertyName={ctx.propertyName} />
      </Page>
    </Document>
  );
}

function VendorSectionTable(props: { section: PdfSectionGroup }) {
  const s = props.section;
  return (
    <View wrap={false} style={{ marginTop: 12 }}>
      <Text style={pdfStyles.sectionTitle}>{s.displayName}</Text>

      <View style={pdfStyles.tableHeaderRow}>
        <Text style={[pdfStyles.tableHeaderCell, { width: COL.category }]}>Category</Text>
        <Text style={[pdfStyles.tableHeaderCell, { width: COL.subcategory }]}>Sub</Text>
        <Text style={[pdfStyles.tableHeaderCell, { width: COL.description }]}>Description</Text>
        <Text style={[pdfStyles.tableHeaderCell, { width: COL.qty, textAlign: 'right' }]}>Qty</Text>
        <Text style={[pdfStyles.tableHeaderCell, { width: COL.unit }]}>Unit</Text>
        <Text style={[pdfStyles.tableHeaderCell, { width: COL.vendorCost, textAlign: 'right' }]}>Ven $</Text>
      </View>

      {s.lines.map((line) => (
        <View key={line.externalId} style={pdfStyles.tableRow} wrap={false}>
          <Text style={[pdfStyles.tableCell, { width: COL.category }]}>{line.category}</Text>
          <Text style={[pdfStyles.tableCell, { width: COL.subcategory }]}>{line.subcategory}</Text>
          <View style={{ width: COL.description }}>
            <Text style={pdfStyles.tableCell}>{line.laborShortDescription}</Text>
            {line.laborFullDescription && line.laborFullDescription !== line.laborShortDescription && (
              <Text style={pdfStyles.tableCellDescription}>{line.laborFullDescription}</Text>
            )}
          </View>
          <Text style={[pdfStyles.tableCellNumeric, { width: COL.qty }]}>{formatQtyPdf(line.quantity)}</Text>
          <Text style={[pdfStyles.tableCell, { width: COL.unit }]}>{line.laborMeas}</Text>
          <Text style={[pdfStyles.tableCellNumeric, { width: COL.vendorCost }]}>${formatMoneyPdf(line.vendorCost)}</Text>
        </View>
      ))}

      {s.lines.length > 1 && (
        <View style={pdfStyles.sectionSubtotalRow} wrap={false}>
          <Text style={[pdfStyles.sectionSubtotalCell, { width: '87%', textAlign: 'right' }]}>Section Subtotal</Text>
          <Text style={[pdfStyles.sectionSubtotalCellPrimary, { width: COL.vendorCost }]}>${formatMoneyPdf(s.vendorTotal)}</Text>
        </View>
      )}
    </View>
  );
}

/**
 * Render one PDF per vendor that has assigned line items. Returns a map of
 * vendor name -> rendered Buffer.
 */
export async function renderVendorPdfs(ctx: PdfBuildContext): Promise<Map<string, Buffer>> {
  // Group lines by vendor
  const byVendor = new Map<string, PdfSectionGroup[]>();
  const lineCountByVendor = new Map<string, number>();
  const vendorTotals = new Map<string, number>();

  for (const section of ctx.sections) {
    // Group THIS section's lines by vendor
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
        photoUrls: [],          // not included in vendor PDFs
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

  // Render one PDF per vendor
  const result = new Map<string, Buffer>();
  for (const [vendor, sections] of byVendor.entries()) {
    if (sections.length === 0) continue;
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

  return result;
}
