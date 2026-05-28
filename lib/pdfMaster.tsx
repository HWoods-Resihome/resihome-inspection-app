// Master Rate Card report — every line item grouped by section, with section
// photos inline. Single document with the compact header strip on page 1.

import React from 'react';
import { Document, Page, Text, View, renderToBuffer } from '@react-pdf/renderer';
import {
  pdfStyles,
  ensureFontRegistered,
  PdfHeaderStrip,
  PdfFooter,
  PdfSectionPhotos,
  formatMoneyPdf,
  formatQtyPdf,
  isoToHumanDate,
  type PdfBuildContext,
  type PdfSectionGroup,
} from './pdfShared';

// Master column layout (sums to 100%):
//   Category 9 | Sub 9 | Description 28 | Qty 6 | Unit 5 | Vendor 12 | Ven$ 8 | Cli$ 8 | Ten% 6 | Ten$ 9
const COL = {
  category: '9%',
  subcategory: '9%',
  description: '28%',
  qty: '6%',
  unit: '5%',
  vendor: '12%',
  vendorCost: '8%',
  clientCost: '8%',
  tenantPct: '6%',
  tenantCost: '9%',
};

function MasterDoc(props: { ctx: PdfBuildContext }) {
  ensureFontRegistered();
  const { ctx } = props;
  const generatedAtLabel = isoToHumanDate(ctx.generatedAtIso);
  const populatedSections = ctx.sections.filter(
    (s) => s.lines.length > 0 || s.photoUrls.length > 0
  );

  return (
    <Document
      title={`${ctx.templateLabel} — ${ctx.propertyName}`}
      author="ResiHome"
      subject="Rate Card Inspection Report"
    >
      <Page size="LETTER" style={pdfStyles.page} wrap>
        <PdfHeaderStrip
          docTitle={ctx.templateLabel}
          propertyName={ctx.propertyName}
          inspectorName={ctx.inspectorName}
          region={ctx.region}
          squareFootage={ctx.squareFootage}
          bedrooms={ctx.bedrooms}
          bathrooms={ctx.bathrooms}
          generatedAtLabel={generatedAtLabel}
          summary={
            <>
              <Text style={pdfStyles.headerRightLabel}>Tenant Total</Text>
              <Text style={pdfStyles.headerRightValue}>${formatMoneyPdf(ctx.grandTotals.tenant)}</Text>
            </>
          }
        />

        {/* Grand totals strip — three figures side by side */}
        <View style={pdfStyles.grandTotalsStrip}>
          <View style={pdfStyles.grandTotalsItem}>
            <Text style={pdfStyles.grandTotalsLabel}>Lines</Text>
            <Text style={pdfStyles.grandTotalsValue}>{ctx.grandTotals.lineCount}</Text>
          </View>
          <View style={pdfStyles.grandTotalsItem}>
            <Text style={pdfStyles.grandTotalsLabel}>Vendor Total</Text>
            <Text style={pdfStyles.grandTotalsValue}>${formatMoneyPdf(ctx.grandTotals.vendor)}</Text>
          </View>
          <View style={pdfStyles.grandTotalsItem}>
            <Text style={pdfStyles.grandTotalsLabel}>Client Total</Text>
            <Text style={pdfStyles.grandTotalsValue}>${formatMoneyPdf(ctx.grandTotals.client)}</Text>
          </View>
          <View style={pdfStyles.grandTotalsItem}>
            <Text style={pdfStyles.grandTotalsLabel}>Tenant Total</Text>
            <Text style={pdfStyles.grandTotalsValueBrand}>${formatMoneyPdf(ctx.grandTotals.tenant)}</Text>
          </View>
        </View>

        {populatedSections.map((section) => (
          <MasterSection key={section.label} section={section} />
        ))}

        <PdfFooter docName="Master Report" propertyName={ctx.propertyName} />
      </Page>
    </Document>
  );
}

function MasterSection(props: { section: PdfSectionGroup }) {
  const s = props.section;
  return (
    <View style={{ marginTop: 8 }}>
      <Text style={pdfStyles.sectionTitle}>{s.displayName}</Text>

      {/* Inline section photos (no appendix) */}
      <PdfSectionPhotos photoUrls={s.photoUrls} />

      {s.lines.length > 0 && (
        <>
          {/* Header row */}
          <View style={pdfStyles.tableHeaderRow}>
            <Text style={[pdfStyles.tableHeaderCell, { width: COL.category, textAlign: 'center' }]}>Category</Text>
            <Text style={[pdfStyles.tableHeaderCell, { width: COL.subcategory, textAlign: 'center' }]}>Subcategory</Text>
            <Text style={[pdfStyles.tableHeaderCell, { width: COL.description }]}>Description</Text>
            <Text style={[pdfStyles.tableHeaderCell, { width: COL.qty, textAlign: 'center' }]}>Qty</Text>
            <Text style={[pdfStyles.tableHeaderCell, { width: COL.unit, textAlign: 'center' }]}>Unit</Text>
            <Text style={[pdfStyles.tableHeaderCell, { width: COL.vendor, textAlign: 'center' }]}>Vendor</Text>
            <Text style={[pdfStyles.tableHeaderCell, { width: COL.vendorCost, textAlign: 'right' }]}>Vendor $</Text>
            <Text style={[pdfStyles.tableHeaderCell, { width: COL.clientCost, textAlign: 'right' }]}>Client $</Text>
            <Text style={[pdfStyles.tableHeaderCell, { width: COL.tenantPct, textAlign: 'right' }]}>Tenant %</Text>
            <Text style={[pdfStyles.tableHeaderCell, { width: COL.tenantCost, textAlign: 'right' }]}>Tenant $</Text>
          </View>

          {/* Data rows */}
          {s.lines.map((line) => (
            <View key={line.externalId} style={pdfStyles.tableRow} wrap={false}>
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
              <Text style={[pdfStyles.tableCellCentered, { width: COL.vendor }]}>{line.vendor}</Text>
              <Text style={[pdfStyles.tableCellNumeric, { width: COL.vendorCost }]}>${formatMoneyPdf(line.vendorCost)}</Text>
              <Text style={[pdfStyles.tableCellNumeric, { width: COL.clientCost }]}>${formatMoneyPdf(line.clientCost)}</Text>
              <Text style={[pdfStyles.tableCellNumeric, { width: COL.tenantPct }]}>{Math.round(line.tenantBillBackPercent)}%</Text>
              <Text style={[pdfStyles.tableCellTenant, { width: COL.tenantCost }]}>${formatMoneyPdf(line.tenantCost)}</Text>
            </View>
          ))}

          {/* Subtotal row (always shown, even for 1 line — keeps visual rhythm) */}
          {s.lines.length >= 1 && (
            <View style={pdfStyles.subtotalRow} wrap={false}>
              <Text style={[pdfStyles.subtotalCell, { width: '60%' }]}>Section Subtotal</Text>
              <Text style={[pdfStyles.subtotalCell, { width: COL.vendorCost }]}>${formatMoneyPdf(s.vendorTotal)}</Text>
              <Text style={[pdfStyles.subtotalCell, { width: COL.clientCost }]}>${formatMoneyPdf(s.clientTotal)}</Text>
              <Text style={[pdfStyles.subtotalCell, { width: COL.tenantPct }]}> </Text>
              <Text style={[pdfStyles.subtotalCellTenant, { width: COL.tenantCost }]}>${formatMoneyPdf(s.tenantTotal)}</Text>
            </View>
          )}
        </>
      )}
    </View>
  );
}

export async function renderMasterPdf(ctx: PdfBuildContext): Promise<Buffer> {
  return renderToBuffer(<MasterDoc ctx={ctx} />);
}
