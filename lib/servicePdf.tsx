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
  // Bid items that originated from THIS completion (so the PDF shows their origin).
  bids: { description: string; cost: string; status: string; photos: string[] }[];
  galleryBase: string;
  isInternal: boolean;
  // 'vendor' → shows the Vendor Cost (given to the vendor); 'client' → shows the
  // Client Cost (billed to the client). Neither shows internal AI QC notes.
  variant: 'vendor' | 'client';
}

// react-pdf's built-in Helvetica lacks some glyphs (≤ ≥ smart quotes) — they render
// as blanks/tofu (the "Standard (≤ 6")" cut-off look). Map them to ASCII.
const pdfSafe = (s: string): string => String(s || '')
  .replace(/≤/g, '<=').replace(/≥/g, '>=').replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/—/g, '-').replace(/·/g, '-');

const C = PDF_COLORS;
const PHOTOS_PER_ROW = 5;
const s = StyleSheet.create({
  // Summary tiles (mirrors the inspection report's stats strip).
  statsStrip: { flexDirection: 'row', justifyContent: 'center', backgroundColor: C.grayBg, borderTop: `1px solid ${C.grayLight}`, borderBottom: `1px solid ${C.grayLight}`, padding: 6, marginTop: 8 },
  statItem: { flexDirection: 'column', alignItems: 'center', marginHorizontal: 22 },
  statLabel: { fontSize: 7, fontFamily: 'Helvetica', color: C.gray, textTransform: 'uppercase', letterSpacing: 0.5 },
  statValue: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: C.ink, marginTop: 2 },
  sectionHeader: { backgroundColor: C.sectionHeaderBg, color: C.ink, padding: 6, marginTop: 8, fontSize: 10, fontFamily: 'Helvetica-Bold', borderBottomWidth: 2, borderBottomColor: C.brand },
  sectionContent: { border: `1px solid ${C.grayLight}`, borderTop: 'none', padding: 6, marginBottom: 2 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingTop: 2, paddingBottom: 2, borderBottom: `0.5px solid ${C.grayLight}` },
  rowLast: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingTop: 2, paddingBottom: 2 },
  // Questions + answers are plain weight (not bold) per request.
  q: { fontSize: 9, fontFamily: 'Helvetica', flex: 1, paddingRight: 8, color: C.ink },
  a: { fontSize: 9, fontFamily: 'Helvetica', textAlign: 'right', flexShrink: 1, maxWidth: '60%', color: C.ink },
  photosLabel: { fontSize: 9, color: C.gray, fontFamily: 'Helvetica-Bold', marginTop: 4, marginBottom: 3 },
  photoGrid: { marginBottom: 2 },
  photoRow: { flexDirection: 'row' },
  photo: { width: 92, height: 69, margin: 1.5, objectFit: 'cover' },
  photoFill: { width: '100%', height: '100%', objectFit: 'cover' },
  note: { fontSize: 8.5, color: C.ink, lineHeight: 1.4 },
  noteBox: { backgroundColor: C.white, border: `1px solid ${C.grayLight}`, padding: 6, marginTop: 4, borderRadius: 2 },
});

// App-wide M-D-YY.
const humanDate = (iso: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${Number(m[2])}-${Number(m[3])}-${m[1].slice(2)}` : (iso || '');
};

function Section({ title, children, breakable }: { title: string; children: React.ReactNode; breakable?: boolean }) {
  // Non-photo sections stay together (wrap=false); photo sections are breakable so
  // rows paginate cleanly instead of overflowing a page.
  return (
    <View wrap={breakable ? true : false}>
      <Text style={s.sectionHeader}>{title}</Text>
      <View style={s.sectionContent}>{children}</View>
    </View>
  );
}

// Consistent row across sections: bold question/label left, bold value right.
function Row({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <View style={last ? s.rowLast : s.row}>
      <Text style={s.q}>{pdfSafe(label)}</Text>
      <Text style={s.a}>{pdfSafe(value)}</Text>
    </View>
  );
}

function PhotoBlock({ title, urls, group, galleryBase }: { title: string; urls: string[]; group: string; galleryBase: string }) {
  if (!urls.length) return null;
  const rows: string[][] = [];
  for (let i = 0; i < urls.length; i += PHOTOS_PER_ROW) rows.push(urls.slice(i, i + PHOTOS_PER_ROW));
  // NOT wrap={false} on the whole block (a big group would overflow a page). Each
  // ROW is wrap={false} so rows break cleanly between pages — no run-off / scrunch.
  return (
    <View>
      <Text style={s.photosLabel}>{title}</Text>
      <View style={s.photoGrid}>
        {rows.map((row, ri) => (
          // minPresenceAhead reserves a full photo-row height (69 + 3 margin)
          // ahead, so wrap={false} breaks to the next page rather than letting a
          // row render half-over the fixed footer.
          <View key={ri} style={s.photoRow} wrap={false} minPresenceAhead={74}>
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
  const copyLabel = d.variant === 'client' ? 'Client Copy' : 'Vendor Copy';
  return (
    <Document>
      <Page size="LETTER" style={pdfStyles.page} wrap>
        <PdfHeaderStrip
          docTitle={`${d.worktype} · ${d.subtype} — ${copyLabel}`}
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

        {/* Summary tiles — Due · Submitted · Cost (mirrors the inspection stats strip). */}
        {(() => {
          const tiles: { label: string; value: string }[] = [];
          if (d.dueDate) tiles.push({ label: 'Due Date', value: humanDate(d.dueDate) });
          if (d.submittedAt) tiles.push({ label: 'Submitted', value: humanDate(d.submittedAt) });
          else if (d.completedAt) tiles.push({ label: 'Completed', value: humanDate(d.completedAt) });
          const costVal = d.variant === 'client' ? d.clientCost : d.vendorCost;
          if (costVal) tiles.push({ label: d.variant === 'client' ? 'Client Cost' : 'Vendor Cost', value: costVal });
          return tiles.length ? (
            <View style={s.statsStrip} wrap={false}>
              {tiles.map((t, i) => (
                <View key={i} style={s.statItem}>
                  <Text style={s.statLabel}>{t.label}</Text>
                  <Text style={s.statValue}>{pdfSafe(t.value)}</Text>
                </View>
              ))}
            </View>
          ) : null;
        })()}

        {(() => {
          // Vendor + Due / Submitted / Cost are all in the header + summary tiles
          // above, so the Work Order section carries only the extras: completion
          // date and any payout adjustment. Markup % is internal — never shown on
          // the client PDF (it only exposes our margin). Hidden when empty.
          const rows: { label: string; value: string }[] = [];
          if (d.completedAt) rows.push({ label: 'Completed', value: humanDate(d.completedAt) });
          if (d.variant !== 'client' && d.adjustment) rows.push({ label: 'Payout adjustment', value: `-${d.adjustment}${d.adjustmentReason ? ` (${d.adjustmentReason})` : ''}` });
          return rows.length ? (
            <Section title="Work Order">
              {rows.map((r, i) => <Row key={i} label={r.label} value={r.value} last={i === rows.length - 1} />)}
            </Section>
          ) : null;
        })()}

        {d.answers.length > 0 && (
          <Section title="Completion Answers">
            {d.answers.map((a, i) => <Row key={i} label={a.label} value={a.value} last={i === d.answers.length - 1} />)}
          </Section>
        )}

        {!!anyPhotos && (
          <Section title="Photos" breakable>
            <PhotoBlock title="Before photos" urls={d.before} group="before" galleryBase={d.galleryBase} />
            <PhotoBlock title="After photos" urls={d.after} group="after" galleryBase={d.galleryBase} />
            <PhotoBlock title="Pet station - before" urls={d.petBefore} group="petBefore" galleryBase={d.galleryBase} />
            <PhotoBlock title="Pet station - after" urls={d.petAfter} group="petAfter" galleryBase={d.galleryBase} />
          </Section>
        )}

        {/* Bid item(s) that originated from this completion — shows their origin. */}
        {d.bids.map((b, i) => (
          <Section key={i} title={`Bid Item Requested${b.status ? ` — ${b.status}` : ''}`} breakable>
            {!!b.description && <Row label="Additional work" value={b.description} />}
            <Row label="Bid (vendor cost)" value={b.cost || '-'} last />
            {b.photos.length > 0 && <PhotoBlock title="Bid photos" urls={b.photos} group="" galleryBase="" />}
          </Section>
        ))}

        {!!d.reviewDecision && (
          <Section title={`Review — ${d.reviewDecision === 'reject' ? 'Rejected' : d.reviewDecision === 'modify' ? 'Modified' : 'Approved'}${d.reviewedBy ? ` · ${d.reviewedBy}` : ''}`}>
            {!!d.reviewNotes && <View style={s.noteBox}><Text style={s.note}>{d.reviewNotes}</Text></View>}
          </Section>
        )}

        <PdfFooter docName={`${d.worktype} · ${d.subtype}`} propertyName={`${d.address}${d.locality ? `, ${d.locality}` : ''}`} />
      </Page>
    </Document>
  );
}
