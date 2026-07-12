/**
 * ResiWalk - Services — completion PDF (react-pdf), styled to MIRROR the inspection
 * report: shared pink header strip (PdfHeaderStrip) + footer (PdfFooter), black
 * section header bands, question/answer rows with the value on the right, and
 * 100×75 photo tiles in rows (clickable into the hosted gallery). Server-side only.
 */
import React from 'react';
import { Document, Page, Text, View, StyleSheet, Image, Link } from '@react-pdf/renderer';
import { PDF_COLORS, pdfStyles, PdfHeaderStrip, PdfFooter } from '@/lib/pdfShared';

export interface ServicePdfData {
  address: string; locality: string;
  worktype: string; subtype: string; scope: string; vendor: string; status: string;
  dueDate: string; submittedAt: string; completedAt: string;   // YYYY-MM-DD
  vendorCost: string; markupPct: string; clientCost: string;   // pre-formatted ($ / %)
  adjustment: string; adjustmentReason: string;
  aiVerdict: string; aiNotes: string;
  reviewDecision: string; reviewNotes: string; reviewedBy: string;
  answers: { label: string; value: string }[];
  before: string[]; after: string[]; petBefore: string[]; petAfter: string[];  // data URIs
  galleryBase: string;
  isInternal: boolean;   // controls whether the AI-review block is included
}

const C = PDF_COLORS;
const PHOTOS_PER_ROW = 5;
const s = StyleSheet.create({
  sectionHeader: { backgroundColor: C.black, color: C.white, padding: 8, marginTop: 10, fontSize: 11, fontFamily: 'Helvetica-Bold' },
  sectionContent: { border: `1px solid ${C.grayLight}`, borderTop: 'none', padding: 8, marginBottom: 2 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingTop: 3, paddingBottom: 3, borderBottom: `0.5px solid ${C.grayLight}` },
  rowLast: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingTop: 3, paddingBottom: 3 },
  q: { fontSize: 9, fontFamily: 'Helvetica-Bold', flex: 1, paddingRight: 8, color: C.ink },
  a: { fontSize: 9, fontFamily: 'Helvetica-Bold', textAlign: 'right', maxWidth: '55%', color: C.ink },
  label: { fontSize: 9, flex: 1, paddingRight: 8, color: C.gray },
  photosLabel: { fontSize: 9, color: C.gray, fontFamily: 'Helvetica-Bold', marginTop: 6, marginBottom: 4 },
  photoGrid: { marginBottom: 2 },
  photoRow: { flexDirection: 'row' },
  photo: { width: 100, height: 75, margin: 2, objectFit: 'cover' },
  photoFill: { width: '100%', height: '100%', objectFit: 'cover' },
  note: { fontSize: 8.5, color: C.ink, lineHeight: 1.4 },
  noteBox: { backgroundColor: C.white, border: `1px solid ${C.grayLight}`, padding: 6, marginTop: 4, borderRadius: 2 },
});

// App-wide M-D-YY.
const humanDate = (iso: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${Number(m[2])}-${Number(m[3])}-${m[1].slice(2)}` : (iso || '');
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View wrap={false}>
      <Text style={s.sectionHeader}>{title}</Text>
      <View style={s.sectionContent}>{children}</View>
    </View>
  );
}

function DetailRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <View style={last ? s.rowLast : s.row}>
      <Text style={s.label}>{label}</Text>
      <Text style={s.a}>{value}</Text>
    </View>
  );
}

function PhotoBlock({ title, urls, group, galleryBase }: { title: string; urls: string[]; group: string; galleryBase: string }) {
  if (!urls.length) return null;
  const rows: string[][] = [];
  for (let i = 0; i < urls.length; i += PHOTOS_PER_ROW) rows.push(urls.slice(i, i + PHOTOS_PER_ROW));
  return (
    <View wrap={false}>
      <Text style={s.photosLabel}>{title}</Text>
      <View style={s.photoGrid}>
        {rows.map((row, ri) => (
          <View key={ri} style={s.photoRow}>
            {row.map((u, i) => {
              const idx = ri * PHOTOS_PER_ROW + i;
              return galleryBase
                ? <Link key={i} src={`${galleryBase}?g=${group}&i=${idx}`} style={s.photo}><Image src={u} style={s.photoFill} /></Link>
                : <Image key={i} src={u} style={s.photo} />;
            })}
          </View>
        ))}
      </View>
    </View>
  );
}

export function ServicePdf({ d }: { d: ServicePdfData }) {
  const anyPhotos = d.before.length || d.after.length || d.petBefore.length || d.petAfter.length;
  return (
    <Document>
      <Page size="LETTER" style={pdfStyles.page} wrap>
        <PdfHeaderStrip
          docTitle={`${d.worktype} · ${d.subtype}`}
          propertyName={`${d.address}${d.locality ? `, ${d.locality}` : ''}`}
          inspectorName={d.vendor || 'Unassigned'}
          region={null}
          squareFootage={null}
          bedrooms={0}
          bathrooms={0}
          propertyStatus={d.scope}
          generatedAtLabel={d.dueDate ? `Due ${humanDate(d.dueDate)}` : ''}
          inspectorTopRight
          summary={(
            <>
              <Text style={{ ...pdfStyles.headerRightLabel, marginTop: 5 }}>STATUS</Text>
              <Text style={pdfStyles.headerRightValue}>{(d.status || '').toUpperCase()}</Text>
            </>
          )}
        />

        <Section title="Work Order">
          <DetailRow label="Vendor" value={d.vendor || '—'} />
          {!!d.dueDate && <DetailRow label="Due" value={humanDate(d.dueDate)} />}
          {!!d.submittedAt && <DetailRow label="Submitted" value={humanDate(d.submittedAt)} />}
          {!!d.completedAt && <DetailRow label="Completed" value={humanDate(d.completedAt)} />}
          <DetailRow label="Vendor cost" value={d.vendorCost || '—'} />
          {!!d.markupPct && <DetailRow label="Markup" value={`${d.markupPct}%`} />}
          <DetailRow label="Client cost" value={d.clientCost || '—'} last={!d.adjustment} />
          {!!d.adjustment && <DetailRow label="Payout adjustment" value={`−${d.adjustment}${d.adjustmentReason ? ` (${d.adjustmentReason})` : ''}`} last />}
        </Section>

        {d.answers.length > 0 && (
          <Section title="Completion Answers">
            {d.answers.map((a, i) => (
              <View key={i} style={i === d.answers.length - 1 ? s.rowLast : s.row}>
                <Text style={s.q}>{a.label}</Text>
                <Text style={s.a}>{a.value}</Text>
              </View>
            ))}
          </Section>
        )}

        {!!anyPhotos && (
          <Section title="Photos">
            <PhotoBlock title="Before photos" urls={d.before} group="before" galleryBase={d.galleryBase} />
            <PhotoBlock title="After photos" urls={d.after} group="after" galleryBase={d.galleryBase} />
            <PhotoBlock title="Pet station — before" urls={d.petBefore} group="petBefore" galleryBase={d.galleryBase} />
            <PhotoBlock title="Pet station — after" urls={d.petAfter} group="petAfter" galleryBase={d.galleryBase} />
          </Section>
        )}

        {d.isInternal && (d.aiVerdict || d.aiNotes) && (
          <Section title={`AI Review${d.aiVerdict ? ` — ${d.aiVerdict === 'clean' ? 'Clean' : 'Needs review'}` : ''}`}>
            {!!d.aiNotes && <Text style={s.note}>{d.aiNotes}</Text>}
          </Section>
        )}

        {!!d.reviewDecision && (
          <Section title={`Review — ${d.reviewDecision === 'approve' ? 'Approved' : 'Rejected'}${d.reviewedBy ? ` · ${d.reviewedBy}` : ''}`}>
            {!!d.reviewNotes && <View style={s.noteBox}><Text style={s.note}>{d.reviewNotes}</Text></View>}
          </Section>
        )}

        <PdfFooter docName={`${d.worktype} · ${d.subtype}`} propertyName={`${d.address}${d.locality ? `, ${d.locality}` : ''}`} />
      </Page>
    </Document>
  );
}
