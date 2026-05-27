// Server-side PDF generator using @react-pdf/renderer.
// IMPORTANT: This file only runs server-side -- never imported into browser code.

import React from 'react';
import {
  Document, Page, Text, View, StyleSheet, Image, Font,
} from '@react-pdf/renderer';

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

// Register Raleway from Google Fonts for the PDF
// Wrapped in try/catch in case the network is offline during PDF generation
try {
  Font.register({
    family: 'Raleway',
    fonts: [
      { src: 'https://fonts.gstatic.com/s/raleway/v28/1Ptug8zYS_SKggPNyC0ITw.ttf', fontWeight: 400 },
      { src: 'https://fonts.gstatic.com/s/raleway/v28/1Ptrg8zYS_SKggPNyCg4TYFq.ttf', fontWeight: 600 },
      { src: 'https://fonts.gstatic.com/s/raleway/v28/1Ptrg8zYS_SKggPNyCMIT4ttDfA.ttf', fontWeight: 700 },
    ],
  });
} catch (e) {
  // Fallback to Helvetica if font registration fails
  console.warn('Raleway font registration failed; using built-in font.');
}

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
  // Summary
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
    paddingTop: 6,
    paddingBottom: 6,
    borderBottom: `0.5px solid ${COLORS.grayLight}`,
  },
  qaLast: {
    paddingTop: 6,
    paddingBottom: 6,
  },
  qaQuestion: {
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 2,
  },
  qaAnswer: {
    fontSize: 9,
    color: COLORS.brand,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 2,
  },
  qaAnswerPlain: {
    fontSize: 9,
    color: COLORS.gray,
    marginBottom: 2,
  },
  qaLocation: {
    fontSize: 8,
    color: COLORS.gray,
    fontStyle: 'italic',
    marginBottom: 2,
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
  // Grouped by section, preserving order
  sectionsInOrder: string[];
  answersBySection: Record<string, PdfAnswer[]>;
  sectionPhotosBy: Record<string, string[]>;
  // Triggered-only filter values
  triggeredValues: Set<string>;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
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

        {/* Summary */}
        <View style={styles.summaryBox}>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Property:</Text>
            <Text style={styles.summaryValue}>{data.propertyAddress}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Inspector:</Text>
            <Text style={styles.summaryValue}>{data.inspectorName}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Completed:</Text>
            <Text style={styles.summaryValue}>{formatDate(data.completedAt)}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Bedrooms / Bathrooms:</Text>
            <Text style={styles.summaryValue}>{data.bedrooms} BR / {data.bathrooms} BA</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Questions Answered:</Text>
            <Text style={styles.summaryValue}>{data.totalAnswered}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Action Items:</Text>
            <Text style={styles.summaryValue}>{data.triggeredCount}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Photos Attached:</Text>
            <Text style={styles.summaryValue}>{data.totalPhotos}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>External ID:</Text>
            <Text style={styles.summaryValue}>{data.externalId}</Text>
          </View>
        </View>

        {/* Sections */}
        {data.sectionsInOrder.map((sectionName) => {
          const answers = data.answersBySection[sectionName] || [];
          const sectionPhotos = data.sectionPhotosBy[sectionName] || [];
          return (
            <View key={sectionName} wrap break={false}>
              <View style={styles.sectionHeader}>
                <Text>{sectionName}</Text>
              </View>
              <View style={styles.sectionContent}>
                {/* Section photos FIRST (matches form order) */}
                {sectionPhotos.length > 0 && (
                  <View style={styles.sectionPhotosBlock}>
                    <Text style={styles.sectionPhotosLabel}>Section Photos</Text>
                    <View style={styles.photoGrid}>
                      {sectionPhotos.map((url, i) => (
                        // eslint-disable-next-line jsx-a11y/alt-text
                        <Image key={i} src={url} style={styles.photo} />
                      ))}
                    </View>
                  </View>
                )}
                {answers.map((a, idx) => {
                  const isTriggered = data.triggeredValues.has(a.answerValue);
                  const isLast = idx === answers.length - 1;
                  return (
                    <View key={idx} style={isLast ? styles.qaLast : styles.qa} wrap={false}>
                      <Text style={styles.qaQuestion}>{a.questionText}</Text>
                      {a.location && <Text style={styles.qaLocation}>Location: {a.location}</Text>}
                      <Text style={isTriggered ? styles.qaAnswer : styles.qaAnswerPlain}>
                        {a.answerValue}
                      </Text>
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
                          {a.photoUrls.map((url, i) => (
                            // eslint-disable-next-line jsx-a11y/alt-text
                            <Image key={i} src={url} style={styles.photo} />
                          ))}
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
