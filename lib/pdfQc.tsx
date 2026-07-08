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
  PdfSummaryTable,
  PdfGalleryBaseProvider,
  buildListingLine,
  formatMoneyPdf,
  formatQtyPdf,
  isoToHumanDate,
  type PdfSummaryColumn,
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
  // QC reviewer's explanation when failed — shown so the vendor/MC know what to fix.
  failureNote?: string;
}

export interface QcPdfSection {
  displayName: string;
  lines: QcPdfLine[];
  beforePhotos: string[];
  afterPhotos: string[];
  passCount: number;
  failCount: number;
  /** Standalone-QC (no line items): optional per-room verdict + note. */
  roomVerdict?: 'pass' | 'fail' | '';
  roomNote?: string;
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
  // Listing snapshot for the header listing line (status · price · listed ·
  // Move-In). Move-In is set only on deposit-taken listings.
  listingStatus?: string | null;
  listingPrice?: number | null;
  listingDate?: string | null;
  moveInDate?: string | null;
  verdict: 'pass' | 'fail';
  // Overall failure comment (verdict === 'fail') — shown prominently on the report.
  overallNote?: string;
  passCount: number;
  failCount: number;
  sections: QcPdfSection[];
  /** poster URL → embedded JPEG data URI (so photos stay clickable to the
   *  full-size file / gallery while embedding small thumbnails). */
  embeddedByUrl?: Record<string, string>;
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

  // Page-1 condensed summary columns — Room is prepended by PdfSummaryTable;
  // these widths + roomWidth (12%) sum to 100%.
  const summaryColumns: PdfSummaryColumn<QcPdfLine>[] = [
    { key: 'category', header: 'Category', width: '11%', cell: (l) => l.category },
    { key: 'subcategory', header: 'Sub', width: '10%', cell: (l) => l.subcategory },
    { key: 'description', header: 'Line Item', width: '24%', cell: (l) => l.description },
    { key: 'qty', header: 'Qty', width: '5%', align: 'center', cell: (l) => (l.quantity != null ? formatQtyPdf(l.quantity) : '') },
    { key: 'unit', header: 'Unit', width: '5%', align: 'center', cell: (l) => l.unit },
    { key: 'vendor', header: 'Vendor', width: '11%', align: 'center', cell: (l) => l.vendor },
    { key: 'vendorCost', header: 'Vendor $', width: '10%', align: 'right', cell: (l) => (l.vendorCost != null ? `$${formatMoneyPdf(l.vendorCost)}` : '') },
    {
      key: 'result', header: 'Result', width: '12%', align: 'center', hasTotal: true,
      cell: (l) => <ResultChip pf={l.passFail} />,
      grandTotal: `${ctx.passCount}P / ${ctx.failCount}F`,
    },
  ];

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
          listingLine={buildListingLine({ listingStatus: ctx.listingStatus, listingPrice: ctx.listingPrice, listingDate: ctx.listingDate, moveInDate: ctx.moveInDate })}
          inspectorTopRight
          summary={
            <>
              <Text style={[pdfStyles.headerRightLabel, { marginTop: 5 }]}>Verdict</Text>
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

        {/* Overall failure reason (when the re-inspect failed). */}
        {ctx.verdict === 'fail' && !!ctx.overallNote && (
          <View style={{ marginTop: 6, marginBottom: 8, padding: 8, borderWidth: 1, borderColor: PDF_COLORS.brand, borderRadius: 4 }}>
            <Text style={{ fontFamily: 'Helvetica-Bold', fontSize: 9, color: PDF_COLORS.brand, marginBottom: 2, textTransform: 'uppercase' }}>Reason for Fail</Text>
            <Text style={{ fontSize: 9, color: PDF_COLORS.brand }}>{ctx.overallNote}</Text>
          </View>
        )}

        {/* Page 1: condensed summary. Scope-backed QC lists every re-inspected
            LINE grouped by room; a standalone QC (no line items) lists each ROOM
            with its optional Pass/Fail + note. */}
        {ctx.sections.some((s) => s.lines.length > 0) ? (
          <PdfSummaryTable
            title="Re-Inspect Summary — All Line Items"
            groups={ctx.sections}
            columns={summaryColumns}
            roomWidth="12%"
            grandTotalLabel="Grand Total"
          />
        ) : (
          <PdfSummaryTable<{ note: string; passFail: 'pass' | 'fail' | '' }>
            title="Re-Inspect Summary — Rooms"
            groups={ctx.sections.map((s) => ({
              displayName: s.displayName,
              lines: [{ note: s.roomNote || '', passFail: s.roomVerdict || '' }],
            }))}
            roomWidth="24%"
            roomHeader="Room"
            columns={[
              { key: 'note', header: 'Notes', width: '56%', cell: (l) => l.note },
              {
                key: 'result', header: 'Result', width: '20%', align: 'center', hasTotal: true,
                cell: (l) => <ResultChip pf={l.passFail} />,
                grandTotal: `${ctx.passCount}P / ${ctx.failCount}F`,
              },
            ]}
            grandTotalLabel="Grand Total"
          />
        )}

        {/* Detail pages: each room with before/after photos + full line table. */}
        <View break>
          {ctx.sections.map((s, i) => (
            <QcSection key={`${s.displayName}-${i}`} section={s} />
          ))}
        </View>

        <PdfFooter docName="Turn Re-Inspect QC" propertyName={ctx.propertyName} />
      </Page>
    </Document>
  );
}

function QcSection({ section: s }: { section: QcPdfSection }) {
  return (
    <View>
      {/* Section header bar (title + pass/fail counts) is the ONLY atomic block:
          wrap={false} keeps it from splitting, and minPresenceAhead reserves room
          after it so it can't strand at a page bottom / slide under the fixed
          footer. The Before/After photo grids MUST flow OUTSIDE this block — if
          they were inside it, a section with many before+after photos would form
          one atomic block taller than a page, which react-pdf CLIPS (the reported
          disaster: half-images bleeding into the footer and the next page). Each
          PdfSectionPhotos paginates itself per row, so left to flow it breaks
          cleanly across pages. */}
      <View wrap={false} minPresenceAhead={80} style={{ marginTop: 10 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end',
                       borderBottomWidth: 1, borderBottomColor: PDF_COLORS.brand, paddingBottom: 2, marginBottom: 4 }}>
          <Text style={{ fontFamily: 'Helvetica-Bold', fontSize: 10, color: PDF_COLORS.ink }}>{s.displayName}</Text>
          <Text style={{ fontFamily: 'Helvetica-Bold', fontSize: 8 }}>
            <Text style={{ color: PDF_COLORS.emerald }}>{s.passCount} pass</Text>
            <Text style={{ color: PDF_COLORS.gray }}>  ·  </Text>
            <Text style={{ color: PDF_COLORS.brand }}>{s.failCount} fail</Text>
          </Text>
        </View>
      </View>

      {/* Before photos — full-width labeled block (same grid as Rate Card). The
          label is kept with at least its first photo row (wrap={false} +
          minPresenceAhead) so it can't strand alone at a page bottom, while the
          grid itself flows/paginates. */}
      {s.beforePhotos.length > 0 && (
        <View style={{ marginBottom: 2 }}>
          <View wrap={false} minPresenceAhead={80}>
            <Text style={{ fontFamily: 'Helvetica-Bold', fontSize: 8, color: PDF_COLORS.gray, textTransform: 'uppercase', letterSpacing: 0.5 }}>Before</Text>
          </View>
          <PdfSectionPhotos photoUrls={s.beforePhotos} />
        </View>
      )}

      {/* After photos — full-width labeled block, teal label to distinguish */}
      {s.afterPhotos.length > 0 && (
        <View style={{ marginBottom: 2 }}>
          <View wrap={false} minPresenceAhead={80}>
            <Text style={{ fontFamily: 'Helvetica-Bold', fontSize: 8, color: PDF_COLORS.teal, textTransform: 'uppercase', letterSpacing: 0.5 }}>After</Text>
          </View>
          <PdfSectionPhotos photoUrls={s.afterPhotos} />
        </View>
      )}

      {/* Standalone-QC room verdict + note (no line items). */}
      {s.lines.length === 0 && s.roomVerdict ? (
        <Text style={{ fontFamily: 'Helvetica-Bold', fontSize: 9, marginTop: 2, color: s.roomVerdict === 'fail' ? PDF_COLORS.brand : PDF_COLORS.emerald }}>
          Room result: {s.roomVerdict === 'fail' ? 'FAIL' : 'PASS'}
        </Text>
      ) : null}
      {s.lines.length === 0 && s.roomNote ? (
        <Text style={{ fontSize: 8, color: PDF_COLORS.ink, marginTop: 1 }}>
          <Text style={{ fontFamily: 'Helvetica-Bold' }}>Notes: </Text>{s.roomNote}
        </Text>
      ) : null}

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
                {line.passFail === 'fail' && !!line.failureNote && (
                  <Text style={[pdfStyles.tableCell, { color: '#b91c1c', fontStyle: 'italic', marginTop: 1 }]}>Failed: {line.failureNote}</Text>
                )}
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
  // Wrap in the gallery provider so photos embed small thumbnails but LINK to the
  // full-size file / browsable gallery (clickable in the PDF viewer).
  return renderToBuffer(
    <PdfGalleryBaseProvider base={(ctx as any).photoGalleryBase} embedded={ctx.embeddedByUrl}>
      <QcDoc ctx={ctx} />
    </PdfGalleryBaseProvider>,
  );
}
