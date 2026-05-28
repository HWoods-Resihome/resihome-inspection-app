// Master Rate Card report — the most comprehensive PDF.
// Contains every line item grouped by section + a photo appendix at the end.

import React from 'react';
import { Document, Page, Text, View, Image, renderToBuffer } from '@react-pdf/renderer';
import {
  pdfStyles,
  PDF_COLORS,
  ensureFontRegistered,
  PdfCover,
  PdfFooter,
  formatMoneyPdf,
  formatQtyPdf,
  isoToHumanDate,
  type PdfBuildContext,
  type PdfSectionGroup,
} from './pdfShared';

// Column layout for the Master line-item table (must sum to 100%):
// Cat 11 | Sub 11 | Description 28 | Qty 5 | Unit 5 | Vendor 11 | Ven$ 7 | Cli$ 7 | Ten% 5 | Ten$ 10
const COL = {
  category: '11%',
  subcategory: '11%',
  description: '28%',
  qty: '5%',
  unit: '5%',
  vendor: '11%',
  vendorCost: '7%',
  clientCost: '7%',
  tenantPct: '5%',
  tenantCost: '10%',
};

function MasterDoc(props: { ctx: PdfBuildContext }) {
  ensureFontRegistered();
  const { ctx } = props;
  const generatedAtLabel = isoToHumanDate(ctx.generatedAtIso);

  // Only sections that have lines OR have photos are worth showing
  const populatedSections = ctx.sections.filter(
    (s) => s.lines.length > 0 || s.photoUrls.length > 0
  );
  const sectionsWithLines = populatedSections.filter((s) => s.lines.length > 0);
  const sectionsWithPhotos = populatedSections.filter((s) => s.photoUrls.length > 0);

  return (
    <Document
      title={`ResiHome Inspection — ${ctx.propertyName}`}
      author="ResiHome"
      subject="Rate Card Inspection Report"
    >
      {/* Cover */}
      <Page size="LETTER" style={pdfStyles.page}>
        <PdfCover
          docTitle="Inspection Report"
          docSubtitle="Master Report — All Line Items"
          propertyName={ctx.propertyName}
          inspectorName={ctx.inspectorName}
          region={ctx.region}
          squareFootage={ctx.squareFootage}
          bedrooms={ctx.bedrooms}
          bathrooms={ctx.bathrooms}
          generatedAtLabel={generatedAtLabel}
          summary={
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={pdfStyles.coverFooterLabel}>Tenant Total</Text>
              <Text style={pdfStyles.coverTenantTotal}>${formatMoneyPdf(ctx.grandTotals.tenant)}</Text>
              <Text style={[pdfStyles.coverFooterLabel, { marginTop: 6 }]}>
                {ctx.grandTotals.lineCount} {ctx.grandTotals.lineCount === 1 ? 'line item' : 'line items'}
              </Text>
            </View>
          }
        />
      </Page>

      {/* Line items */}
      {sectionsWithLines.length > 0 && (
        <Page size="LETTER" style={pdfStyles.page}>
          <View style={pdfStyles.pageHeader} fixed>
            <Text style={pdfStyles.pageHeaderTitle}>Master Report — Line Items</Text>
            <Text style={pdfStyles.pageHeaderRight}>{ctx.propertyName}</Text>
          </View>

          {/* Grand totals strip */}
          <View style={pdfStyles.grandTotalsStrip}>
            <View>
              <Text style={pdfStyles.grandTotalsLabel}>Vendor Total</Text>
              <Text style={pdfStyles.grandTotalsValue}>${formatMoneyPdf(ctx.grandTotals.vendor)}</Text>
            </View>
            <View>
              <Text style={pdfStyles.grandTotalsLabel}>Client Total</Text>
              <Text style={pdfStyles.grandTotalsValue}>${formatMoneyPdf(ctx.grandTotals.client)}</Text>
            </View>
            <View>
              <Text style={pdfStyles.grandTotalsLabel}>Tenant Total</Text>
              <Text style={pdfStyles.grandTotalsValueLarge}>${formatMoneyPdf(ctx.grandTotals.tenant)}</Text>
            </View>
          </View>

          {sectionsWithLines.map((section) => (
            <SectionTable key={section.label} section={section} />
          ))}

          <PdfFooter docName="Master Report" propertyName={ctx.propertyName} />
        </Page>
      )}

      {/* Photo appendix */}
      {sectionsWithPhotos.length > 0 && (
        <Page size="LETTER" style={pdfStyles.page} wrap>
          <View style={pdfStyles.pageHeader} fixed>
            <Text style={pdfStyles.pageHeaderTitle}>Photo Appendix</Text>
            <Text style={pdfStyles.pageHeaderRight}>{ctx.propertyName}</Text>
          </View>

          <Text style={pdfStyles.appendixTitle}>Section Photos</Text>

          {sectionsWithPhotos.map((section) => (
            <PhotoAppendixSection key={section.label} section={section} />
          ))}

          <PdfFooter docName="Master Report" propertyName={ctx.propertyName} />
        </Page>
      )}
    </Document>
  );
}

function SectionTable(props: { section: PdfSectionGroup }) {
  const s = props.section;
  return (
    <View wrap={false} style={{ marginTop: 12 }}>
      <Text style={pdfStyles.sectionTitle}>{s.displayName}</Text>

      {/* Header row */}
      <View style={pdfStyles.tableHeaderRow}>
        <Text style={[pdfStyles.tableHeaderCell, { width: COL.category }]}>Category</Text>
        <Text style={[pdfStyles.tableHeaderCell, { width: COL.subcategory }]}>Sub</Text>
        <Text style={[pdfStyles.tableHeaderCell, { width: COL.description }]}>Description</Text>
        <Text style={[pdfStyles.tableHeaderCell, { width: COL.qty, textAlign: 'right' }]}>Qty</Text>
        <Text style={[pdfStyles.tableHeaderCell, { width: COL.unit }]}>Unit</Text>
        <Text style={[pdfStyles.tableHeaderCell, { width: COL.vendor }]}>Vendor</Text>
        <Text style={[pdfStyles.tableHeaderCell, { width: COL.vendorCost, textAlign: 'right' }]}>Ven $</Text>
        <Text style={[pdfStyles.tableHeaderCell, { width: COL.clientCost, textAlign: 'right' }]}>Cli $</Text>
        <Text style={[pdfStyles.tableHeaderCell, { width: COL.tenantPct, textAlign: 'right' }]}>Ten %</Text>
        <Text style={[pdfStyles.tableHeaderCell, { width: COL.tenantCost, textAlign: 'right' }]}>Ten $</Text>
      </View>

      {/* Data rows */}
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
          <Text style={[pdfStyles.tableCell, { width: COL.vendor }]}>{line.vendor}</Text>
          <Text style={[pdfStyles.tableCellNumeric, { width: COL.vendorCost }]}>${formatMoneyPdf(line.vendorCost)}</Text>
          <Text style={[pdfStyles.tableCellNumeric, { width: COL.clientCost }]}>${formatMoneyPdf(line.clientCost)}</Text>
          <Text style={[pdfStyles.tableCellNumeric, { width: COL.tenantPct }]}>{Math.round(line.tenantBillBackPercent)}%</Text>
          <Text style={[pdfStyles.tableCellTenant, { width: COL.tenantCost }]}>${formatMoneyPdf(line.tenantCost)}</Text>
        </View>
      ))}

      {/* Subtotal row — only show if multiple lines */}
      {s.lines.length > 1 && (
        <View style={pdfStyles.sectionSubtotalRow} wrap={false}>
          <Text style={[pdfStyles.sectionSubtotalCell, { width: '60%', textAlign: 'right' }]}>Section Subtotal</Text>
          <Text style={[pdfStyles.sectionSubtotalCell, { width: COL.vendorCost }]}>${formatMoneyPdf(s.vendorTotal)}</Text>
          <Text style={[pdfStyles.sectionSubtotalCell, { width: COL.clientCost }]}>${formatMoneyPdf(s.clientTotal)}</Text>
          <Text style={[pdfStyles.sectionSubtotalCell, { width: COL.tenantPct }]}> </Text>
          <Text style={[pdfStyles.sectionSubtotalCellPrimary, { width: COL.tenantCost }]}>${formatMoneyPdf(s.tenantTotal)}</Text>
        </View>
      )}
    </View>
  );
}

function PhotoAppendixSection(props: { section: PdfSectionGroup }) {
  const s = props.section;
  if (s.photoUrls.length === 0) return null;
  return (
    <View wrap={false} style={{ marginBottom: 14 }}>
      <Text style={pdfStyles.appendixSectionTitle}>{s.displayName}</Text>
      <View style={pdfStyles.photoGrid}>
        {s.photoUrls.map((url, i) => (
          <View key={`${url}-${i}`} style={pdfStyles.photoCell}>
            {/* eslint-disable-next-line jsx-a11y/alt-text */}
            <Image src={url} style={pdfStyles.photoCellImage} />
          </View>
        ))}
      </View>
    </View>
  );
}

/**
 * Render the Master PDF to a Buffer. Server-side only.
 */
export async function renderMasterPdf(ctx: PdfBuildContext): Promise<Buffer> {
  return renderToBuffer(<MasterDoc ctx={ctx} />);
}
