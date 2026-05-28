// Server-side shared PDF helpers for Rate Card report generation.
// Never imported into browser code.
//
// Style guide reference: ResiHome brand
//   - Primary: hot pink #ff0060
//   - Accent: teal #73e3df
//   - Typography: Helvetica (bundled with PDF spec). We previously tried to
//     register Raleway from Google Fonts at runtime, but that failed in
//     Vercel's serverless lambda with "Unknown font format" — the lambda
//     can't reliably fetch external font binaries. Using bundled PDF fonts
//     (Helvetica, Helvetica-Bold) avoids the network round-trip and always
//     renders. The brand colors do most of the brand work anyway.

import React from 'react';
import { StyleSheet, Text, View } from '@react-pdf/renderer';

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

// No-op kept for backwards-compat with existing callers. We do NOT register
// any external fonts because Vercel lambda fetches were failing. If you
// later want to add a brand font, bundle the .ttf file into the deploy
// (under public/fonts/) and use a file:// path so there's no network call.
export function ensureFontRegistered() {
  // intentional no-op
}

// ---- Shared styles --------------------------------------------------------

export const pdfStyles = StyleSheet.create({
  page: {
    fontFamily: 'Helvetica',
    fontSize: 9,
    paddingTop: 40,
    paddingBottom: 50,
    paddingLeft: 36,
    paddingRight: 36,
    color: PDF_COLORS.ink,
  },

  // ---- Cover page ----
  cover: {
    backgroundColor: PDF_COLORS.brand,
    color: PDF_COLORS.white,
    margin: -40,
    padding: 48,
    height: '100%',
    flexDirection: 'column',
    justifyContent: 'space-between',
  },
  coverTopBlock: {
    flexDirection: 'column',
    gap: 4,
  },
  coverBadge: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 9,
    letterSpacing: 2,
    color: PDF_COLORS.accent,
    marginBottom: 16,
  },
  coverDocTitle: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 36,
    color: PDF_COLORS.white,
    marginBottom: 8,
    lineHeight: 1.1,
  },
  coverSubtitle: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 14,
    color: PDF_COLORS.white,
    opacity: 0.92,
    marginBottom: 36,
  },
  coverMetaLabel: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 8,
    letterSpacing: 1.4,
    color: PDF_COLORS.accent,
    textTransform: 'uppercase',
    marginTop: 14,
  },
  coverMetaValue: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 13,
    color: PDF_COLORS.white,
    marginTop: 2,
  },
  coverFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    borderTopWidth: 1,
    borderTopColor: PDF_COLORS.accent,
    paddingTop: 12,
  },
  coverFooterLabel: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 8,
    letterSpacing: 1.4,
    color: PDF_COLORS.accent,
    textTransform: 'uppercase',
  },
  coverFooterValue: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 14,
    color: PDF_COLORS.white,
    marginTop: 2,
  },
  coverTenantTotal: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 22,
    color: PDF_COLORS.white,
    marginTop: 2,
  },

  // ---- Page header (non-cover pages) ----
  pageHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 1.5,
    borderBottomColor: PDF_COLORS.brand,
    paddingBottom: 6,
    marginBottom: 14,
  },
  pageHeaderTitle: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 11,
    color: PDF_COLORS.brand,
  },
  pageHeaderRight: {
    fontFamily: 'Helvetica',
    fontSize: 8,
    color: PDF_COLORS.gray,
  },

  // ---- Section block ----
  sectionTitle: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 12,
    color: PDF_COLORS.ink,
    marginTop: 14,
    marginBottom: 4,
  },
  sectionSubtotalRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingTop: 4,
    paddingBottom: 4,
    paddingHorizontal: 6,
    backgroundColor: PDF_COLORS.grayBg,
    marginTop: -1, // touch the table border above
    fontSize: 8,
  },
  sectionSubtotalCell: {
    fontFamily: 'Helvetica',
    fontSize: 8,
    color: PDF_COLORS.gray,
    textAlign: 'right',
    paddingHorizontal: 4,
  },
  sectionSubtotalCellPrimary: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 8,
    color: PDF_COLORS.brand,
    textAlign: 'right',
    paddingHorizontal: 4,
  },

  // ---- Table ----
  tableHeaderRow: {
    flexDirection: 'row',
    backgroundColor: PDF_COLORS.grayBg,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: PDF_COLORS.grayLight,
    paddingVertical: 4,
  },
  tableHeaderCell: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 7,
    color: PDF_COLORS.gray,
    paddingHorizontal: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderBottomColor: PDF_COLORS.grayLight,
    paddingVertical: 5,
  },
  tableCell: {
    fontFamily: 'Helvetica',
    fontSize: 8,
    color: PDF_COLORS.ink,
    paddingHorizontal: 4,
  },
  tableCellNumeric: {
    fontFamily: 'Helvetica',
    fontSize: 8,
    color: PDF_COLORS.ink,
    paddingHorizontal: 4,
    textAlign: 'right',
  },
  tableCellTenant: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 8,
    color: PDF_COLORS.brand,
    paddingHorizontal: 4,
    textAlign: 'right',
  },
  tableCellDescription: {
    fontFamily: 'Helvetica',
    fontSize: 7.5,
    color: PDF_COLORS.gray,
    paddingHorizontal: 4,
    marginTop: 1,
  },

  // ---- Grand totals strip ----
  grandTotalsStrip: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: PDF_COLORS.brand,
    color: PDF_COLORS.white,
    padding: 10,
    marginTop: 14,
  },
  grandTotalsLabel: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 9,
    color: PDF_COLORS.white,
    opacity: 0.85,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  grandTotalsValue: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 14,
    color: PDF_COLORS.white,
    marginTop: 2,
  },
  grandTotalsValueLarge: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 18,
    color: PDF_COLORS.white,
    marginTop: 2,
  },

  // ---- Appendix / photos ----
  appendixTitle: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 16,
    color: PDF_COLORS.brand,
    marginTop: 24,
    marginBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: PDF_COLORS.brand,
    paddingBottom: 4,
  },
  appendixSectionTitle: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 11,
    color: PDF_COLORS.ink,
    marginTop: 12,
    marginBottom: 6,
  },
  photoGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  photoCell: {
    width: '32%',
    height: 130,
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
    bottom: 20,
    left: 36,
    right: 36,
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
 * Page footer with copyright and page number. Place INSIDE each <Page>.
 * The page-number "x of y" rendering is done by react-pdf via the render prop.
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
 * Cover page used by all 4 doc types. Takes meta + the bottom-summary block
 * (which differs per doc type — e.g. Master shows Tenant Total; Vendor shows
 * the vendor name).
 */
export function PdfCover(props: {
  docTitle: string;
  docSubtitle: string;
  propertyName: string;
  inspectorName: string;
  region: string | null;
  squareFootage: number | null;
  bedrooms: number;
  bathrooms: number;
  generatedAtLabel: string;
  /** Bottom-right summary content — different per doc type. */
  summary?: React.ReactNode;
}) {
  return (
    <View style={pdfStyles.cover}>
      <View style={pdfStyles.coverTopBlock}>
        <Text style={pdfStyles.coverBadge}>RESIHOME · INSPECTION</Text>
        <Text style={pdfStyles.coverDocTitle}>{props.docTitle}</Text>
        <Text style={pdfStyles.coverSubtitle}>{props.docSubtitle}</Text>

        <Text style={pdfStyles.coverMetaLabel}>Property</Text>
        <Text style={pdfStyles.coverMetaValue}>{props.propertyName}</Text>

        <Text style={pdfStyles.coverMetaLabel}>Inspector</Text>
        <Text style={pdfStyles.coverMetaValue}>{props.inspectorName}</Text>

        {(props.bedrooms > 0 || props.bathrooms > 0 || (props.squareFootage && props.squareFootage > 0)) && (
          <>
            <Text style={pdfStyles.coverMetaLabel}>Property Detail</Text>
            <Text style={pdfStyles.coverMetaValue}>
              {props.bedrooms} bed / {props.bathrooms} bath
              {props.squareFootage && props.squareFootage > 0
                ? ` · ${props.squareFootage.toLocaleString()} sqft` : ''}
            </Text>
          </>
        )}

        {props.region && (
          <>
            <Text style={pdfStyles.coverMetaLabel}>Region</Text>
            <Text style={pdfStyles.coverMetaValue}>{props.region}</Text>
          </>
        )}
      </View>

      <View style={pdfStyles.coverFooter}>
        <View>
          <Text style={pdfStyles.coverFooterLabel}>Generated</Text>
          <Text style={pdfStyles.coverFooterValue}>{props.generatedAtLabel}</Text>
        </View>
        {props.summary ? (
          <View>{props.summary}</View>
        ) : null}
      </View>
    </View>
  );
}

// ---- Money / number formatting ----

export function formatMoneyPdf(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatQtyPdf(n: number): string {
  // Show integer if it's whole, else up to 2 decimals
  if (Number.isInteger(n)) return n.toString();
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

export function isoToHumanDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

// ---- Shared data types for PDF input ----

export interface PdfLineRow {
  /** External answer id — used to keep React keys stable. */
  externalId: string;
  section: string;
  category: string;
  subcategory: string;
  lineItemCode: string;
  laborShortDescription: string;
  laborFullDescription: string;
  /** True when the inspector overrode the catalog description for this line. */
  hasCustomDescription: boolean;
  laborMeas: string; // unit, e.g. "EA", "SF"
  quantity: number;
  vendor: string;
  vendorCost: number;
  clientCost: number;
  tenantBillBackPercent: number;
  tenantCost: number;
}

export interface PdfSectionGroup {
  /** Section label, e.g. "Yard / Exterior" */
  label: string;
  /** Concatenated with location for repeating rooms, e.g. "Bedroom 1" */
  displayName: string;
  lines: PdfLineRow[];
  photoUrls: string[];
  vendorTotal: number;
  clientTotal: number;
  tenantTotal: number;
}

export interface PdfBuildContext {
  inspectionRecordId: string;
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
