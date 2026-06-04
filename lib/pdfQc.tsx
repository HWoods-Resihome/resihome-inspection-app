// QC Turn Re-Inspect PDF.
//
// Validates that a vendor completed the work dispatched on a Scope Rate Card.
// Layout mirrors the Master Rate Card report but:
//   - columns stop at Vendor $ (no Client/Tenant)
//   - adds a Result (Pass/Fail) column per line
//   - shows Before + After photos per section
//   - header shows the overall verdict + pass/fail counts
//   - each section header tallies its own pass/fail counts

import React from 'react';
import { Document, Page, Text, View, renderToBuffer } from '@react-pdf/renderer';
import {
  pdfStyles,
  PDF_COLORS,
  ensureFontRegistered,
  PdfHeaderStrip,
  PdfFooter,
  PdfSectionPhotos,
  setPdfPhotoGalleryBase,
  formatMoneyPdf,
  formatQtyPdf,
  isoToHumanDate,
} from './pdfShared';

export interface QcPdfLine {
  category: string;
  subcategory: string;
  unit: string;
  description: string;
  quantity: number | null;
  vendor: string;
  vendorCost: number | null;
  passFail: 'pass' | 'fail' | '';
}

export interface QcPdfSection {
  displayName: string;
  lines: QcPdfLine[];
  beforePhotos: string[];
  afterPhotos: string[];
  passCount: number;
  failCount: number;
}

export interface QcPdfContext {
  templateLabel: string;
  propertyName: string;
  inspectorName: string;
  bedrooms: number;
  bathrooms: number;
  squareFootage: number | null;
  region: string | null;
  sourceRateCardName: string | null;
  generatedAtIso: string;
  verdict: 'pass' | 'fail';
  passCount: number;
  failCount: number;
  sections: QcPdfSection[];
}

// QC column layout mirrors Scope (no client/tenant) + Result:
//   Cat 13 | Sub 12 | Description 30 | Qty 6 | Unit 6 | Vendor 12 | Ven$ 10 | Result 11
const COL = {
  category: '13%',
  subcategory: '12%',
  description: '30%',
  unit: '6%',
  qty: '6%',
  vendor: '12%',
  vendorCost: '10%',
  result: '11%',
};

function ResultChip({ pf }: { pf: 'pass' | 'fail' | '' }) {
  if (pf === 'pass') {
    return <Text style={{ fontFamily: 'Helvetica-Bold', fontSize: 7.5, color: PDF_COLORS.emerald, textAlign: 'center' }}>PASS</Text>;
  }
  if (pf === 'fail') {
    return <Text style={{ fontFamily: 'Helvetica-Bold', fontSize: 7.5, color: PDF_COLORS.brand, textAlign: 'center' }}>FAIL</Text>;
  }
  return <Text style={{ fontFamily: 'Helvetica', fontSize: 7.5, color: PDF_COLORS.gray, textAlign: 'center' }}>—</Text>;
}

function QcDoc({ ctx }: { ctx: QcPdfContext }) {
  ensureFontRegistered();
  const generatedAtLabel = isoToHumanDate(ctx.generatedAtIso);
  const verdictColor = ctx.verdict === 'pass' ? PDF_COLORS.emerald : PDF_COLORS.brand;
  const verdictText = ctx.verdict === 'pass' ? 'PASS' : 'FAIL';

  return (
    <Document title={`Turn Re-Inspect QC — ${ctx.propertyName}`} author="ResiHome" subject="Turn Re-Inspect QC">
      <Page size="LETTER" style={pdfStyles.page} wrap>
        <PdfHeaderStrip
          docTitle={`${ctx.templateLabel}`}
          propertyName={ctx.propertyName}
          inspectorName={ctx.inspectorName}
          region={ctx.region}
          squareFootage={ctx.squareFootage}
          bedrooms={ctx.bedrooms}
          bathrooms={ctx.bathrooms}
          generatedAtLabel={generatedAtLabel}
          summary={
            <>
              <Text style={pdfStyles.headerRightLabel}>Verdict</Text>
              <Text style={[pdfStyles.headerRightValue, { color: PDF_COLORS.white }]}>{verdictText}</Text>
            </>
          }
        />

        {/* Verdict + counts strip */}
        <View style={pdfStyles.grandTotalsStrip}>
          <View style={pdfStyles.grandTotalsItem}>
            <Text style={pdfStyles.grandTotalsLabel}>Verdict</Text>
            <Text style={[pdfStyles.grandTotalsValue, { color: verdictColor }]}>{verdictText}</Text>
          </View>
          <View style={pdfStyles.grandTotalsItem}>
            <Text style={pdfStyles.grandTotalsLabel}>Passed</Text>
            <Text style={[pdfStyles.grandTotalsValue, { color: PDF_COLORS.emerald }]}>{ctx.passCount}</Text>
          </View>
          <View style={pdfStyles.grandTotalsItem}>
            <Text style={pdfStyles.grandTotalsLabel}>Failed</Text>
            <Text style={[pdfStyles.grandTotalsValue, { color: PDF_COLORS.brand }]}>{ctx.failCount}</Text>
          </View>
          <View style={pdfStyles.grandTotalsItem}>
            <Text style={pdfStyles.grandTotalsLabel}>Total Items</Text>
            <Text style={pdfStyles.grandTotalsValue}>{ctx.passCount + ctx.failCount}</Text>
          </View>
        </View>

        {/* Source reference line */}
        {ctx.sourceRateCardName && (
          <Text style={{ fontFamily: 'Helvetica', fontSize: 8, color: PDF_COLORS.gray, marginBottom: 6 }}>
            Validating: {ctx.sourceRateCardName}
          </Text>
        )}

        {ctx.sections.map((s, i) => (
          <QcSection key={`${s.displayName}-${i}`} section={s} />
        ))}

        <PdfFooter docName="Turn Re-Inspect QC" propertyName={ctx.propertyName} />
      </Page>
    </Document>
  );
}

function QcSection({ section: s }: { section: QcPdfSection }) {
  return (
    <View>
      {/* Section header (title + counts) kept with the first content as an
          atomic block so it doesn't strand at a page bottom. */}
      <View wrap={false} style={{ marginTop: 10 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end',
                       borderBottomWidth: 1, borderBottomColor: PDF_COLORS.brand, paddingBottom: 2, marginBottom: 4 }}>
          <Text style={{ fontFamily: 'Helvetica-Bold', fontSize: 10, color: PDF_COLORS.ink }}>{s.displayName}</Text>
          <Text style={{ fontFamily: 'Helvetica-Bold', fontSize: 8 }}>
            <Text style={{ color: PDF_COLORS.emerald }}>{s.passCount} pass</Text>
            <Text style={{ color: PDF_COLORS.gray }}>  ·  </Text>
            <Text style={{ color: PDF_COLORS.brand }}>{s.failCount} fail</Text>
          </Text>
        </View>

        {/* Before photos — full-width labeled block (same grid as Rate Card) */}
        {s.beforePhotos.length > 0 && (
          <View style={{ marginBottom: 2 }}>
            <Text style={{ fontFamily: 'Helvetica-Bold', fontSize: 8, color: PDF_COLORS.gray, textTransform: 'uppercase', letterSpacing: 0.5 }}>Before</Text>
            <PdfSectionPhotos photoUrls={s.beforePhotos} />
          </View>
        )}

        {/* After photos — full-width labeled block, teal label to distinguish */}
        {s.afterPhotos.length > 0 && (
          <View style={{ marginBottom: 2 }}>
            <Text style={{ fontFamily: 'Helvetica-Bold', fontSize: 8, color: PDF_COLORS.teal, textTransform: 'uppercase', letterSpacing: 0.5 }}>After</Text>
            <PdfSectionPhotos photoUrls={s.afterPhotos} />
          </View>
        )}
      </View>

      {s.lines.length > 0 && (
        <>
          <View style={pdfStyles.tableHeaderRow}>
            <Text style={[pdfStyles.tableHeaderCell, { width: COL.category }]}>Category</Text>
            <Text style={[pdfStyles.tableHeaderCell, { width: COL.subcategory }]}>Sub</Text>
            <Text style={[pdfStyles.tableHeaderCell, { width: COL.description }]}>Line Item</Text>
            <Text style={[pdfStyles.tableHeaderCell, { width: COL.qty, textAlign: 'center' }]}>Qty</Text>
            <Text style={[pdfStyles.tableHeaderCell, { width: COL.unit, textAlign: 'center' }]}>Unit</Text>
            <Text style={[pdfStyles.tableHeaderCell, { width: COL.vendor, textAlign: 'center' }]}>Vendor</Text>
            <Text style={[pdfStyles.tableHeaderCell, { width: COL.vendorCost, textAlign: 'right' }]}>Vendor $</Text>
            <Text style={[pdfStyles.tableHeaderCell, { width: COL.result, textAlign: 'center' }]}>Result</Text>
          </View>

          {s.lines.map((line, idx) => (
            <View key={idx} style={pdfStyles.tableRow} wrap={false}>
              <Text style={[pdfStyles.tableCell, { width: COL.category }]}>{line.category}</Text>
              <Text style={[pdfStyles.tableCell, { width: COL.subcategory }]}>{line.subcategory}</Text>
              <View style={{ width: COL.description }}>
                <Text style={pdfStyles.tableCell}>{line.description}</Text>
              </View>
              <Text style={[pdfStyles.tableCellCentered, { width: COL.qty }]}>{line.quantity != null ? formatQtyPdf(line.quantity) : ''}</Text>
              <Text style={[pdfStyles.tableCellCentered, { width: COL.unit }]}>{line.unit}</Text>
              <Text style={[pdfStyles.tableCellCentered, { width: COL.vendor }]}>{line.vendor}</Text>
              <Text style={[pdfStyles.tableCellNumeric, { width: COL.vendorCost }]}>{line.vendorCost != null ? `$${formatMoneyPdf(line.vendorCost)}` : ''}</Text>
              <View style={{ width: COL.result }}><ResultChip pf={line.passFail} /></View>
            </View>
          ))}
        </>
      )}
    </View>
  );
}

export async function renderQcPdf(ctx: QcPdfContext): Promise<Buffer> {
  setPdfPhotoGalleryBase((ctx as any).photoGalleryBase);
  return renderToBuffer(<QcDoc ctx={ctx} />);
}
