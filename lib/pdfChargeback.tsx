// Tenant Chargeback PDF — only contains line items where tenant_bill_back_percent > 0.
// Sent to the tenant explaining what charges will be billed back to them.

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

// Chargeback table is more focused than Master — no Vendor or Vendor $ columns.
// Cat 12 | Sub 12 | Description 35 | Qty 6 | Unit 6 | Cli$ 10 | Ten% 7 | Ten$ 12
const COL = {
  category: '12%',
  subcategory: '12%',
  description: '35%',
  qty: '6%',
  unit: '6%',
  clientCost: '10%',
  tenantPct: '7%',
  tenantCost: '12%',
};

function ChargebackDoc(props: { ctx: PdfBuildContext }) {
  ensureFontRegistered();
  const { ctx } = props;
  const generatedAtLabel = isoToHumanDate(ctx.generatedAtIso);

  // Filter sections + lines for tenant_bill_back > 0
  const filteredSections: PdfSectionGroup[] = ctx.sections
    .map((s) => {
      const lines = s.lines.filter((l) => l.tenantBillBackPercent > 0 && l.tenantCost > 0);
      // Recompute totals on the filtered set
      const tenantTotal = lines.reduce((sum, l) => sum + l.tenantCost, 0);
      const clientTotal = lines.reduce((sum, l) => sum + l.clientCost, 0);
      const vendorTotal = lines.reduce((sum, l) => sum + l.vendorCost, 0);
      return { ...s, lines, tenantTotal, clientTotal, vendorTotal };
    })
    .filter((s) => s.lines.length > 0);

  const grandTenantTotal = filteredSections.reduce((sum, s) => sum + s.tenantTotal, 0);
  const grandLineCount = filteredSections.reduce((sum, s) => sum + s.lines.length, 0);

  return (
    <Document
      title={`Tenant Chargeback — ${ctx.propertyName}`}
      author="ResiHome"
      subject="Tenant Chargeback"
    >
      {/* Cover */}
      <Page size="LETTER" style={pdfStyles.page}>
        <PdfCover
          docTitle="Tenant Chargeback"
          docSubtitle="Items billed back to the tenant"
          propertyName={ctx.propertyName}
          inspectorName={ctx.inspectorName}
          region={ctx.region}
          squareFootage={ctx.squareFootage}
          bedrooms={ctx.bedrooms}
          bathrooms={ctx.bathrooms}
          generatedAtLabel={generatedAtLabel}
          summary={
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={pdfStyles.coverFooterLabel}>Total to Tenant</Text>
              <Text style={pdfStyles.coverTenantTotal}>${formatMoneyPdf(grandTenantTotal)}</Text>
              <Text style={[pdfStyles.coverFooterLabel, { marginTop: 6 }]}>
                {grandLineCount} {grandLineCount === 1 ? 'line item' : 'line items'}
              </Text>
            </View>
          }
        />
      </Page>

      {/* Line items */}
      <Page size="LETTER" style={pdfStyles.page}>
        <View style={pdfStyles.pageHeader} fixed>
          <Text style={pdfStyles.pageHeaderTitle}>Tenant Chargeback — Line Items</Text>
          <Text style={pdfStyles.pageHeaderRight}>{ctx.propertyName}</Text>
        </View>

        {/* Tenant Total strip — single value, prominent */}
        <View style={pdfStyles.grandTotalsStrip}>
          <View>
            <Text style={pdfStyles.grandTotalsLabel}>Items</Text>
            <Text style={pdfStyles.grandTotalsValue}>{grandLineCount}</Text>
          </View>
          <View>
            <Text style={pdfStyles.grandTotalsLabel}>Tenant Total</Text>
            <Text style={pdfStyles.grandTotalsValueLarge}>${formatMoneyPdf(grandTenantTotal)}</Text>
          </View>
        </View>

        {filteredSections.map((section) => (
          <ChargebackSectionTable key={section.label} section={section} />
        ))}

        <PdfFooter docName="Tenant Chargeback" propertyName={ctx.propertyName} />
      </Page>
    </Document>
  );
}

function ChargebackSectionTable(props: { section: PdfSectionGroup }) {
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
        <Text style={[pdfStyles.tableHeaderCell, { width: COL.clientCost, textAlign: 'right' }]}>Cli $</Text>
        <Text style={[pdfStyles.tableHeaderCell, { width: COL.tenantPct, textAlign: 'right' }]}>Ten %</Text>
        <Text style={[pdfStyles.tableHeaderCell, { width: COL.tenantCost, textAlign: 'right' }]}>Ten $</Text>
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
          <Text style={[pdfStyles.tableCellNumeric, { width: COL.clientCost }]}>${formatMoneyPdf(line.clientCost)}</Text>
          <Text style={[pdfStyles.tableCellNumeric, { width: COL.tenantPct }]}>{Math.round(line.tenantBillBackPercent)}%</Text>
          <Text style={[pdfStyles.tableCellTenant, { width: COL.tenantCost }]}>${formatMoneyPdf(line.tenantCost)}</Text>
        </View>
      ))}

      {s.lines.length > 1 && (
        <View style={pdfStyles.sectionSubtotalRow} wrap={false}>
          <Text style={[pdfStyles.sectionSubtotalCell, { width: '71%', textAlign: 'right' }]}>Section Subtotal</Text>
          <Text style={[pdfStyles.sectionSubtotalCell, { width: COL.clientCost }]}>${formatMoneyPdf(s.clientTotal)}</Text>
          <Text style={[pdfStyles.sectionSubtotalCell, { width: COL.tenantPct }]}> </Text>
          <Text style={[pdfStyles.sectionSubtotalCellPrimary, { width: COL.tenantCost }]}>${formatMoneyPdf(s.tenantTotal)}</Text>
        </View>
      )}
    </View>
  );
}

/**
 * Render the Chargeback PDF. Returns null when there are no chargeback lines
 * (skip the PDF in that case rather than producing an empty document).
 */
export async function renderChargebackPdf(ctx: PdfBuildContext): Promise<Buffer | null> {
  const hasChargebackLines = ctx.sections.some(
    (s) => s.lines.some((l) => l.tenantBillBackPercent > 0 && l.tenantCost > 0)
  );
  if (!hasChargebackLines) return null;
  return renderToBuffer(<ChargebackDoc ctx={ctx} />);
}
