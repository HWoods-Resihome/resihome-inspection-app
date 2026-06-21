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
import { isVideoEntry, getPosterUrl, getVideoUrl } from '@/lib/media';
import { BRAND_LOGO_DATA_URI } from '@/lib/brandLogo';

// Brand mark for the PDF header: the app logo (pink #ff0060 tile + white house &
// footprint), inlined as a base64 data URI. Because the header background is the
// same brand pink, the tile blends seamlessly and reads as a clean white
// house+footprint on pink.
export function brandLogoDataUri(): string {
  return BRAND_LOGO_DATA_URI;
}

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
  teal: '#0d9488',
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
    // Top-align so the right column's inspector name sits on the title row; the
    // logo is re-centered on its own via alignSelf (see headerLogo).
    alignItems: 'flex-start',
  },
  headerLogo: {
    width: 38,
    height: 38,
    borderRadius: 8,
    marginRight: 12,
    // Vertically center the logo within the pink band even though the strip
    // itself is top-aligned (so the inspector name can sit on the title row).
    alignSelf: 'center',
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
    // Equal-width columns, each value centered under its header — so the summary
    // values read as a centered, evenly-spaced row.
    flex: 1,
    alignItems: 'center',
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

  // ---- Page-1 condensed summary table (one row per line item, Room as its
  //      own column, no photos, single grand-total row at the bottom) ----
  summaryRoomCell: {
    fontFamily: 'Helvetica',
    fontSize: 7.5,
    color: PDF_COLORS.ink,
    paddingHorizontal: 3,
  },
  summaryLineRow: {
    flexDirection: 'row',
    alignItems: 'center', // vertically center the cell values for a cleaner line
    borderBottomWidth: 0.5,
    borderBottomColor: PDF_COLORS.grayLight,
    paddingVertical: 2.5,
    minHeight: 0,
  },
  summaryGrandRow: {
    flexDirection: 'row',
    backgroundColor: PDF_COLORS.grayBg,
    borderTopWidth: 1.5,
    borderTopColor: PDF_COLORS.brand,
    borderBottomWidth: 1.5,
    borderBottomColor: PDF_COLORS.brand,
    paddingVertical: 5,
    marginTop: 1,
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
  videoBadge: {
    position: 'absolute',
    bottom: 2,
    left: 2,
    backgroundColor: 'rgba(0,0,0,0.65)',
    color: '#ffffff',
    fontSize: 6,
    paddingHorizontal: 3,
    paddingVertical: 1,
    borderRadius: 2,
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
/** Compose the header listing line: "Status · Listing $X · Listed M/D/YY ·
 *  Move-In: M/D/YY". Shared by every report that shows listing info (all except
 *  Community). Move-In is only present on deposit-taken listings (set upstream).
 *  Returns null when there's nothing to show. */
export function buildListingLine(opts: {
  listingStatus?: string | null;
  listingPrice?: number | null;
  listingDate?: string | null;
  moveInDate?: string | null;
}): string | null {
  // Only show the listing line when the most-recent listing is Active or Deposit
  // Taken. Leased (and any other status) is skipped entirely.
  if (!/active|deposit/i.test(opts.listingStatus || '')) return null;
  const isDeposit = /deposit/i.test(opts.listingStatus || '');
  const parts: string[] = [];
  if (opts.listingStatus) parts.push(opts.listingStatus);
  if (typeof opts.listingPrice === 'number' && opts.listingPrice > 0) parts.push(`$${opts.listingPrice.toLocaleString()}`);
  // Deposit-taken: drop the listed date and show the move-in instead. Active:
  // show the listed date (no move-in).
  if (!isDeposit && opts.listingDate) parts.push(`Listed ${opts.listingDate}`);
  if (isDeposit && opts.moveInDate) parts.push(`Move-In: ${opts.moveInDate}`);
  return parts.length ? parts.join(' · ') : null;
}

export function PdfHeaderStrip(props: {
  docTitle: string;
  propertyName: string;
  inspectorName: string;
  region: string | null;
  squareFootage: number | null;
  bedrooms: number;
  bathrooms: number;
  generatedAtLabel: string;
  /** Optional "M/DD/YY Submitted" stamp shown right after the inspector name. */
  submittedLabel?: string | null;
  /** Optional approver name + "M/DD/YY Approved" stamp shown on a second line. */
  approverName?: string | null;
  approvedLabel?: string | null;
  /** Optional listing line (e.g. "Active · Listing $1,995 · Listed 5/8/2026"). */
  listingLine?: string | null;
  /** When true, render the property details line BEFORE the inspector line
   *  (1099 layout). Default false (inspector first — Scope/QC layout). */
  detailsFirst?: boolean;
  /** When true, the inspector name moves to the TOP-RIGHT (on the title row) and
   *  is dropped from the left column — saving a line and shortening the header.
   *  The `summary` (e.g. RESULT) then renders just below it on the right. */
  inspectorTopRight?: boolean;
  /** Right-aligned summary content — typically a Tenant Total or Vendor Total. */
  summary?: React.ReactNode;
}) {
  // Inspector + (optional) submitted stamp on one line.
  const inspectorLine = props.submittedLabel
    ? `${props.inspectorName}  ·  ${props.submittedLabel}`
    : props.inspectorName;
  // In the Scope submitter/approver layout (submittedLabel present) the
  // left-column line is labeled "Inspector: …" so it mirrors the "Approver: …"
  // line right below it. The top-right placement (Community/QC) stays unlabeled.
  const inspectorLeftLine = props.submittedLabel ? `Inspector: ${inspectorLine}` : inspectorLine;

  const metaParts: string[] = [];
  if (props.bedrooms > 0 || props.bathrooms > 0) {
    metaParts.push(`${props.bedrooms} Bed / ${props.bathrooms} Bath`);
  }
  if (props.squareFootage && props.squareFootage > 0) {
    metaParts.push(`${props.squareFootage.toLocaleString()} sqft`);
  }
  metaParts.push(props.generatedAtLabel);

  const inspectorEl = <Text style={pdfStyles.headerMeta}>{inspectorLeftLine}</Text>;
  const approverEl = props.approverName ? (
    <Text style={pdfStyles.headerMeta}>
      Approver: {props.approverName}{props.approvedLabel ? `  ·  ${props.approvedLabel}` : ''}
    </Text>
  ) : null;
  const detailsEl = <Text style={pdfStyles.headerMeta}>{metaParts.join(' · ')}</Text>;
  const listingEl = props.listingLine ? <Text style={pdfStyles.headerMeta}>{props.listingLine}</Text> : null;

  const logoSrc = brandLogoDataUri();
  // Inspector shown in the left column ONLY when it's not pinned to the top-right.
  const inspectorLeftEl = props.inspectorTopRight ? null : inspectorEl;
  const rightCol = (props.summary || props.inspectorTopRight) ? (
    <View style={pdfStyles.headerRight}>
      {props.inspectorTopRight ? (
        <Text style={[pdfStyles.headerProperty, { textAlign: 'right' }]}>{inspectorLine}</Text>
      ) : null}
      {props.summary}
    </View>
  ) : null;
  return (
    <View style={pdfStyles.headerStrip}>
      {logoSrc ? <Image src={logoSrc} style={pdfStyles.headerLogo} /> : null}
      <View style={pdfStyles.headerLeft}>
        <Text style={pdfStyles.headerTitle}>{props.docTitle}</Text>
        <Text style={pdfStyles.headerProperty}>{props.propertyName}</Text>
        {props.detailsFirst ? (
          <>
            {detailsEl}
            {listingEl}
            {inspectorLeftEl}
            {approverEl}
          </>
        ) : (
          <>
            {inspectorLeftEl}
            {approverEl}
            {detailsEl}
            {listingEl}
          </>
        )}
      </View>
      {rightCol}
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
// Per-render context: the gallery base (photo links) AND a map of downscaled
// thumbnails to EMBED. Supplied inside each Document (PdfGalleryBaseProvider) so
// concurrent renders don't clobber each other. Embedding the stored ~1280px/600KB
// photos into the tiny 90×65pt cells made finalized PDFs tens of MB and slow to
// scroll; `embedded[posterUrl]` holds a small JPEG data URI to draw instead (the
// link still points at the full-size gallery). The global below is a legacy
// fallback for callers not yet wrapped in the provider (e.g. the QC PDF).
interface PdfRenderCtx { galleryBase?: string; embedded?: Record<string, string>; }
const PdfGalleryBaseContext = React.createContext<PdfRenderCtx>({});
/** Wrap a Document's children so its photos link to this gallery base and embed
 *  the supplied downscaled thumbnails. */
export function PdfGalleryBaseProvider(props: { base?: string; embedded?: Record<string, string>; children: React.ReactNode }) {
  return <PdfGalleryBaseContext.Provider value={{ galleryBase: props.base, embedded: props.embedded }}>{props.children}</PdfGalleryBaseContext.Provider>;
}
// Legacy module-level fallback (used by any render path not yet wrapped in the
// provider). Set before renderToBuffer; the context value takes precedence.
// NOTE: relying on this is NOT safe under concurrent renders — prefer the
// provider for anything parallelized.
let _photoGalleryBase: string | undefined;
export function setPdfPhotoGalleryBase(base: string | undefined) { _photoGalleryBase = base; }

export function PdfSectionPhotos(props: { photoUrls: string[] }) {
  // Prefer the per-render context base; fall back to the legacy global.
  const { galleryBase: ctxBase, embedded } = React.useContext(PdfGalleryBaseContext);
  const galleryBase = ctxBase ?? _photoGalleryBase;
  if (props.photoUrls.length === 0) return null;
  return (
    <View style={pdfStyles.photoGrid}>
      {props.photoUrls.map((entry, i) => {
        // Video clips embed the poster image and link to the playable file.
        const poster = getPosterUrl(entry);
        const video = isVideoEntry(entry) ? getVideoUrl(entry) : '';
        const fileHref = video || poster;
        // EMBED the downscaled thumbnail when we have one (keeps the PDF small);
        // otherwise fall back to the full-size poster URL.
        const imgSrc = (embedded && embedded[poster]) || poster;
        // Gallery link (starts at this photo) when a base is set; else the file.
        // Join correctly whether the base already carries query params (per-PDF
        // scoping, e.g. ?k=vendor&v=slug).
        const sep = galleryBase && galleryBase.includes('?') ? '&' : '?';
        const href = galleryBase ? `${galleryBase}${sep}u=${encodeURIComponent(entry)}` : fileHref;
        return (
          <Link key={`${entry}-${i}`} src={href} style={pdfStyles.photoCell}>
            {/* eslint-disable-next-line jsx-a11y/alt-text */}
            <Image src={imgSrc} style={pdfStyles.photoCellImage} />
            {video ? <Text style={pdfStyles.videoBadge}>VIDEO</Text> : null}
          </Link>
        );
      })}
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
export function PdfSectionHeader(props: { title: string; photoUrls: string[]; minPresenceAhead?: number }) {
  // minPresenceAhead reserves space AFTER this block on the page; if there isn't
  // enough room for the table that follows to start, the whole header (title +
  // photos) breaks to the next page WITH its table — instead of the title/photos
  // stranding at the bottom and the table flowing to the next page on its own.
  return (
    <View wrap={false} minPresenceAhead={props.minPresenceAhead ?? 90} style={{ marginTop: 8 }}>
      <Text style={pdfStyles.sectionTitle}>{props.title}</Text>
      <PdfSectionPhotos photoUrls={props.photoUrls} />
    </View>
  );
}

/**
 * Page-1 condensed summary table. Combines EVERY line item into ONE clean,
 * flat table — Room is its own column (shown once per room run), one row per
 * line item, no photos and no per-room subtotals, with a single grand-total
 * row at the bottom. Generic over the line type so Master / Vendor / Chargeback
 * (PdfLineRow) and QC (QcPdfLine) can all share it — each supplies its own
 * column set + widths.
 *
 * Column model: the Room column is prepended automatically (its value comes
 * from the group). The caller's columns render per-line cells; columns flagged
 * `hasTotal` (and any after the first such one) form the right-aligned totals
 * zone and carry a value on the grand-total row. Room + the descriptive
 * columns before the totals zone are merged into the "Grand Total" label cell.
 * The caller's column widths + `roomWidth` must sum to 100%.
 */
function parsePctWidth(w: string): number {
  const n = parseFloat(w);
  return isNaN(n) ? 0 : n;
}

export interface PdfSummaryColumn<T> {
  key: string;
  header: React.ReactNode;
  width: string;
  align?: 'left' | 'center' | 'right';
  /** Per-line cell content. */
  cell: (line: T) => React.ReactNode;
  /** Marks the first column of the right-aligned totals zone. */
  hasTotal?: boolean;
  /** Value shown in this column on the grand-total row. */
  grandTotal?: React.ReactNode;
  /** Render the value in brand (tenant) color. */
  brand?: boolean;
}

export function PdfSummaryTable<T>(props: {
  title: string;
  groups: { displayName: string; lines: T[] }[];
  columns: PdfSummaryColumn<T>[];
  /** Width of the prepended Room column (e.g. "12%"). */
  roomWidth: string;
  roomHeader?: string;
  grandTotalLabel?: string;
}) {
  const cols = props.columns;
  const firstTotalIdx = cols.findIndex((c) => c.hasTotal);
  const leadingCols = firstTotalIdx >= 0 ? cols.slice(0, firstTotalIdx) : cols;
  const totalCols = firstTotalIdx >= 0 ? cols.slice(firstTotalIdx) : [];
  // The "Grand Total" label spans the Room column + every descriptive column
  // before the totals zone, so the totals land under their own headers.
  const labelWidth = `${parsePctWidth(props.roomWidth) + leadingCols.reduce((s, c) => s + parsePctWidth(c.width), 0)}%`;
  const groups = props.groups.filter((g) => g.lines.length > 0);
  if (groups.length === 0) return null;

  // Dev guard: column widths + roomWidth must total ~100% or the grand-total
  // row (one merged label cell) drifts out from under the per-line columns.
  // Warn loudly in non-production instead of failing silently in a rendered PDF.
  if (process.env.NODE_ENV !== 'production') {
    const widthSum = parsePctWidth(props.roomWidth) + cols.reduce((s, c) => s + parsePctWidth(c.width), 0);
    if (Math.abs(widthSum - 100) > 0.5) {
      // eslint-disable-next-line no-console
      console.warn(`[PdfSummaryTable] "${props.title}" column widths sum to ${widthSum}%, not 100% — totals row will misalign.`);
    }
  }

  // Flatten to one row per line, tagging each with its room. The room name
  // shows on every row (so the room column reads top-to-bottom even across
  // page breaks).
  const rows: { room: string; line: T }[] = [];
  for (const g of groups) {
    for (const line of g.lines) rows.push({ room: g.displayName, line });
  }

  const lineCellStyle = (c: PdfSummaryColumn<T>) => {
    if (c.brand) return pdfStyles.tableCellTenant;
    if (c.align === 'right') return pdfStyles.tableCellNumeric;
    if (c.align === 'center') return pdfStyles.tableCellCentered;
    return pdfStyles.tableCell;
  };

  return (
    <View style={{ marginTop: 4, marginBottom: 4 }}>
      <Text style={pdfStyles.sectionTitle}>{props.title}</Text>

      {/* Column headers (Room first) */}
      <View style={pdfStyles.tableHeaderRow}>
        <Text style={[pdfStyles.tableHeaderCell, { width: props.roomWidth }]}>{props.roomHeader ?? 'Room'}</Text>
        {cols.map((c) => (
          <Text key={c.key} style={[pdfStyles.tableHeaderCell, { width: c.width, textAlign: c.align ?? 'left' }]}>
            {c.header}
          </Text>
        ))}
      </View>

      {/* One row per line item */}
      {rows.map((r, i) => (
        <View key={i} style={pdfStyles.summaryLineRow} wrap={false}>
          <Text style={[pdfStyles.summaryRoomCell, { width: props.roomWidth }]}>{r.room}</Text>
          {cols.map((c) => {
            const content = c.cell(r.line);
            // String/number cells render as Text; element cells (e.g. a colored
            // chip) render inside a View so we never nest a View/Image in a Text.
            if (typeof content === 'string' || typeof content === 'number') {
              return <Text key={c.key} style={[lineCellStyle(c), { width: c.width }]}>{content}</Text>;
            }
            const hAlign = c.align === 'right' ? 'flex-end' : c.align === 'center' ? 'center' : 'flex-start';
            return (
              <View key={c.key} style={{ width: c.width, flexDirection: 'row', justifyContent: hAlign, paddingHorizontal: 3 }}>
                {content}
              </View>
            );
          })}
        </View>
      ))}

      {/* Grand-total row */}
      {totalCols.length > 0 && (
        <View style={pdfStyles.summaryGrandRow} wrap={false}>
          <Text style={[pdfStyles.subtotalCell, { width: labelWidth, textAlign: 'right' }]}>
            {props.grandTotalLabel ?? 'Grand Total'}
          </Text>
          {totalCols.map((c) => (
            <Text key={c.key} style={[c.brand ? pdfStyles.subtotalCellTenant : pdfStyles.subtotalCell, { width: c.width, textAlign: c.align ?? 'right' }]}>
              {c.grandTotal ?? ' '}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

// ---- Money / number formatting ----

export function formatMoneyPdf(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatQtyPdf(n: number): string {
  // Thousands-separated (e.g. 1,800). Whole numbers show no decimals; otherwise
  // up to 2 decimal places.
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: Number.isInteger(n) ? 0 : 2,
  });
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
  // After photos (Internal Resolution proof-of-work). Rendered on the Internal
  // Resolution vendor PDF only; empty for all other lines.
  afterPhotoUrls?: string[];
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
  /** When the inspector submitted for approval (ISO). Drives the "Submitted" stamp. */
  submittedAtIso?: string | null;
  /** Approver's full name + when they approved (the finalize). Drives the
   *  "Approver: … Approved" line. */
  approverName?: string | null;
  approvedAtIso?: string | null;
  /** Listing snapshot for the header listing line (status · price · listed ·
   *  Move-In). Shown on every report EXCEPT Community and Turn Re-Inspect QC.
   *  moveInDate (the leasing deal's lease start) is only set on deposit-taken
   *  listings. */
  listingStatus?: string | null;
  listingPrice?: number | null;
  listingDate?: string | null;
  moveInDate?: string | null;
  sections: PdfSectionGroup[];
  grandTotals: { vendor: number; client: number; tenant: number; lineCount: number };
  /** Final Checklist Q&A — rendered on the MASTER pdf only. Each section is a
   *  group of label/value rows. Absent/empty on non-scope templates. */
  finalChecklist?: { name: string; rows: { label: string; value: string }[] }[];
  /** Final Checklist photos (label stickers etc.) — rendered under the block. */
  finalChecklistPhotos?: string[];
  /** Signed base URL for the in-app photo gallery (e.g.
   *  https://resiwalk.com/d/{id}/photos/{sig}). When set, PDF photos link here
   *  (browsable left/right) instead of the raw file. */
  photoGalleryBase?: string;
  /** Map of full-size photo (poster) URL → small embedded JPEG data URI. Built
   *  once per finalize (lib/pdfImages.buildEmbeddedPhotoMap) so the PDF embeds
   *  lightweight thumbnails instead of the stored ~1280px photos — keeps the file
   *  small and smooth to scroll. Absent entries fall back to the full URL. */
  embeddedPhotoByUrl?: Record<string, string>;
}
