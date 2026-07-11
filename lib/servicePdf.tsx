/**
 * ResiWalk - Services — completion PDF (react-pdf document).
 *
 * A compact one-doc summary of a submitted/completed Service Work Order: header,
 * pricing, completion answers, before/after (+ pet) photos, and the AI + human
 * review notes. Analog of the inspection PDF; images are passed in pre-encoded as
 * data URIs by the API route (reliable server-side rendering).
 */
import React from 'react';
import { Document, Page, View, Text, Image, Link, StyleSheet } from '@react-pdf/renderer';

export interface ServicePdfData {
  address: string;
  locality: string;
  worktype: string;
  subtype: string;
  scope: string;
  vendor: string;
  status: string;
  dueDate: string;
  submittedAt: string;
  completedAt: string;
  vendorCost: string;
  markupPct: string;
  clientCost: string;
  adjustment: string;         // "" when none
  adjustmentReason: string;
  aiVerdict: string;
  aiNotes: string;
  reviewDecision: string;     // "" | "approve" | "reject"
  reviewNotes: string;
  reviewedBy: string;
  answers: { label: string; value: string }[];
  before: string[];           // data URIs
  after: string[];
  petBefore: string[];
  petAfter: string[];
  // Absolute URL to the hosted gallery (/services/<id>/photos); each photo links to
  // it deep-linked to its group + index, so tapping a PDF photo opens the same
  // enlarge/gallery viewer with Before/After toggle.
  galleryBase: string;
}

const BRAND = '#ff0060';
const s = StyleSheet.create({
  page: { padding: 28, fontSize: 10, color: '#111', fontFamily: 'Helvetica' },
  h1: { fontSize: 16, fontFamily: 'Helvetica-Bold', color: '#111' },
  sub: { fontSize: 10, color: '#555', marginTop: 2 },
  bar: { height: 3, backgroundColor: BRAND, marginTop: 8, marginBottom: 12, borderRadius: 2 },
  section: { marginTop: 12 },
  secTitle: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: BRAND, textTransform: 'uppercase', marginBottom: 5 },
  row: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 },
  label: { color: '#555' },
  val: { fontFamily: 'Helvetica-Bold', color: '#111' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  photo: { width: 120, height: 120, objectFit: 'cover', borderRadius: 3, border: '1 solid #ddd' },
  note: { color: '#333', lineHeight: 1.4 },
  pill: { fontSize: 9, fontFamily: 'Helvetica-Bold', color: '#fff', backgroundColor: BRAND, paddingVertical: 2, paddingHorizontal: 6, borderRadius: 8 },
});

function PhotoBlock({ title, urls, group, galleryBase }: { title: string; urls: string[]; group: string; galleryBase: string }) {
  if (!urls.length) return null;
  return (
    <View style={s.section} wrap={false}>
      <Text style={s.secTitle}>{title} <Text style={{ color: '#999', fontFamily: 'Helvetica' }}>· tap a photo to open the gallery</Text></Text>
      <View style={s.grid}>
        {urls.map((u, i) => (
          galleryBase
            ? <Link key={i} src={`${galleryBase}?g=${group}&i=${i}`} style={s.photo}><Image src={u} style={s.photo} /></Link>
            : <Image key={i} src={u} style={s.photo} />
        ))}
      </View>
    </View>
  );
}

export function ServicePdf({ d }: { d: ServicePdfData }) {
  return (
    <Document>
      <Page size="A4" style={s.page}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <View style={{ flex: 1 }}>
            <Text style={s.h1}>{d.address}</Text>
            <Text style={s.sub}>{d.worktype} · {d.subtype} · {d.scope} · {d.locality}</Text>
          </View>
          <Text style={s.pill}>{(d.status || '').toUpperCase()}</Text>
        </View>
        <View style={s.bar} />

        <View style={s.section}>
          <Text style={s.secTitle}>Work order</Text>
          <View style={s.row}><Text style={s.label}>Vendor</Text><Text style={s.val}>{d.vendor || '—'}</Text></View>
          {!!d.dueDate && <View style={s.row}><Text style={s.label}>Due</Text><Text style={s.val}>{d.dueDate}</Text></View>}
          {!!d.submittedAt && <View style={s.row}><Text style={s.label}>Submitted</Text><Text style={s.val}>{d.submittedAt}</Text></View>}
          {!!d.completedAt && <View style={s.row}><Text style={s.label}>Completed</Text><Text style={s.val}>{d.completedAt}</Text></View>}
          <View style={s.row}><Text style={s.label}>Vendor cost</Text><Text style={s.val}>{d.vendorCost}</Text></View>
          {!!d.markupPct && <View style={s.row}><Text style={s.label}>Markup</Text><Text style={s.val}>{d.markupPct}%</Text></View>}
          {!!d.clientCost && <View style={s.row}><Text style={s.label}>Client cost</Text><Text style={s.val}>{d.clientCost}</Text></View>}
          {!!d.adjustment && <View style={s.row}><Text style={s.label}>Payout adjustment</Text><Text style={[s.val, { color: '#c00' }]}>−{d.adjustment}{d.adjustmentReason ? ` (${d.adjustmentReason})` : ''}</Text></View>}
        </View>

        {d.answers.length > 0 && (
          <View style={s.section}>
            <Text style={s.secTitle}>Completion answers</Text>
            {d.answers.map((a, i) => (
              <View key={i} style={s.row}><Text style={s.label}>{a.label}</Text><Text style={s.val}>{a.value}</Text></View>
            ))}
          </View>
        )}

        {(d.aiVerdict || d.aiNotes) && (
          <View style={s.section}>
            <Text style={s.secTitle}>AI review {d.aiVerdict ? `— ${d.aiVerdict === 'clean' ? 'Clean' : 'Needs review'}` : ''}</Text>
            {!!d.aiNotes && <Text style={s.note}>{d.aiNotes}</Text>}
          </View>
        )}

        {!!d.reviewDecision && (
          <View style={s.section}>
            <Text style={s.secTitle}>Review — {d.reviewDecision === 'approve' ? 'Approved' : 'Rejected'}{d.reviewedBy ? ` · ${d.reviewedBy}` : ''}</Text>
            {!!d.reviewNotes && <Text style={s.note}>{d.reviewNotes}</Text>}
          </View>
        )}

        <PhotoBlock title="Before photos" urls={d.before} group="before" galleryBase={d.galleryBase} />
        <PhotoBlock title="After photos" urls={d.after} group="after" galleryBase={d.galleryBase} />
        <PhotoBlock title="Pet station — before" urls={d.petBefore} group="petBefore" galleryBase={d.galleryBase} />
        <PhotoBlock title="Pet station — after" urls={d.petAfter} group="petAfter" galleryBase={d.galleryBase} />
      </Page>
    </Document>
  );
}
