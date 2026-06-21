// Server-side PDF generator (1099 / Q&A inspection templates) using
// @react-pdf/renderer. IMPORTANT: server-side only — never imported into browser.
//
// Layout (reworked to mirror the Scope Rate Card report):
//   Page 1  — pink header strip (logo + template + property + inspector/date),
//             a stats strip (Passed / Failed / Maintenance Ticket), and a
//             color-coded summary table of every question + its response.
//   Page 2+ — full detail: each section with its photos, notes, and per-question
//             responses.

import React from 'react';
import {
  Document, Page, Text, View, StyleSheet, Image, Link,
} from '@react-pdf/renderer';
import { isVideoEntry, getPosterUrl, getVideoUrl } from '@/lib/media';
import {
  PDF_COLORS, pdfStyles, PdfHeaderStrip, PdfFooter, isoToHumanDate, buildListingLine,
} from '@/lib/pdfShared';

const COLORS = {
  ...PDF_COLORS,
  amber: '#fef3c7',
  amberBorder: '#fcd34d',
  red: '#dc2626',
  redBg: '#fee2e2',
  greenBg: '#dcfce7',
};

const styles = StyleSheet.create({
  // ---- Stats strip (Passed / Failed / Maintenance Ticket) ----
  statsStrip: {
    flexDirection: 'row',
    // Center the callout cluster (Passed · Failed · Maintenance Ticket /
    // Community Score) across the full width of the sheet.
    justifyContent: 'center',
    backgroundColor: COLORS.grayBg,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: COLORS.grayLight,
    padding: 8,
    marginBottom: 10,
  },
  statItem: { flexDirection: 'column', alignItems: 'center', marginHorizontal: 22 },
  statLabel: {
    fontFamily: 'Helvetica', fontSize: 7, color: COLORS.gray,
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  statValue: { fontFamily: 'Helvetica-Bold', fontSize: 13, color: COLORS.ink, marginTop: 2 },

  // ---- Meta line (ID + HubSpot link) under the header ----
  metaLine: {
    flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8, gap: 3,
  },
  metaLineText: { fontSize: 7.5, color: COLORS.gray },
  metaLineLink: { fontSize: 7.5, color: COLORS.brand, textDecoration: 'underline' },

  // ---- Summary table ----
  sumHeaderRow: {
    flexDirection: 'row', backgroundColor: COLORS.grayBg,
    borderTopWidth: 0.5, borderBottomWidth: 0.5, borderColor: COLORS.grayLight,
    paddingVertical: 3,
  },
  sumHeaderCell: {
    fontFamily: 'Helvetica-Bold', fontSize: 6.5, color: COLORS.gray,
    paddingHorizontal: 4, textTransform: 'uppercase', letterSpacing: 0.3,
  },
  sumRow: {
    flexDirection: 'row', alignItems: 'center',
    borderBottomWidth: 0.5, borderBottomColor: COLORS.grayLight, paddingVertical: 3,
  },
  sumCellRoom: { fontFamily: 'Helvetica', fontSize: 7.5, color: COLORS.gray, paddingHorizontal: 4 },
  sumCellQ: { fontFamily: 'Helvetica', fontSize: 7.5, color: COLORS.ink, paddingHorizontal: 4 },
  // Color-coded response chip
  chip: {
    fontFamily: 'Helvetica-Bold', fontSize: 7, paddingVertical: 2, paddingHorizontal: 5,
    borderRadius: 3, textAlign: 'center',
  },

  // ---- Detail: section ----
  sectionHeader: {
    backgroundColor: COLORS.black, color: COLORS.white, padding: 8,
    marginTop: 10, fontSize: 11, fontFamily: 'Helvetica-Bold',
  },
  sectionContent: {
    border: `1px solid ${COLORS.grayLight}`, borderTop: 'none', padding: 8, marginBottom: 8,
  },
  qa: {
    paddingTop: 3, paddingBottom: 3, borderBottom: `0.5px solid ${COLORS.grayLight}`,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start',
  },
  qaLast: {
    paddingTop: 3, paddingBottom: 3,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start',
  },
  qaQuestion: { fontSize: 9, fontFamily: 'Helvetica-Bold', flex: 1, paddingRight: 8 },
  qaAnswer: { fontSize: 9, fontFamily: 'Helvetica-Bold', textAlign: 'right', maxWidth: '45%' },
  qaWithExtras: { paddingTop: 3, paddingBottom: 3, borderBottom: `0.5px solid ${COLORS.grayLight}` },
  qaWithExtrasLast: { paddingTop: 3, paddingBottom: 3 },
  qaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  // Note box: WHITE background with an amber border (no more yellow fill).
  noteBox: {
    backgroundColor: COLORS.white, border: `1px solid ${COLORS.amberBorder}`,
    padding: 6, marginTop: 4, borderRadius: 2,
  },
  noteText: { fontSize: 8.5, color: COLORS.ink, marginBottom: 3 },
  scoreText: { fontSize: 8, color: COLORS.gray, fontFamily: 'Helvetica-Bold' },
  // Photos
  photoGrid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 6 },
  photo: { width: 100, height: 75, margin: 2, objectFit: 'cover' },
  photoFill: { width: '100%', height: '100%', objectFit: 'cover' },
  // Compact link shown when an image couldn't be embedded (so we don't reserve a
  // blank fixed-size tile). Sized to the text, not a 100×75 box.
  photoLinkFallback: {
    fontSize: 8, color: COLORS.brand, marginTop: 4, marginRight: 10,
    textDecoration: 'underline',
  },
  videoBadge: {
    position: 'absolute', bottom: 2, left: 2, backgroundColor: 'rgba(0,0,0,0.65)',
    color: '#ffffff', fontSize: 6, paddingHorizontal: 3, paddingVertical: 1, borderRadius: 2,
  },
  sectionPhotosLabel: { fontSize: 9, color: COLORS.gray, fontFamily: 'Helvetica-Bold', marginBottom: 4 },
  sectionPhotosBlock: {
    backgroundColor: COLORS.grayBg, padding: 6, marginBottom: 6,
    borderBottom: `0.5px solid ${COLORS.grayLight}`,
  },
  detailHeading: {
    fontFamily: 'Helvetica-Bold', fontSize: 13, color: COLORS.ink, marginBottom: 2,
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
  /** Optional header meta (mirrors Scope): sqft + region. */
  squareFootage?: number | null;
  region?: string | null;
  /** Listing highlights for the header (mirrors the app header). */
  listingStatus?: string | null;
  listingPrice?: number | null;
  listingDate?: string | null;
  /** Tenant move-in (leasing deal lease start) — deposit-taken listings only. */
  moveInDate?: string | null;
  completedAt: string;
  totalAnswered: number;
  totalPhotos: number;
  triggeredCount: number;
  hubspotRecordId?: string;
  sectionsInOrder: string[];
  answersBySection: Record<string, PdfAnswer[]>;
  sectionPhotosBy: Record<string, string[]>;
  triggeredValues: Set<string>;
  /** poster URL → small embedded JPEG data URI. Photos render the embedded thumb
   *  (small file) but LINK to the original full-size URL so they're clickable in
   *  the PDF viewer, like the Scope report. */
  embeddedByUrl?: Record<string, string>;
  /** Signed base for the swipeable photo gallery (`/d/<id>/photos/<sig>`). When
   *  set, each photo links into the gallery (fit-to-screen + left/right) instead
   *  of opening the raw full-size image. Built per request from the origin. */
  photoGalleryBase?: string;
  /** Final Checklist (HVAC / Smart Home / Air Filters / Utilities) summarized to
   *  label/value rows — rendered the same way as the Master report. */
  finalChecklist?: { name: string; rows: { label: string; value: string }[] }[];
  /** Final Checklist photos (label stickers etc.), rendered under the block. */
  finalChecklistPhotos?: string[];
  /** Community/Visit inspection: name of the property's associated Community
   *  object (e.g. "Southport"). Appended to the doc title on community PDFs. */
  communityName?: string | null;
}

function formatDate(iso: string): string {
  try {
    const d = /^\d+$/.test(iso) ? new Date(Number(iso)) : new Date(iso);
    return d.toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

// Pass/fail tone of an answer value (mirrors components/QuestionItem.answerTone).
function toneOf(v: string | undefined): 'pass' | 'fail' | null {
  const n = (v || '').trim().toLowerCase();
  if (/\b(fail|failed|poor|deficient)\b/.test(n)) return 'fail';
  if (/\b(good|pass|passed|satisfactory)\b/.test(n)) return 'pass';
  return null;
}

const isMaintRequestQ = (q: string) => /submit a maintenance ticket/i.test(q || '');
const isMaintDescQ = (q: string) => /maintenance ticket description/i.test(q || '');
// The Final Checklist data is stored as a single JSON-blob answer (questionId
// "fc__all" / value "final_checklist"); it's rendered as its own Final Checklist
// block, NOT as a raw Q&A row.
const isFcBlob = (a: PdfAnswer) => /^final.?checklist$/i.test((a.answerValue || '').trim())
  || /^fc__/.test((a.questionText || '').trim());
// The Community/Visit inspection's overall score question ("Grade the Community",
// 1 = Poor … 10 = Excellent). Its answer is the headline "Community Score".
const isCommunityGradeQ = (q: string) => /grade the community/i.test(q || '');

// Clickable photo tiles: render the small embedded thumbnail but LINK each photo
// to the swipeable photo GALLERY (fit-to-screen, left/right across all the
// inspection's photos) — same behavior as the Scope report. Videos link to the
// playable file. Falls back to the raw file URL only when no gallery base is set.
function renderPhotos(entries: string[], embedded?: Record<string, string>, galleryBase?: string) {
  const sep = galleryBase && galleryBase.includes('?') ? '&' : '?';
  return entries.map((entry, i) => {
    const poster = getPosterUrl(entry);
    const data = embedded && embedded[poster];
    // resolveImagesInParallel returns a base64 data URI on success and falls back
    // to the ORIGINAL url on failure. A raw url here means the embed failed —
    // react-pdf can't reliably fetch it at render time either, so drawing an
    // <Image> would leave a blank, fixed-size 100×75 tile (the "large empty
    // space without photos"). When the embed failed, render a compact text link
    // to the photo instead of reserving that blank box.
    const embeddedOk = !!data && data.startsWith('data:');
    const video = isVideoEntry(entry) ? getVideoUrl(entry) : '';
    const fileHref = video || poster;
    // Photos → gallery (starts at this photo); videos → the playable file.
    const href = (galleryBase && !video) ? `${galleryBase}${sep}u=${encodeURIComponent(entry)}` : fileHref;
    if (!embeddedOk) {
      return (
        <Link key={`${entry}-${i}`} src={href} style={styles.photoLinkFallback}>
          <Text>{video ? 'View video ↗' : 'View photo ↗'}</Text>
        </Link>
      );
    }
    return (
      <Link key={`${entry}-${i}`} src={href} style={styles.photo}>
        {/* eslint-disable-next-line jsx-a11y/alt-text */}
        <Image src={data} style={styles.photoFill} />
        {video ? <Text style={styles.videoBadge}>VIDEO</Text> : null}
      </Link>
    );
  });
}

export function InspectionPdf({ data }: { data: PdfData }) {
  // Flatten all answers in section order for the summary table + counts.
  const flat: { room: string; q: string; value: string; tone: 'pass' | 'fail' | null }[] = [];
  let passCount = 0;
  let failCount = 0;
  let maintTicket: string | null = null;
  let communityGrade: string | null = null;
  for (const section of data.sectionsInOrder) {
    for (const a of (data.answersBySection[section] || [])) {
      // Capture the maintenance-ticket Yes/No for the stat strip, but DON'T drop
      // it — the question still belongs as a normal row in the summary table AND
      // in the Review / Sign-Off detail below (it was previously invisible there).
      if (isMaintRequestQ(a.questionText)) maintTicket = a.answerValue || null;
      if (isMaintDescQ(a.questionText) || isFcBlob(a)) continue; // not summary-grid rows
      if (isCommunityGradeQ(a.questionText) && a.answerValue) communityGrade = a.answerValue.trim();
      const tone = toneOf(a.answerValue);
      if (tone === 'pass') passCount++;
      else if (tone === 'fail') failCount++;
      if (a.answerValue && a.answerValue.trim()) flat.push({ room: section, q: a.questionText, value: a.answerValue, tone });
    }
  }
  const result: 'pass' | 'fail' | null = failCount > 0 ? 'fail' : passCount > 0 ? 'pass' : null;
  const resultText = result === 'fail' ? 'FAIL' : result === 'pass' ? 'PASS' : '—';
  const ticketYes = /^y/i.test(maintTicket || '');
  const isCommunity = /community/i.test(data.templateLabel || '');
  // Community Score = the "Grade the Community" answer (1–10 scale).
  const communityScore = communityGrade ? `${communityGrade} / 10` : '—';
  // Community PDF title row = "[Template] - [Community name]" (e.g.
  // "Community Visit Inspection - Southport") when the community is known.
  const docTitle = isCommunity && data.communityName
    ? `${data.templateLabel} - ${data.communityName}`
    : data.templateLabel;

  // Listing highlights line for the header (Status · Listing $X · Listed date ·
  // Move-In M/D/YY). Move-In only appears on deposit-taken listings.
  const listingLine = buildListingLine({
    listingStatus: data.listingStatus,
    listingPrice: data.listingPrice,
    listingDate: data.listingDate,
    moveInDate: data.moveInDate,
  });

  const chipStyle = (tone: 'pass' | 'fail' | null) => {
    if (tone === 'pass') return { ...styles.chip, backgroundColor: COLORS.greenBg, color: COLORS.emerald };
    if (tone === 'fail') return { ...styles.chip, backgroundColor: COLORS.redBg, color: COLORS.red };
    return { ...styles.chip, backgroundColor: COLORS.grayBg, color: COLORS.gray };
  };

  return (
    <Document
      title={data.inspectionName}
      author={data.inspectorName}
      subject={`Inspection: ${data.propertyAddress}`}
    >
      <Page size="LETTER" style={pdfStyles.page} wrap>
        {/* Brand header strip — mirrors the Scope report. RESULT (PASS/FAIL) on the right. */}
        <PdfHeaderStrip
          docTitle={docTitle}
          propertyName={data.propertyAddress}
          inspectorName={data.inspectorName}
          region={data.region ?? null}
          squareFootage={data.squareFootage ?? null}
          bedrooms={data.bedrooms}
          bathrooms={data.bathrooms}
          generatedAtLabel={isoToHumanDate(data.completedAt)}
          listingLine={isCommunity ? null : listingLine}
          detailsFirst
          inspectorTopRight
          summary={(
            <>
              <Text style={{ ...pdfStyles.headerRightLabel, marginTop: 5 }}>RESULT</Text>
              <Text style={pdfStyles.headerRightValue}>{resultText}</Text>
            </>
          )}
        />

        {/* ID + HubSpot link */}
        <View style={styles.metaLine}>
          <Text style={styles.metaLineText}>Inspection ID: {data.externalId}</Text>
          {data.hubspotRecordId && (
            <>
              <Text style={styles.metaLineText}>   ·   </Text>
              <Link
                src={`https://app.hubspot.com/contacts/${process.env.HUBSPOT_PORTAL_ID || '51415639'}/record/${process.env.HUBSPOT_INSPECTION_TYPE_ID || '2-63142762'}/${data.hubspotRecordId}`}
                style={styles.metaLineLink}
              >
                Open in HubSpot
              </Link>
            </>
          )}
        </View>

        {/* Stats strip. Community shows the score; 1099/vacancy show the
            maintenance-ticket status. Passed/Failed always shown. */}
        <View style={styles.statsStrip}>
          {isCommunity && (
            <View style={styles.statItem}>
              <Text style={styles.statLabel}>Community Score</Text>
              <Text style={{ ...styles.statValue, color: COLORS.emerald }}>{communityScore}</Text>
            </View>
          )}
          <View style={styles.statItem}>
            <Text style={styles.statLabel}>Passed</Text>
            <Text style={{ ...styles.statValue, color: COLORS.emerald }}>{passCount}</Text>
          </View>
          <View style={styles.statItem}>
            <Text style={styles.statLabel}>Failed</Text>
            <Text style={{ ...styles.statValue, color: failCount > 0 ? COLORS.brand : COLORS.ink }}>{failCount}</Text>
          </View>
          {!isCommunity && (
            <View style={styles.statItem}>
              <Text style={styles.statLabel}>Maintenance Ticket</Text>
              <Text style={{ ...styles.statValue, color: ticketYes ? COLORS.brand : COLORS.gray, fontSize: 11 }}>
                {maintTicket == null ? 'No' : ticketYes ? 'Yes — Created' : 'No'}
              </Text>
            </View>
          )}
        </View>

        {/* Summary table — every question + its response, color-coded */}
        <Text style={pdfStyles.sectionTitle}>Inspection Summary</Text>
        <View style={styles.sumHeaderRow}>
          <Text style={[styles.sumHeaderCell, { width: '28%' }]}>Section</Text>
          <Text style={[styles.sumHeaderCell, { width: '52%' }]}>Question</Text>
          <Text style={[styles.sumHeaderCell, { width: '20%', textAlign: 'center' }]}>Response</Text>
        </View>
        {flat.map((r, i) => (
          <View key={i} style={styles.sumRow} wrap={false}>
            <Text style={[styles.sumCellRoom, { width: '28%' }]}>{r.room}</Text>
            <Text style={[styles.sumCellQ, { width: '52%' }]}>{r.q}</Text>
            <View style={{ width: '20%', flexDirection: 'row', justifyContent: 'center', paddingHorizontal: 3 }}>
              <Text style={chipStyle(r.tone)}>{r.value}</Text>
            </View>
          </View>
        ))}

        {/* ---- DETAIL (page 2+) ---- */}
        <View break>
          <Text style={styles.detailHeading}>Full Detail</Text>
        </View>
        {data.sectionsInOrder.map((sectionName) => {
          const answers = (data.answersBySection[sectionName] || []).filter((a) => !isFcBlob(a));
          const sectionPhotos = data.sectionPhotosBy[sectionName] || [];
          if (answers.length === 0 && sectionPhotos.length === 0) return null;
          return (
            <View key={sectionName} wrap>
              <View wrap={false}>
                <View style={styles.sectionHeader}>
                  <Text>{sectionName}</Text>
                </View>
                {sectionPhotos.length > 0 && (
                  <View style={styles.sectionPhotosBlock}>
                    <Text style={styles.sectionPhotosLabel}>Section Photos</Text>
                    <View style={styles.photoGrid}>
                      {renderPhotos(sectionPhotos, data.embeddedByUrl, data.photoGalleryBase)}
                    </View>
                  </View>
                )}
              </View>
              <View style={styles.sectionContent}>
                {answers.map((a, idx) => {
                  const tone = toneOf(a.answerValue);
                  const isLast = idx === answers.length - 1;
                  const hasExtras = !!(a.note || a.quantity != null || a.assignedTo
                    || (a.photoUrls && a.photoUrls.length > 0));
                  const displayAnswer = a.answerValue && a.answerValue.trim() ? a.answerValue : '—';
                  const answerColor = tone === 'fail' ? COLORS.brand : tone === 'pass' ? COLORS.emerald : COLORS.gray;

                  if (!hasExtras) {
                    return (
                      <View key={idx} style={isLast ? styles.qaLast : styles.qa} wrap={false}>
                        <Text style={styles.qaQuestion}>{a.questionText}</Text>
                        <Text style={{ ...styles.qaAnswer, color: answerColor }}>{displayAnswer}</Text>
                      </View>
                    );
                  }
                  return (
                    <View key={idx} style={isLast ? styles.qaWithExtrasLast : styles.qaWithExtras} wrap={false}>
                      <View style={styles.qaRow}>
                        <Text style={styles.qaQuestion}>{a.questionText}</Text>
                        <Text style={{ ...styles.qaAnswer, color: answerColor }}>{displayAnswer}</Text>
                      </View>
                      {(a.note || (a.quantity != null) || a.assignedTo) && (
                        <View style={styles.noteBox}>
                          {a.note && <Text style={styles.noteText}>Note: {a.note}</Text>}
                          {a.assignedTo && <Text style={styles.scoreText}>Assigned to: {a.assignedTo}</Text>}
                          {a.quantity != null && <Text style={styles.scoreText}>Quantity: {a.quantity}</Text>}
                        </View>
                      )}
                      {a.photoUrls && a.photoUrls.length > 0 && (
                        <View style={styles.photoGrid}>
                          {renderPhotos(a.photoUrls, data.embeddedByUrl, data.photoGalleryBase)}
                        </View>
                      )}
                    </View>
                  );
                })}
              </View>
            </View>
          );
        })}

        {/* Final Checklist (HVAC / Smart Home / Air Filters / Utilities) — same
            label/value layout as the Master report. */}
        {data.finalChecklist && data.finalChecklist.length > 0 && (
          <View style={{ marginTop: 10 }}>
            <Text style={pdfStyles.sectionTitle}>Final Checklist</Text>
            {data.finalChecklist.map((g) => (
              <View key={g.name} style={{ marginBottom: 6 }} wrap={false}>
                <Text style={{ fontFamily: 'Helvetica-Bold', fontSize: 9, marginTop: 4, marginBottom: 2, color: '#374151' }}>{g.name}</Text>
                {g.rows.map((r, i) => (
                  <View key={i} style={{ flexDirection: 'row', paddingVertical: 1.5, borderBottomWidth: 0.5, borderBottomColor: '#eeeeee' }}>
                    <Text style={{ width: '42%', fontSize: 8.5, color: '#111111', paddingRight: 6 }}>{r.label}</Text>
                    <Text style={{ width: '58%', fontSize: 8.5, color: '#333333' }}>{r.value}</Text>
                  </View>
                ))}
              </View>
            ))}
            {data.finalChecklistPhotos && data.finalChecklistPhotos.length > 0 && (
              <View style={styles.photoGrid}>
                {renderPhotos(data.finalChecklistPhotos, data.embeddedByUrl, data.photoGalleryBase)}
              </View>
            )}
          </View>
        )}

        <PdfFooter docName={data.templateLabel} propertyName={data.propertyAddress} />
      </Page>
    </Document>
  );
}
