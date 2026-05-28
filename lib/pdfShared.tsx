// Server-side shared PDF helpers for Rate Card report generation.
// Never imported into browser code.
//
// Style notes:
//   - Brand pink #ff0060 + teal accent #73e3df.
//   - Typography: Helvetica (bundled with PDF spec). We previously tried to
//     register Raleway from Google Fonts at runtime, but the lambda fetch
//     failed with "Unknown font format". Using bundled fonts is reliable.
//   - All 3 PDFs (Master, Chargeback, per-Vendor) use a compact header at
//     the top of page 1 instead of a separate cover sheet.
//   - Section photos are rendered INLINE with their section (no appendix).

import React from 'react';
import { StyleSheet, Text, View, Image, Link, Font } from '@react-pdf/renderer';

// Disable word hyphenation globally. @react-pdf's default hyphenation breaks
// long words mid-word (e.g. "Internal Resolution" becomes "Internal Resolu-"
// + "tion", and "Subcategory" becomes "Sub-" + "category"). Returning the
// word as a single chunk forces the layout to wrap at whitespace instead.
// Applies to ALL Text in PDFs since Font.registerHyphenationCallback is
// module-level state.
Font.registerHyphenationCallback((word) => [word]);

export const PDF_COLORS = {
  brand: '#ff0060',
  brandDark: '#cc004d',
  accent: '#73e3df',
  ink: '#1a1a1a',
  black: '#000000',
  gray: '#6b7280',
  grayLight: '#e5e7eb',
  grayBg: '#f9fafb',
  white: '#ffffff',
  emerald: '#059669',
};

// No-op for backwards-compat. No external font registration.
export function ensureFontRegistered() {
  // intentional no-op
}

// ---- Styles --------------------------------------------------------

export const pdfStyles = StyleSheet.create({
  page: {
    fontFamily: 'Helvetica',
    fontSize: 8,
    paddingTop: 28,
    // Reserve enough room for the fixed footer (bottom: 14, height ~12 + 4
    // padding ~= 30). Anything less and section headers / photos at the
    // bottom of a page get rendered behind the footer strip.
    paddingBottom: 48,
    paddingLeft: 24,
    paddingRight: 24,
    color: PDF_COLORS.ink,
  },

  // ---- Compact header strip (replaces full cover page) ----
  // Bleeds to the edges of the page for visual punch.
  headerStrip: {
    marginTop: -28,
    marginLeft: -24,
    marginRight: -24,
    marginBottom: 12,
    padding: 14,
    paddingBottom: 12,
    backgroundColor: PDF_COLORS.brand,
    color: PDF_COLORS.white,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  headerLeft: {
    flexDirection: 'column',
    flex: 1,
  },
  headerTitle: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 14,
    color: PDF_COLORS.white,
    marginBottom: 3,
  },
  headerProperty: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 10,
    color: PDF_COLORS.white,
  },
  headerMeta: {
    fontFamily: 'Helvetica',
    fontSize: 8,
    color: PDF_COLORS.white,
    opacity: 0.9,
    marginTop: 2,
  },
  headerRight: {
    flexDirection: 'column',
    alignItems: 'flex-end',
  },
  headerRightLabel: {
    fontFamily: 'Helvetica',
    fontSize: 7,
    color: PDF_COLORS.white,
    opacity: 0.85,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  headerRightValue: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 12,
    color: PDF_COLORS.white,
    marginTop: 2,
  },

  // ---- Grand totals strip (just below header on page 1) ----
  grandTotalsStrip: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: PDF_COLORS.grayBg,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: PDF_COLORS.grayLight,
    padding: 7,
    marginBottom: 8,
  },
  grandTotalsItem: {
    flexDirection: 'column',
    alignItems: 'flex-start',
  },
  grandTotalsLabel: {
    fontFamily: 'Helvetica',
    fontSize: 7,
    color: PDF_COLORS.gray,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  grandTotalsValue: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 11,
    color: PDF_COLORS.ink,
    marginTop: 1,
  },
  grandTotalsValueBrand: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 12,
    color: PDF_COLORS.brand,
    marginTop: 1,
  },

  // ---- Section ----
  sectionTitle: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 10,
    color: PDF_COLORS.ink,
    marginTop: 10,
    marginBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: PDF_COLORS.brand,
    paddingBottom: 2,
  },

  // ---- Table ----
  tableHeaderRow: {
    flexDirection: 'row',
    backgroundColor: PDF_COLORS.grayBg,
    borderTopWidth: 0.5,
    borderBottomWidth: 0.5,
    borderColor: PDF_COLORS.grayLight,
    paddingVertical: 3,
  },
  tableHeaderCell: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 6.5,
    color: PDF_COLORS.gray,
    paddingHorizontal: 3,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderBottomColor: PDF_COLORS.grayLight,
    paddingVertical: 4,
    minHeight: 0,
  },
  tableCell: {
    fontFamily: 'Helvetica',
    fontSize: 7.5,
    color: PDF_COLORS.ink,
    paddingHorizontal: 3,
  },
  tableCellCentered: {
    fontFamily: 'Helvetica',
    fontSize: 7.5,
    color: PDF_COLORS.ink,
    paddingHorizontal: 3,
    textAlign: 'center',
  },
  tableCellNumeric: {
    fontFamily: 'Helvetica',
    fontSize: 7.5,
    color: PDF_COLORS.ink,
    paddingHorizontal: 3,
    textAlign: 'right',
  },
  tableCellTenant: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 7.5,
    color: PDF_COLORS.brand,
    paddingHorizontal: 3,
    textAlign: 'right',
  },
  tableCellDescription: {
    fontFamily: 'Helvetica',
    fontSize: 6.5,
    color: PDF_COLORS.gray,
    paddingHorizontal: 3,
    marginTop: 1,
  },

  // ---- Subtotal row (bold, slightly different background) ----
  subtotalRow: {
    flexDirection: 'row',
    backgroundColor: PDF_COLORS.grayBg,
    borderTopWidth: 1,
    borderTopColor: PDF_COLORS.gray,
    paddingVertical: 4,
  },
  subtotalCell: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 7.5,
    color: PDF_COLORS.ink,
    paddingHorizontal: 3,
    textAlign: 'right',
  },
  subtotalCellTenant: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 8,
    color: PDF_COLORS.brand,
    paddingHorizontal: 3,
    textAlign: 'right',
  },

  // ---- Section photos (inline, smaller) ----
  // Each photo about half the previous size (~65 wide instead of 130 high).
  photoGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 6,
    marginBottom: 6,
  },
  photoCell: {
    width: 90,
    height: 65,
    backgroundColor: PDF_COLORS.grayBg,
    borderWidth: 0.5,
    borderColor: PDF_COLORS.grayLight,
  },
  photoCellImage: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  },

  // ---- Footer ----
  footer: {
    position: 'absolute',
    bottom: 14,
    left: 24,
    right: 24,
    flexDirection: 'row',
    justifyContent: 'space-between',
    fontSize: 7,
    color: PDF_COLORS.gray,
    paddingTop: 4,
    borderTopWidth: 0.5,
    borderTopColor: PDF_COLORS.grayLight,
  },
});

// ---- Reusable subcomponents ----

/**
 * Page footer with attribution and page number. Place INSIDE each <Page>.
 */
export function PdfFooter(props: { docName: string; propertyName: string }) {
  return (
    <View style={pdfStyles.footer} fixed>
      <Text>ResiHome — {props.docName}{props.propertyName ? ` — ${props.propertyName}` : ''}</Text>
      <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
    </View>
  );
}

/**
 * Compact header strip rendered at the top of page 1 of every PDF (replaces
 * the full cover page).
 *   - LEFT: doc title (e.g. "Internal Resolution Scope Rate Card"), property
 *     address, then meta (inspector + bed/bath/sqft + region + generated date)
 *   - RIGHT: caller-supplied summary block (typically the main money total)
 */
export function PdfHeaderStrip(props: {
  docTitle: string;
  propertyName: string;
  inspectorName: string;
  region: string | null;
  squareFootage: number | null;
  bedrooms: number;
  bathrooms: number;
  generatedAtLabel: string;
  /** Right-aligned summary content — typically a Tenant Total or Vendor Total. */
  summary?: React.ReactNode;
}) {
  const metaParts: string[] = [];
  metaParts.push(props.inspectorName);
  if (props.bedrooms > 0 || props.bathrooms > 0) {
    metaParts.push(`${props.bedrooms} bed / ${props.bathrooms} bath`);
  }
  if (props.squareFootage && props.squareFootage > 0) {
    metaParts.push(`${props.squareFootage.toLocaleString()} sqft`);
  }
  if (props.region) metaParts.push(props.region);
  metaParts.push(props.generatedAtLabel);

  return (
    <View style={pdfStyles.headerStrip}>
      <View style={pdfStyles.headerLeft}>
        <Text style={pdfStyles.headerTitle}>{props.docTitle}</Text>
        <Text style={pdfStyles.headerProperty}>{props.propertyName}</Text>
        <Text style={pdfStyles.headerMeta}>{metaParts.join(' · ')}</Text>
      </View>
      {props.summary ? <View style={pdfStyles.headerRight}>{props.summary}</View> : null}
    </View>
  );
}

/**
 * Inline section photos. Render right after the section title and before the
 * table. No appendix — photos sit with their section. Each photo is wrapped
 * in a <Link> pointing to the original HubSpot Files URL, so clicking the
 * thumbnail in a PDF viewer opens the full-resolution image in the user's
 * browser. Compatible with all major PDF viewers (Acrobat, Preview, Chrome).
 */
export function PdfSectionPhotos(props: { photoUrls: string[] }) {
  if (props.photoUrls.length === 0) return null;
  return (
    <View style={pdfStyles.photoGrid}>
      {props.photoUrls.map((url, i) => (
        <Link key={`${url}-${i}`} src={url} style={pdfStyles.photoCell}>
          {/* eslint-disable-next-line jsx-a11y/alt-text */}
          <Image src={url} style={pdfStyles.photoCellImage} />
        </Link>
      ))}
    </View>
  );
}

/**
 * Section title + section photos as ONE non-splittable block.
 *
 * Why: react-pdf's auto page-break can land the title at the bottom of a
 * page and put the photos (or the first table row) at the top of the next.
 * Worse, the title can land where the fixed footer renders, so the title
 * disappears entirely under the footer strip.
 *
 * Wrapping them together with wrap={false} means the layout engine treats
 * this as one atomic block — if it doesn't fit at the bottom of a page, the
 * whole block bumps to the next page. The table that follows can still wrap
 * normally (rows are individually wrap={false} but the table itself isn't).
 */
export function PdfSectionHeader(props: { title: string; photoUrls: string[] }) {
  return (
    <View wrap={false} style={{ marginTop: 8 }}>
      <Text style={pdfStyles.sectionTitle}>{props.title}</Text>
      <PdfSectionPhotos photoUrls={props.photoUrls} />
    </View>
  );
}

// ---- Money / number formatting ----

export function formatMoneyPdf(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatQtyPdf(n: number): string {
  if (Number.isInteger(n)) return n.toString();
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

export function isoToHumanDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

// ---- Shared data types ----

export interface PdfLineRow {
  externalId: string;
  section: string;
  category: string;
  subcategory: string;
  lineItemCode: string;
  laborShortDescription: string;
  laborFullDescription: string;
  hasCustomDescription: boolean;
  laborMeas: string;
  quantity: number;
  vendor: string;
  vendorCost: number;
  clientCost: number;
  tenantBillBackPercent: number;
  tenantCost: number;
}

export interface PdfSectionGroup {
  label: string;
  displayName: string;
  lines: PdfLineRow[];
  photoUrls: string[];
  vendorTotal: number;
  clientTotal: number;
  tenantTotal: number;
}

export interface PdfBuildContext {
  inspectionRecordId: string;
  /** Clean template name with prefixes stripped, e.g. "Scope Rate Card". */
  templateLabel: string;
  propertyName: string;
  inspectorName: string;
  bedrooms: number;
  bathrooms: number;
  squareFootage: number | null;
  region: string | null;
  generatedAtIso: string;
  sections: PdfSectionGroup[];
  grandTotals: { vendor: number; client: number; tenant: number; lineCount: number };
}
