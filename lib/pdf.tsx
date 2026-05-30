// Server-side PDF generator using @react-pdf/renderer.
// IMPORTANT: This file only runs server-side -- never imported into browser code.

import React from 'react';
import {
  Document, Page, Text, View, StyleSheet, Image, Link,
} from '@react-pdf/renderer';
import { isVideoEntry, getPosterUrl, getVideoUrl } from '@/lib/media';

// Brand colors from ResiHome brand guidelines
const COLORS = {
  brand: '#ff0060',
  brandDark: '#cc004d',
  accent: '#73e3df',
  black: '#000000',
  ink: '#1a1a1a',
  gray: '#6b7280',
  grayLight: '#e5e7eb',
  grayBg: '#f9fafb',
  amber: '#fef3c7',
  amberBorder: '#fcd34d',
  white: '#ffffff',
};

// We previously tried to register Raleway from Google Fonts here, but the
// runtime fetch failed in Vercel's serverless lambda with "Unknown font
// format". Using bundled Helvetica/Helvetica-Bold avoids any network call.
// (No-op kept as documentation of the prior attempt.)

const styles = StyleSheet.create({
  page: {
    fontFamily: 'Helvetica',
    fontSize: 9,
    paddingTop: 40,
    paddingBottom: 50,
    paddingLeft: 40,
    paddingRight: 40,
    color: COLORS.ink,
  },
  // Header
  header: {
    backgroundColor: COLORS.brand,
    color: COLORS.white,
    padding: 16,
    marginBottom: 18,
    marginTop: -40,
    marginLeft: -40,
    marginRight: -40,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: 700,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.white,
    marginBottom: 4,
  },
  headerSubtitle: {
    fontSize: 11,
    color: COLORS.white,
    opacity: 0.9,
  },
  // Metadata block (the opening summary).
  // Designed to read as professional, not flashy: white card with a hot-pink
  // accent bar on the left, generous whitespace, small uppercase labels above
  // each value, two-column grid for compactness.
  metaCard: {
    flexDirection: 'row',
    backgroundColor: COLORS.white,
    border: `1px solid ${COLORS.grayLight}`,
    borderRadius: 4,
    marginBottom: 22,
    overflow: 'hidden',
  },
  metaAccent: {
    width: 4,
    backgroundColor: COLORS.brand,
  },
  metaBody: {
    flex: 1,
    padding: 16,
  },
  metaRowDouble: {
    flexDirection: 'row',
    marginBottom: 12,
  },
  metaCol: {
    flex: 1,
    paddingRight: 12,
  },
  metaLabel: {
    fontSize: 7,
    color: COLORS.gray,
    fontFamily: 'Helvetica-Bold',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 3,
  },
  metaValue: {
    fontSize: 11,
    color: COLORS.ink,
    fontFamily: 'Helvetica-Bold',
  },
  metaValueSmall: {
    fontSize: 9,
    color: COLORS.ink,
  },
  metaValueLink: {
    fontSize: 9,
    color: COLORS.brand,
    textDecoration: 'underline',
  },
  // (Legacy summary styles kept for backwards-compat in case anything still references them)
  summaryBox: {
    backgroundColor: COLORS.grayBg,
    border: `1px solid ${COLORS.grayLight}`,
    padding: 12,
    marginBottom: 18,
    borderRadius: 4,
  },
  summaryRow: {
    flexDirection: 'row',
    marginBottom: 4,
    fontSize: 9,
  },
  summaryLabel: {
    width: 130,
    color: COLORS.gray,
    fontFamily: 'Helvetica-Bold',
  },
  summaryValue: {
    flex: 1,
    color: COLORS.ink,
  },
  // Section
  sectionHeader: {
    backgroundColor: COLORS.black,
    color: COLORS.white,
    padding: 8,
    marginBottom: 0,
    marginTop: 10,
    fontSize: 11,
    fontFamily: 'Helvetica-Bold',
  },
  sectionContent: {
    border: `1px solid ${COLORS.grayLight}`,
    borderTop: 'none',
    padding: 8,
    marginBottom: 8,
  },
  // Question/Answer row
  qa: {
    paddingTop: 3,
    paddingBottom: 3,
    borderBottom: `0.5px solid ${COLORS.grayLight}`,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  qaLast: {
    paddingTop: 3,
    paddingBottom: 3,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  qaQuestion: {
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    flex: 1,
    paddingRight: 8,
  },
  qaAnswer: {
    fontSize: 9,
    color: COLORS.brand,
    fontFamily: 'Helvetica-Bold',
    textAlign: 'right',
    maxWidth: '45%',
  },
  qaAnswerPlain: {
    fontSize: 9,
    color: COLORS.gray,
    textAlign: 'right',
    maxWidth: '45%',
  },
  // Container for a question+answer that has follow-on content (action box, photos).
  // The action box and photos appear below the row, full width.
  qaWithExtras: {
    paddingTop: 3,
    paddingBottom: 3,
    borderBottom: `0.5px solid ${COLORS.grayLight}`,
  },
  qaWithExtrasLast: {
    paddingTop: 3,
    paddingBottom: 3,
  },
  qaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  // Triggered (action) box
  triggeredBox: {
    backgroundColor: COLORS.amber,
    border: `1px solid ${COLORS.amberBorder}`,
    padding: 6,
    marginTop: 4,
    borderRadius: 2,
  },
  noteText: {
    fontSize: 8.5,
    color: COLORS.ink,
    marginBottom: 3,
  },
  scoreText: {
    fontSize: 8,
    color: COLORS.gray,
    fontFamily: 'Helvetica-Bold',
  },
  // Photos
  photoGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 6,
  },
  photo: {
    width: 100,
    height: 75,
    margin: 2,
    objectFit: 'cover',
  },
  photoFill: {
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
  sectionPhotosLabel: {
    fontSize: 9,
    color: COLORS.gray,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 4,
  },
  sectionPhotosBlock: {
    backgroundColor: COLORS.grayBg,
    padding: 6,
    marginBottom: 6,
    borderBottom: `0.5px solid ${COLORS.grayLight}`,
  },
  // Footer
  footer: {
    position: 'absolute',
    bottom: 20,
    left: 40,
    right: 40,
    fontSize: 7,
    color: COLORS.gray,
    textAlign: 'center',
    borderTop: `0.5px solid ${COLORS.grayLight}`,
    paddingTop: 6,
  },
  pageNumber: {
    position: 'absolute',
    bottom: 20,
    right: 40,
    fontSize: 7,
    color: COLORS.gray,
  },
});

export interface PdfAnswer {
  questionText: string;
  section: string;
  location?: string;
  answerValue: string;
  note?: string;
  quantity?: number | null;
  assignedTo?: string;
  photoUrls?: string[];
}

export interface PdfData {
  inspectionName: string;
  externalId: string;
  templateLabel: string;
  propertyAddress: string;
  inspectorName: string;
  bedrooms: number;
  bathrooms: number;
  completedAt: string;
  totalAnswered: number;
  totalPhotos: number;
  triggeredCount: number;
  // The HubSpot record ID (used to build the clickable record URL in the metadata block)
  hubspotRecordId?: string;
  // Grouped by section, preserving order
  sectionsInOrder: string[];
  answersBySection: Record<string, PdfAnswer[]>;
  sectionPhotosBy: Record<string, string[]>;
  // Triggered-only filter values
  triggeredValues: Set<string>;
}

function formatDate(iso: string): string {
  try {
    // HubSpot Date fields are epoch-ms strings; coerce to Number first.
    const d = /^\d+$/.test(iso) ? new Date(Number(iso)) : new Date(iso);
    return d.toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export function InspectionPdf({ data }: { data: PdfData }) {
  return (
    <Document
      title={data.inspectionName}
      author={data.inspectorName}
      subject={`Inspection: ${data.propertyAddress}`}
    >
      <Page size="LETTER" style={styles.page} wrap>
        {/* Brand header (hot pink) */}
        <View style={styles.header} fixed={false}>
          <Text style={styles.headerTitle}>RESIHOME</Text>
          <Text style={styles.headerSubtitle}>{data.templateLabel}</Text>
        </View>

        {/* Metadata card */}
        <View style={styles.metaCard}>
          <View style={styles.metaAccent} />
          <View style={styles.metaBody}>
            {/* Row 1: Property (full width) */}
            <View style={{ marginBottom: 12 }}>
              <Text style={styles.metaLabel}>Property</Text>
              <Text style={styles.metaValue}>{data.propertyAddress}</Text>
            </View>

            {/* Row 2: Inspector + Date */}
            <View style={styles.metaRowDouble}>
              <View style={styles.metaCol}>
                <Text style={styles.metaLabel}>Inspector</Text>
                <Text style={styles.metaValueSmall}>{data.inspectorName}</Text>
              </View>
              <View style={styles.metaCol}>
                <Text style={styles.metaLabel}>Date</Text>
                <Text style={styles.metaValueSmall}>{formatDate(data.completedAt)}</Text>
              </View>
            </View>

            {/* Row 3: ID + HubSpot URL */}
            <View style={{ ...styles.metaRowDouble, marginBottom: 0 }}>
              <View style={styles.metaCol}>
                <Text style={styles.metaLabel}>Inspection ID</Text>
                <Text style={styles.metaValueSmall}>{data.externalId}</Text>
              </View>
              {data.hubspotRecordId && (
                <View style={styles.metaCol}>
                  <Text style={styles.metaLabel}>HubSpot Record</Text>
                  <Link
                    src={`https://app.hubspot.com/contacts/51415639/record/${process.env.HUBSPOT_INSPECTION_TYPE_ID || '2-63142762'}/${data.hubspotRecordId}`}
                    style={styles.metaValueLink}
                  >
                    Open in HubSpot
                  </Link>
                </View>
              )}
            </View>
          </View>
        </View>

        {/* Sections */}
        {data.sectionsInOrder.map((sectionName) => {
          const answers = data.answersBySection[sectionName] || [];
          const sectionPhotos = data.sectionPhotosBy[sectionName] || [];
          return (
            <View key={sectionName} wrap>
              {/*
                Section title + section photos render as ONE non-splittable
                block (wrap={false}). Without this, react-pdf can place the
                title near the bottom of a page and let the photo grid spill
                past the page boundary into the fixed footer (the overhang bug).
                Keeping them together forces the whole block to the next page
                when it doesn't fit. The Q&A rows below still wrap normally.
                Mirrors PdfSectionHeader in lib/pdfShared.tsx.
              */}
              <View wrap={false}>
                <View style={styles.sectionHeader}>
                  <Text>{sectionName}</Text>
                </View>
                {/* Section photos FIRST (matches form order) */}
                {sectionPhotos.length > 0 && (
                  <View style={styles.sectionPhotosBlock}>
                    <Text style={styles.sectionPhotosLabel}>Section Photos</Text>
                    <View style={styles.photoGrid}>
                      {sectionPhotos.map((entry, i) => {
                        const poster = getPosterUrl(entry);
                        if (!isVideoEntry(entry)) {
                          // eslint-disable-next-line jsx-a11y/alt-text
                          return <Image key={i} src={poster} style={styles.photo} />;
                        }
                        return (
                          <Link key={i} src={getVideoUrl(entry)} style={styles.photo}>
                            {/* eslint-disable-next-line jsx-a11y/alt-text */}
                            <Image src={poster} style={styles.photoFill} />
                            <Text style={styles.videoBadge}>VIDEO</Text>
                          </Link>
                        );
                      })}
                    </View>
                  </View>
                )}
              </View>
              <View style={styles.sectionContent}>
                {answers.map((a, idx) => {
                  const isTriggered = data.triggeredValues.has(a.answerValue);
                  const isLast = idx === answers.length - 1;
                  const hasExtras = !!(a.note || a.quantity != null || a.assignedTo
                    || (a.photoUrls && a.photoUrls.length > 0));
                  const displayAnswer = a.answerValue && a.answerValue.trim() ? a.answerValue : '—';

                  // Simple two-column row (no action box, no photos): question
                  // on the left, answer on the right.
                  if (!hasExtras) {
                    return (
                      <View key={idx} style={isLast ? styles.qaLast : styles.qa} wrap={false}>
                        <Text style={styles.qaQuestion}>{a.questionText}</Text>
                        <Text style={isTriggered ? styles.qaAnswer : styles.qaAnswerPlain}>
                          {displayAnswer}
                        </Text>
                      </View>
                    );
                  }

                  // Row with extras: question/answer in top row, action box and
                  // photos below at full width.
                  return (
                    <View key={idx} style={isLast ? styles.qaWithExtrasLast : styles.qaWithExtras} wrap={false}>
                      <View style={styles.qaRow}>
                        <Text style={styles.qaQuestion}>{a.questionText}</Text>
                        <Text style={isTriggered ? styles.qaAnswer : styles.qaAnswerPlain}>
                          {displayAnswer}
                        </Text>
                      </View>
                      {(a.note || (a.quantity != null) || a.assignedTo) && (
                        <View style={styles.triggeredBox}>
                          {a.note && <Text style={styles.noteText}>Note: {a.note}</Text>}
                          {a.assignedTo && (
                            <Text style={styles.scoreText}>Assigned to: {a.assignedTo}</Text>
                          )}
                          {a.quantity != null && (
                            <Text style={styles.scoreText}>Quantity: {a.quantity}</Text>
                          )}
                        </View>
                      )}
                      {a.photoUrls && a.photoUrls.length > 0 && (
                        <View style={styles.photoGrid}>
                          {a.photoUrls.map((entry, i) => {
                            const poster = getPosterUrl(entry);
                            if (!isVideoEntry(entry)) {
                              // eslint-disable-next-line jsx-a11y/alt-text
                              return <Image key={i} src={poster} style={styles.photo} />;
                            }
                            return (
                              <Link key={i} src={getVideoUrl(entry)} style={styles.photo}>
                                {/* eslint-disable-next-line jsx-a11y/alt-text */}
                                <Image src={poster} style={styles.photoFill} />
                                <Text style={styles.videoBadge}>VIDEO</Text>
                              </Link>
                            );
                          })}
                        </View>
                      )}
                    </View>
                  );
                })}
              </View>
            </View>
          );
        })}

        <Text
          style={styles.footer}
          fixed
          render={({ pageNumber, totalPages }) => (
            `ResiHome Inspection - ${data.inspectionName} - Page ${pageNumber} of ${totalPages}`
          )}
        />
      </Page>
    </Document>
  );
}
