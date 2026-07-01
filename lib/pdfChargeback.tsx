// Tenant Chargeback PDF — only contains line items where
// tenant_bill_back_percent > 0. Tenant-facing, so we omit Vendor / Client
// figures entirely; the only money columns are Tenant % and Tenant $.

import React from 'react';
import { Document, Page, Text, View, renderToBuffer } from '@react-pdf/renderer';
import {
  pdfStyles,
  ensureFontRegistered,
  PdfHeaderStrip,
  PdfFooter,
  PdfSectionHeader,
  PdfSummaryTable,
  PdfGalleryBaseProvider,
  formatMoneyPdf,
  formatQtyPdf,
  isoToHumanDate,
  type PdfBuildContext,
  type PdfSectionGroup,
  type PdfLineRow,
  type PdfSummaryColumn,
} from './pdfShared';
import { roundMoney } from '@/lib/rateCardMath';

// Chargeback column layout (Client column removed — Tenant Total is the
// only figure the tenant should see):
//   Cat 11 | Sub 11 | Description 48 | Qty 6 | Unit 6 | Ten% 6 | Ten$ 12
const COL = {
  category: '11%',
  subcategory: '11%',
  description: '48%',
  qty: '6%',
  unit: '6%',
  tenantPct: '6%',
  tenantCost: '12%',
};

function ChargebackDoc(props: { ctx: PdfBuildContext }) {
  ensureFontRegistered();
  const { ctx } = props;
  const generatedAtLabel = isoToHumanDate(ctx.generatedAtIso);

  // Filter to chargeback lines and recompute totals on the filtered set
  const filteredSections: PdfSectionGroup[] = ctx.sections
    .map((s) => {
      const lines = s.lines.filter((l) => l.tenantBillBackPercent > 0 && l.tenantCost > 0);
      // Round each line BEFORE summing so the section subtotal and grand total
      // equal the sum of the per-line amounts actually printed (each cell shows
      // roundMoney), AND match the XLSX importer (rounds per line) + the stored
      // total_tenant_cost. Summing full precision then rounding once drifts by
      // fractional cents, so the tenant-facing PDF total disagreed with the
      // amount actually billed.
      const tenantTotal = lines.reduce((sum, l) => sum + roundMoney(l.tenantCost), 0);
      // clientTotal / vendorTotal recomputed only for backward-compat with
      // the PdfSectionGroup type; not displayed anywhere on the chargeback.
      const clientTotal = lines.reduce((sum, l) => sum + roundMoney(l.clientCost), 0);
      const vendorTotal = lines.reduce((sum, l) => sum + roundMoney(l.vendorCost), 0);
      return { ...s, lines, tenantTotal, clientTotal, vendorTotal };
    })
    .filter((s) => s.lines.length > 0);

  const grandTenantTotal = filteredSections.reduce((sum, s) => sum + s.tenantTotal, 0);
  const grandLineCount = filteredSections.reduce((sum, s) => sum + s.lines.length, 0);

  // Page-1 condensed summary columns — Room is prepended by PdfSummaryTable;
  // these widths + roomWidth (13%) sum to 100%.
  const summaryColumns: PdfSummaryColumn<PdfLineRow>[] = [
    { key: 'category', header: 'Category', width: '10%', align: 'center', cell: (l) => l.category },
    { key: 'subcategory', header: 'Sub', width: '10%', align: 'center', cell: (l) => l.subcategory },
    { key: 'description', header: 'Description', width: '39%', cell: (l) => l.laborShortDescription },
    { key: 'qty', header: 'Qty', width: '6%', align: 'center', cell: (l) => formatQtyPdf(l.quantity) },
    { key: 'unit', header: 'Unit', width: '6%', align: 'center', cell: (l) => l.laborMeas },
    {
      key: 'tenantPct', header: 'Ten %', width: '6%', align: 'right', hasTotal: true,
      cell: (l) => `${Math.round(l.tenantBillBackPercent)}%`,
    },
    {
      key: 'tenantCost', header: 'Tenant $', width: '10%', align: 'right', brand: true,
      cell: (l) => `$${formatMoneyPdf(l.tenantCost)}`,
      grandTotal: `$${formatMoneyPdf(grandTenantTotal)}`,
    },
  ];

  return (
    <Document
      title={`Tenant Chargeback — ${ctx.propertyName}`}
      author="ResiHome"
      subject="Tenant Chargeback"
    >
      <PdfGalleryBaseProvider base={ctx.photoGalleryBase} embedded={ctx.embeddedPhotoByUrl}>
      <Page size="LETTER" style={pdfStyles.page} wrap>
        <PdfHeaderStrip
          docTitle={`Tenant Chargeback — ${ctx.templateLabel}`}
          propertyName={ctx.propertyName}
          inspectorName={ctx.inspectorName}
          region={ctx.region}
          squareFootage={ctx.squareFootage}
          bedrooms={ctx.bedrooms}
          bathrooms={ctx.bathrooms}
          generatedAtLabel={generatedAtLabel}
          summary={
            <>
              <Text style={pdfStyles.headerRightLabel}>Total to Tenant</Text>
              <Text style={pdfStyles.headerRightValue}>${formatMoneyPdf(grandTenantTotal)}</Text>
            </>
          }
        />

        <View style={pdfStyles.grandTotalsStrip}>
          <View style={pdfStyles.grandTotalsItem}>
            <Text style={pdfStyles.grandTotalsLabel}>Scope Items</Text>
            <Text style={pdfStyles.grandTotalsValue}>{grandLineCount}</Text>
          </View>
          <View style={pdfStyles.grandTotalsItem}>
            <Text style={pdfStyles.grandTotalsLabel}>Tenant Total</Text>
            <Text style={pdfStyles.grandTotalsValueBrand}>${formatMoneyPdf(grandTenantTotal)}</Text>
          </View>
        </View>

        {/* Page 1: condensed summary of every chargeback line, grouped by room. */}
        <PdfSummaryTable
          title="Chargeback Summary — All Line Items"
          groups={filteredSections}
          columns={summaryColumns}
          roomWidth="13%"
          grandTotalLabel="Grand Total"
        />

        {/* Detail pages: each room with photos + full line table. */}
        <View break>
          {filteredSections.map((section) => (
            <ChargebackSection key={section.label} section={section} />
          ))}
        </View>

        <PdfFooter docName="Tenant Chargeback" propertyName={ctx.propertyName} />
      </Page>
      </PdfGalleryBaseProvider>
    </Document>
  );
}

function ChargebackSection(props: { section: PdfSectionGroup }) {
  const s = props.section;
  return (
    <View>
      <PdfSectionHeader title={s.displayName} photoUrls={s.photoUrls} />

      <View style={pdfStyles.tableHeaderRow}>
        <Text style={[pdfStyles.tableHeaderCell, { width: COL.category, textAlign: 'center' }]}>Category</Text>
        <Text style={[pdfStyles.tableHeaderCell, { width: COL.subcategory, textAlign: 'center' }]}>Sub</Text>
        <Text style={[pdfStyles.tableHeaderCell, { width: COL.description }]}>Description</Text>
        <Text style={[pdfStyles.tableHeaderCell, { width: COL.qty, textAlign: 'center' }]}>Qty</Text>
        <Text style={[pdfStyles.tableHeaderCell, { width: COL.unit, textAlign: 'center' }]}>Unit</Text>
        <Text style={[pdfStyles.tableHeaderCell, { width: COL.tenantPct, textAlign: 'right' }]}>Ten %</Text>
        <Text style={[pdfStyles.tableHeaderCell, { width: COL.tenantCost, textAlign: 'right' }]}>Tenant $</Text>
      </View>

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
          <Text style={[pdfStyles.tableCellNumeric, { width: COL.tenantPct }]}>{Math.round(line.tenantBillBackPercent)}%</Text>
          <Text style={[pdfStyles.tableCellTenant, { width: COL.tenantCost }]}>${formatMoneyPdf(line.tenantCost)}</Text>
        </View>
      ))}

      {/* Subtotal row. Label spans through the Ten % column (82%) so the
          tenant $ subtotal lands directly under its column header. */}
      <View style={pdfStyles.subtotalRow} wrap={false}>
        <Text style={[pdfStyles.subtotalCell, { width: '88%', textAlign: 'right' }]}>Section Subtotal</Text>
        <Text style={[pdfStyles.subtotalCellTenant, { width: COL.tenantCost }]}>${formatMoneyPdf(s.tenantTotal)}</Text>
      </View>
    </View>
  );
}

export async function renderChargebackPdf(ctx: PdfBuildContext): Promise<Buffer | null> {
  // Gallery base flows through context (provider inside the Document).
  const hasChargebackLines = ctx.sections.some(
    (s) => s.lines.some((l) => l.tenantBillBackPercent > 0 && l.tenantCost > 0)
  );
  if (!hasChargebackLines) return null;
  return renderToBuffer(<ChargebackDoc ctx={ctx} />);
}
