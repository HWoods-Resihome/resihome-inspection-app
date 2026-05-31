/* Generates docs/ResiWalk-Walkthrough.pdf — a shareable feature + process guide.
 * Run: node scripts/walkthrough/build-pdf.cjs
 * Uses @react-pdf/renderer (already a project dependency). No JSX (plain CJS). */
const React = require('react');
const { Document, Page, Text, View, StyleSheet, renderToFile } = require('@react-pdf/renderer');
const path = require('path');

const BRAND = '#ff0060';
const INK = '#1f2937';
const GRAY = '#6b7280';

const s = StyleSheet.create({
  page: { paddingTop: 54, paddingBottom: 54, paddingHorizontal: 50, fontSize: 10.5, color: INK, fontFamily: 'Helvetica', lineHeight: 1.45 },
  coverWrap: { flexGrow: 1, justifyContent: 'center' },
  kicker: { fontSize: 11, color: BRAND, fontFamily: 'Helvetica-Bold', letterSpacing: 2, marginBottom: 10 },
  coverTitle: { fontSize: 30, fontFamily: 'Helvetica-Bold', color: INK, marginBottom: 8 },
  coverSub: { fontSize: 13, color: GRAY, marginBottom: 24, lineHeight: 1.4 },
  coverMeta: { fontSize: 9.5, color: GRAY },
  h1: { fontSize: 16, fontFamily: 'Helvetica-Bold', color: INK, marginTop: 18, marginBottom: 6, paddingBottom: 4, borderBottomWidth: 2, borderBottomColor: BRAND },
  h2: { fontSize: 12.5, fontFamily: 'Helvetica-Bold', color: BRAND, marginTop: 12, marginBottom: 4 },
  p: { marginBottom: 6 },
  bulletRow: { flexDirection: 'row', marginBottom: 3, paddingLeft: 4 },
  bulletDot: { width: 12, color: BRAND, fontFamily: 'Helvetica-Bold' },
  bulletText: { flex: 1 },
  stepRow: { flexDirection: 'row', marginBottom: 6 },
  stepNum: { width: 22, height: 18, color: 'white', backgroundColor: BRAND, fontFamily: 'Helvetica-Bold', fontSize: 9.5, textAlign: 'center', paddingTop: 3, borderRadius: 3, marginRight: 8 },
  stepText: { flex: 1, paddingTop: 1 },
  note: { backgroundColor: '#fff5f8', borderLeftWidth: 3, borderLeftColor: BRAND, padding: 8, marginBottom: 8, color: '#374151', fontSize: 9.8 },
  footer: { position: 'absolute', bottom: 26, left: 50, right: 50, flexDirection: 'row', justifyContent: 'space-between', fontSize: 8, color: '#9ca3af', borderTopWidth: 1, borderTopColor: '#e5e7eb', paddingTop: 6 },
});

const T = (txt, style) => React.createElement(Text, { style }, txt);
const H1 = (txt) => React.createElement(Text, { style: s.h1 }, txt);
const H2 = (txt) => React.createElement(Text, { style: s.h2 }, txt);
const P = (txt) => React.createElement(Text, { style: s.p }, txt);
const LI = (txt, i) => React.createElement(View, { style: s.bulletRow, key: 'li' + i }, T('•', s.bulletDot), T(txt, s.bulletText));
const BULLETS = (arr) => React.createElement(View, null, arr.map((t, i) => LI(t, i)));
const STEP = (n, txt) => React.createElement(View, { style: s.stepRow, key: 'st' + n }, T(String(n), s.stepNum), T(txt, s.stepText));
const STEPS = (arr) => React.createElement(View, null, arr.map((t, i) => STEP(i + 1, t)));
const NOTE = (txt) => React.createElement(Text, { style: s.note }, txt);

const footer = React.createElement(View, { style: s.footer, fixed: true },
  T('ResiWalk Inspections — Team Walkthrough', null),
  React.createElement(Text, { render: ({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}` }),
);

const cover = React.createElement(Page, { size: 'A4', style: s.page },
  React.createElement(View, { style: s.coverWrap },
    T('RESIWALK INSPECTIONS', s.kicker),
    T('Field App — Complete Walkthrough', s.coverTitle),
    T('Everything the inspection app does, plus a step-by-step run from a Scope Rate Card through manager approval and into a QC Turn Re-Inspect of that same property.', s.coverSub),
    T('For: Field inspectors, managers/approvers, QC. \nWorks on phone, tablet, and desktop — online and offline.', s.coverMeta),
  ),
  footer,
);

// Content body — flows/wraps across pages automatically.
const body = React.createElement(Page, { size: 'A4', style: s.page },

  H1('1. What ResiWalk is'),
  P('ResiWalk is the field inspection app for ResiHome turns and QC. Inspectors price the scope of work room-by-room, capture photo/video evidence, and let an AI review check the scope against the company turn standard before it goes to a manager for approval. It runs in any browser, installs to the home screen, and keeps working in dead zones — syncing automatically when signal returns.'),
  BULLETS([
    'Six inspection templates grouped by category: Turn (Scope Rate Card, Turn Re-Inspect QC), PM (Community, Vacancy/Occupancy), 1099 (Leasing Agent), QC (New Construction).',
    'Server-authoritative pricing: the inspector enters quantities/percentages and the app computes vendor, client, and tenant costs from the live rate-card catalog + regional rates.',
    'Hands-free voice line-item entry, AI scope review, and one-tap finalize that generates the manager + tenant + per-vendor PDFs.',
  ]),

  H1('2. Signing in & the home screen'),
  STEPS([
    'Open the app and sign in with your ResiHome email (Google sign-in).',
    'The home screen lists every inspection. Search by address, name, or inspector at the top.',
    'Status chips (All / Scheduled / In Progress / Pending Approval / Completed) filter the list; the Inspector and Template dropdowns narrow it further.',
    'Tap a card to open it. Press-and-hold a card to enter multi-select and bulk-cancel inspections.',
  ]),
  NOTE('Tip: the app is installable. "Add to Home Screen" gives it an app icon and an offline shell, so it opens even with no signal.'),

  H1('3. Starting a Scope Rate Card'),
  STEPS([
    'Tap "+ New Inspection".',
    'Pick the property, confirm bed/bath, and choose the template — under the Turn section choose "Scope Rate Card".',
    'Choose today to start immediately, or a future date to schedule and assign it.',
    'The inspection opens to its rooms/sections. The status pill flips to "In Progress" as soon as you make your first edit.',
  ]),

  H1('4. Building the scope — line items'),
  P('Each room is a section. Add priced line items two ways: type them, or speak them.'),
  H2('Adding a line by typing'),
  STEPS([
    'Open a room and tap "+ Add Line Item".',
    'Search the catalog — search is fuzzy and ranked, so "paint wall" finds "Paint 1 Wall" / "Paint 2 Wall". Pick the item.',
    'Enter the quantity (the unit — EA/SF/LF — is shown). Set the vendor and the tenant chargeback %. Optionally edit the description or set a custom vendor cost.',
    'Tap Save. To keep going, just tap "+ Add Line Item" again — it finalizes the current row and opens a fresh one.',
  ]),
  BULLETS([
    'Whole House + an SF item auto-fills the quantity with the property square footage.',
    'Paint and flooring lines auto-set the tenant % from the depreciation schedule based on the tenant’s months in the home (e.g. 12 months → paint 75% / flooring 95%). Tub/shower refinish is an exception and stays 100%.',
    'Costs (vendor / client / tenant) compute live as you type.',
  ]),

  H1('5. Voice assistant (hands-free)'),
  P('Tap the microphone in the footer and just talk while you walk the home.'),
  BULLETS([
    'Add multiple items at once, even across rooms: "add two light bulbs in the kitchen and a drywall repair in the hallway."',
    'Say a tenant % or vendor only if it differs from the defaults ("50 percent tenant", "assign to PPW").',
    'Domain-aware: "sales clean / full house clean" adds the single Whole House clean line; "mist match" is paint; it asks for a measured quantity (e.g. carpet SF) when needed instead of guessing.',
    'It announces each line it adds; review the proposal and keep moving.',
  ]),

  H1('6. Photos & video evidence'),
  STEPS([
    'In a room, tap "Take" to open the in-app camera.',
    'Snap a photo, press-and-hold for a video clip (capped at 20s), or use the Gallery button to pick existing photos. The phone-camera button (with the lightning badge) opens your device camera for a flash shot.',
    'Mark up a photo (arrow / circle / pen), and tag a photo to a specific line item so it travels with that line.',
  ]),
  NOTE('Offline: photos are compressed and queued on the device, shown immediately, and upload automatically when you’re back online. A storage warning appears if the device is filling up.'),

  H1('7. Totals & the scope breakdown'),
  BULLETS([
    'The header shows live totals: Lines, Vendor, Client, Tenant, Net Turn.',
    'Tap the totals to expand a by-category breakdown; tap a category to drill into its line items. "Expand all / Collapse all" opens or closes everything at once.',
  ]),

  H1('8. Offline & syncing'),
  BULLETS([
    'Everything works offline — the catalog is cached and edits/photos queue locally.',
    'A banner shows what’s pending and "Syncing…" while it sends. If something can’t sync, it flips to a red "haven’t synced" with Retry, Details (the exact reason), and Clear.',
    'Submit is blocked until all changes have truly synced, so a manager never receives a half-saved scope.',
  ]),

  H1('9. AI Scope Review (required before submit)'),
  P('The AI review checks the scope against the investment-property standard — SAFE, CLEAN, FUNCTIONAL — and the depreciation and tenant-responsibility rules.'),
  STEPS([
    'Tap the AI Review icon (the spark) in the footer. Its badge shows status: amber = needed, green check = done for the current scope.',
    'Suggestions stream in: edit a tenant %/quantity, remove a duplicate or over-scope line, add a missing item, or move a line to the right room.',
    'For each, Approve or Decline. You can override the tenant % or quantity right in the popup. Photo-gap items offer "Add photo" (opens the camera, tags the line), "Remove line", or "Ignore".',
    'Tap Apply — the app makes the changes, they save to HubSpot, and the review is marked complete.',
  ]),
  BULLETS([
    'What it catches: depreciation caps on paint/flooring; tenant responsibility (gutter cleaning & yard are tenant; low/0% tenant gets scrutinized); duplicate lines; whole-house paint/clean that makes per-room lines redundant; unrealistic quantities (e.g. carpet at 1 SF); and scopes beyond safe/clean/functional.',
    'Any edit to the scope (add/remove/qty/tenant %/cost) requires a fresh review before submit. Changing a vendor or editing photos does NOT — the review stays complete.',
    'Inspection photos are sent so the review can confirm damage and tenant %.',
  ]),

  H1('10. Submit for approval'),
  STEPS([
    'When required photos are present, the scope has synced, and AI review is complete, tap "Submit for Approval".',
    'The inspection moves to Pending Approval and is handed to the manager/approver.',
  ]),

  H1('11. Manager approval & finalize'),
  STEPS([
    'The approver opens the Pending Approval inspection and reviews the scope and photos. They can run the AI review themselves (the spark icon is available here too) — it does NOT block finalizing.',
    'When satisfied, tap "Finalize & Generate PDFs".',
    'The app generates the documents and emails the completion package.',
  ]),
  BULLETS([
    'Documents produced: Master Report, Tenant Chargeback (PDF), per-Vendor PDFs, and the Tenant Chargeback Import (xlsx) — the xlsx is listed last.',
    'A finalize lock prevents two people finalizing the same inspection at once (no duplicate PDFs/emails).',
  ]),

  H1('12. QC Turn Re-Inspect — calling the same inspection'),
  P('After the turn work is done, QC validates it against the very Scope Rate Card that was approved.'),
  STEPS([
    'Tap "+ New Inspection" and choose, under Turn, "Turn Re-Inspect QC".',
    'Select the property, then pick the source Scope Rate Card to validate — the approved inspection from the steps above. Its line items copy into the QC inspection.',
    'Walk the home and mark each line Pass or Fail, capturing before/after photos as evidence of the completed work.',
    'Finalize the QC to record the verdict (pass/fail counts) and generate its report.',
  ]),
  NOTE('This closes the loop: Scope Rate Card → manager approval → QC re-inspection of that exact scope — every line the vendor was paid for is verified on site.'),

  H1('13. Quick tips for the field'),
  BULLETS([
    'Use voice for speed; glance at the announced line to confirm it matched.',
    'Tag damage photos to their line so the chargeback evidence is unambiguous.',
    'Run the AI review early and again after edits — it’s your safety net for depreciation, duplicates, and tenant %.',
    'In a dead zone, keep working — watch the sync banner clear when you’re back online before you submit.',
  ]),

  footer,
);

const doc = React.createElement(Document, {
  title: 'ResiWalk Inspections — Team Walkthrough',
  author: 'ResiHome',
}, cover, body);

const out = path.join(__dirname, '..', '..', 'docs', 'ResiWalk-Walkthrough.pdf');
renderToFile(doc, out).then(() => console.log('Wrote', out)).catch((e) => { console.error(e); process.exit(1); });
