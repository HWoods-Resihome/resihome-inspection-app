/* One-off: generate the branded ResiWALK training guide PDF (with screenshots).
   Run from the repo root:  node scripts/buildTrainingPdf.cjs  */
const React = require('react');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { renderToBuffer, Document, Page, Text, View, Image, StyleSheet, Font } = require('@react-pdf/renderer');

Font.registerHyphenationCallback((w) => [w]);

// Brand logo (pink tile + white house/footprint), inlined in lib/brandLogo.ts.
let LOGO = '';
try {
  const m = fs.readFileSync(path.join(__dirname, '..', 'lib', 'brandLogo.ts'), 'utf8')
    .match(/(data:image\/[a-zA-Z0-9+.\-]+;base64,[A-Za-z0-9+/=]+)/);
  if (m) LOGO = m[1];
} catch (_) {}

// ---- Screenshots: crop the phone status bar + bottom gesture bar, resize. ----
const SHOT_DIR = '/root/.claude/uploads/23581d2a-5a33-5b24-a6c6-04c02afffb86';
const SRC = {
  signin: '8efa71cb-1000015031.jpg', // both providers
  home: '39387d3a-1000015033.jpg',
  newInsp: '3a21505a-1000015037.jpg',
  camera: '8b16c99c-1000015043.jpg',
  markup: '8f8095a5-1000015045.jpg',
  leasing: 'd177cb1c-1000015041.jpg',
  addline: 'fc72e782-1000015047.jpg',
  drilldown: '69de6bf2-1000015055.jpg',
  reinspect: '7c233f5b-1000015057.jpg',
  download: 'd27f0ad4-1000015061.jpg',
  masterpdf: '78c0f983-1000015063.jpg',
};
async function loadShot(file) {
  const full = path.join(SHOT_DIR, file);
  const meta = await sharp(full).metadata();
  const top = Math.round(meta.height * 0.030);     // phone status bar
  const bottom = Math.round(meta.height * 0.022);   // gesture bar
  const region = { left: 0, top, width: meta.width, height: meta.height - top - bottom };
  const buf = await sharp(full).extract(region).resize({ width: 640 }).jpeg({ quality: 78 }).toBuffer();
  const m2 = await sharp(buf).metadata();
  return { src: 'data:image/jpeg;base64,' + buf.toString('base64'), w: m2.width, h: m2.height };
}

const C = {
  brand: '#ff0060', brandDark: '#cc004d', accent: '#0d9488',
  ink: '#1a1a1a', gray: '#5b6472', grayLt: '#9aa3b0', line: '#e5e7eb',
  bgPink: '#fff0f5', white: '#ffffff', emerald: '#047857',
};

const S = StyleSheet.create({
  page: { fontFamily: 'Helvetica', fontSize: 10.5, lineHeight: 1.45, color: C.ink, paddingTop: 54, paddingBottom: 46, paddingHorizontal: 46 },
  runHead: { position: 'absolute', top: 18, left: 46, right: 46, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  runHeadL: { flexDirection: 'row', alignItems: 'center' },
  runLogo: { width: 14, height: 14, borderRadius: 3, marginRight: 6 },
  runWord: { fontFamily: 'Helvetica-Bold', fontSize: 9, color: C.brand, letterSpacing: 0.5 },
  runRight: { fontSize: 8, color: C.grayLt },
  footer: { position: 'absolute', bottom: 20, left: 46, right: 46, flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 0.75, borderTopColor: C.line, paddingTop: 5 },
  footTxt: { fontSize: 7.5, color: C.grayLt },
  cover: { flex: 1, backgroundColor: C.brand, color: C.white },
  coverPad: { paddingTop: 150, paddingHorizontal: 56 },
  coverLogo: { width: 76, height: 76, borderRadius: 16, marginBottom: 28 },
  coverKicker: { fontFamily: 'Helvetica-Bold', fontSize: 11, letterSpacing: 3, color: '#ffd1e2' },
  coverTitle: { fontFamily: 'Helvetica-Bold', fontSize: 42, color: C.white, marginTop: 10, letterSpacing: 1 },
  coverSub: { fontSize: 16, color: '#ffe3ee', marginTop: 12, maxWidth: 380, lineHeight: 1.4 },
  coverRule: { width: 64, height: 4, backgroundColor: C.white, marginTop: 26, marginBottom: 26, borderRadius: 2 },
  coverMeta: { fontSize: 10.5, color: '#ffe3ee', lineHeight: 1.6 },
  coverFootWrap: { position: 'absolute', bottom: 46, left: 56, right: 56, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  coverFoot: { fontSize: 9, color: '#ffd1e2' },
  h1Wrap: { flexDirection: 'row', alignItems: 'center', marginTop: 4, marginBottom: 10 },
  h1Num: { fontFamily: 'Helvetica-Bold', fontSize: 13, color: C.white, backgroundColor: C.brand, paddingVertical: 3, paddingHorizontal: 8, borderRadius: 5, marginRight: 10 },
  h1: { fontFamily: 'Helvetica-Bold', fontSize: 17, color: C.ink, flex: 1 },
  h2: { fontFamily: 'Helvetica-Bold', fontSize: 12, color: C.brandDark, marginTop: 11, marginBottom: 4 },
  intro: { fontSize: 10.5, color: C.gray, marginBottom: 8, lineHeight: 1.5 },
  p: { marginBottom: 5 },
  liRow: { flexDirection: 'row', marginBottom: 4, paddingRight: 4 },
  dot: { width: 12, color: C.brand, fontFamily: 'Helvetica-Bold' },
  liTxt: { flex: 1 },
  liLabel: { fontFamily: 'Helvetica-Bold', color: C.ink },
  stepRow: { flexDirection: 'row', marginBottom: 6 },
  stepNum: { width: 18, height: 18, borderRadius: 9, backgroundColor: C.brand, color: C.white, fontFamily: 'Helvetica-Bold', fontSize: 9, textAlign: 'center', paddingTop: 3.5, marginRight: 9 },
  stepTxt: { flex: 1, paddingTop: 1 },
  call: { backgroundColor: C.bgPink, borderLeftWidth: 3, borderLeftColor: C.brand, borderRadius: 4, padding: 9, marginTop: 8, marginBottom: 6 },
  callTitle: { fontFamily: 'Helvetica-Bold', fontSize: 9.5, color: C.brandDark, marginBottom: 3, letterSpacing: 0.5 },
  callTxt: { fontSize: 9.5, color: C.ink, lineHeight: 1.45 },
  tip: { backgroundColor: '#ecfdf5', borderLeftColor: C.emerald },
  tipTitle: { color: C.emerald },
  tocRow: { flexDirection: 'row', justifyContent: 'space-between', borderBottomWidth: 0.5, borderBottomColor: C.line, paddingVertical: 5 },
  tocNum: { fontFamily: 'Helvetica-Bold', color: C.brand, width: 22 },
  tocTitle: { flex: 1, color: C.ink },
  divider: { height: 0.75, backgroundColor: C.line, marginVertical: 12 },
  sec: { marginBottom: 16 },
  // figures
  figRow: { flexDirection: 'row', justifyContent: 'center', marginTop: 7, gap: 12 },
  fig: { borderWidth: 1, borderColor: C.line, borderRadius: 6, padding: 3, backgroundColor: C.white },
  figCap: { fontSize: 7.5, color: C.gray, textAlign: 'center', marginTop: 3, maxWidth: 180 },
  figImg: { borderRadius: 3 },
});

const h = React.createElement;
const T = (style, ...kids) => h(Text, { style }, ...kids);
const V = (style, ...kids) => h(View, { style }, ...kids);
const LI = (label, text) => h(View, { style: S.liRow }, T(S.dot, '•'),
  h(Text, { style: S.liTxt }, label ? h(Text, { style: S.liLabel }, label + '  ') : null, text));
const STEP = (n, text) => h(View, { style: S.stepRow }, T(S.stepNum, String(n)), h(Text, { style: S.stepTxt }, text));
const H1 = (num, title) => h(View, { style: S.h1Wrap }, num ? T(S.h1Num, num) : null, T(S.h1, title));
const H2 = (t) => T(S.h2, t);
const P = (...kids) => h(Text, { style: S.p }, ...kids);
const B = (t) => h(Text, { style: S.liLabel }, t);
const CALL = (title, text, tip) => h(View, { style: tip ? [S.call, S.tip] : S.call },
  T(tip ? [S.callTitle, S.tipTitle] : S.callTitle, title), T(S.callTxt, text));

// figure(s): a centered row of device screenshots with captions. `w` is the
// display width; height derives from the cropped aspect ratio.
function FIG(items) {
  const w = items.length > 1 ? 132 : 168;
  return h(View, { style: S.figRow, wrap: false }, ...items.map(({ shot, cap }) =>
    V(null,
      h(View, { style: S.fig }, h(Image, { src: shot.src, style: [S.figImg, { width: w, height: Math.round(w * shot.h / shot.w) }] })),
      cap ? T([S.figCap, { width: w }], cap) : null,
    )));
}

function RunningHeader() {
  // `fixed` applied directly to the absolutely-positioned header so its top/left
  // offsets resolve against the page (not a wrapper in normal flow, which would
  // drop the logo onto the page title).
  return h(View, { style: S.runHead, fixed: true },
    V(S.runHeadL, LOGO ? h(Image, { src: LOGO, style: S.runLogo }) : null, T(S.runWord, 'RESIWALK')),
    T(S.runRight, 'Field Inspection App — Training Guide'));
}
function Footer() {
  return h(View, { style: S.footer, fixed: true },
    T(S.footTxt, 'ResiWALK — Confidential. For internal team & 1099 contractor use.'),
    h(Text, { style: S.footTxt, render: ({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}` }));
}
function CPage(...kids) {
  return h(Page, { size: 'LETTER', style: S.page }, RunningHeader(), ...kids, Footer());
}
// A section that flows in a shared, auto-paginating page.
const SEC = (...kids) => h(View, { style: S.sec }, ...kids);
function ContentPage(...secs) {
  return h(Page, { size: 'LETTER', style: S.page }, RunningHeader(), ...secs, Footer());
}

(async () => {
  const I = {};
  for (const [k, f] of Object.entries(SRC)) I[k] = await loadShot(f);

  const cover = h(Page, { size: 'LETTER' },
    h(View, { style: S.cover },
      V(S.coverPad,
        LOGO ? h(Image, { src: LOGO, style: S.coverLogo }) : null,
        T(S.coverKicker, 'FIELD INSPECTION PLATFORM'),
        T(S.coverTitle, 'ResiWALK'),
        T(S.coverSub, 'The complete guide to using the app — every inspection type, the camera & AI tools, scoping, review, approval, and reporting.'),
        V(S.coverRule),
        T(S.coverMeta, 'Audience:  Internal team & 1099 contractors\nVersion:  June 2026\nApplies to:  resiwalk.com  ·  installed app (Android & iPhone)'),
      ),
      h(View, { style: S.coverFootWrap },
        T(S.coverFoot, 'ResiHome / ResiWALK'),
        T(S.coverFoot, 'Confidential — do not distribute outside authorized partners'),
      ),
    ));

  const tocItems = [
    ['1', 'Getting Started — Install & Sign In'], ['2', 'The Home Screen'],
    ['3', 'Scheduling & Assigning Inspections'], ['4', 'Inspection Types at a Glance'],
    ['5', 'The Camera & Media Tools'], ['6', 'The 1099 Leasing Agent Inspection'],
    ['7', 'The Scope Rate Card Inspection'], ['8', 'Adding Lines by Voice & Camera AI'],
    ['9', 'The Final Checklist'], ['10', 'AI Review (before you submit)'],
    ['11', 'Submitting, Approval & Hand-off'], ['12', 'The Turn Reinspection'],
    ['13', 'Reports & PDFs'], ['14', 'Good to Know (autosave, offline, audit)'],
  ];
  const toc = CPage(
    H1('', 'Contents'),
    T(S.intro, 'This guide walks through ResiWALK end-to-end — from signing in to finalizing and reporting. Internal staff and 1099 contractors use the same app; sections that differ by role are called out. Screens shown throughout are from the live app.'),
    V(null, ...tocItems.map(([n, t]) => h(View, { style: S.tocRow }, T(S.tocNum, n), T(S.tocTitle, t)))),
    CALL('THE BIG PICTURE', 'ResiWALK turns a property walk into a structured, photo-backed record. You inspect, the app validates your entries with AI, a manager approves, and the system auto-generates the reports, emails the team, opens a maintenance ticket, and pushes tenant chargebacks to the ledger — no manual paperwork.'),
  );

  const p1 = SEC(
    H1('1', 'Getting Started — Install & Sign In'),
    H2('Install the app'),
    LI('Android:', 'Go to resiwalk.com/install and add the app to your home screen.'),
    LI('iPhone / iPad:', 'Open resiwalk.com in Safari, tap Share, then "Add to Home Screen."'),
    LI('Anywhere:', 'You can also just use resiwalk.com in a browser.'),
    H2('Sign in'),
    LI('Internal team:', 'Enter your Resi email and confirm with your Google account.'),
    LI('1099 contractors:', 'Sign in with Google or Microsoft — whichever matches your email.'),
    CALL('SECURE & SIMPLE', 'Everyone signs in with their work email — no separate password. Only active users can sign in; deactivated accounts are blocked automatically.'),
    FIG([{ shot: I.signin, cap: 'Sign in with Google (staff) or Microsoft (1099).' }]),
  );

  const p2 = SEC(
    H1('2', 'The Home Screen'),
    T(S.intro, 'The home screen is your inspection pipeline — every open inspection in one list.'),
    H2('Find what you need'),
    LI('Filter', 'by inspector or by template (inspection type).'),
    LI('Sort', 'by date or by community; flip the sort direction.'),
    LI('Status toggles:', 'All, Scheduled, In Progress, Pending Approval, Completed — each with a live count.'),
    LI('Paging & search:', 'search by address/name/inspector, and page through results.'),
    LI('Completed:', 'open any completed inspection to review it and download its PDFs.'),
    FIG([{ shot: I.home, cap: 'The pipeline: search, status counts, filters, and inspection cards.' }]),
  );

  const p3 = SEC(
    H1('3', 'Scheduling & Assigning Inspections'),
    T(S.intro, 'Inspections are created from the property record — most details fill themselves in.'),
    H2('Auto-populated from HubSpot'),
    P('Region, property status, bedroom & bathroom counts, and the scheduled date all pull straight from HubSpot — no re-typing.'),
    H2('Before you start, you can'),
    STEP(1, 'Pick the inspection type (template) and the property.'),
    STEP(2, 'Reschedule, or reassign to a different user (active staff only).'),
    STEP(3, 'Tap Begin Inspection to go straight in.'),
    CALL('ACTIVE USERS ONLY', 'The assignee list shows active users only — you can’t assign an inspection to someone who has been deactivated.'),
    FIG([{ shot: I.newInsp, cap: 'New Inspection — template, property, beds/baths, date & inspector pre-filled.' }]),
  );

  const p4 = SEC(
    H1('4', 'Inspection Types at a Glance'),
    T(S.intro, 'ResiWALK supports several templates; the app shows the right questions and tools for each.'),
    LI('1099 Leasing Agent', '— a guided photo + question walk (listing health, condition, HVAC, meters, trash). See §6.'),
    LI('Scope Rate Card (Master)', '— the full turn scope: line items, quantities, vendors, pricing, tenant chargebacks. See §7.'),
    LI('Turn Reinspect QC', '— verify a vendor completed the scoped work, line by line, against "before" photos. See §12.'),
    LI('Community Visit', '— confirm a community looks right and everything is in shape.'),
    LI('Vacancy / Occupancy Check', '— a quick drive-out to confirm whether a home is vacant or occupied.'),
    LI('New Construction RQC', '— readiness / quality-control report for built-to-rent and construction hand-off.'),
    CALL('SAME TOOLS EVERYWHERE', 'Every template uses the same camera, markup, voice, and validation tools — learn one inspection and you know them all.', true),
  );

  const p5 = SEC(
    H1('5', 'The Camera & Media Tools'),
    T(S.intro, 'Photos and video are the backbone of every inspection. The in-app camera does a lot.'),
    H2('Capturing'),
    LI('Two levels:', 'add photos to a line item, or to a whole section/room.'),
    LI('Location-stamped:', 'each capture stamps address, time, GPS, and on-site vs. off-site distance — proof of where it was taken.'),
    LI('Lenses & zoom:', 'pinch/drag to zoom; tap the lens chips to switch to a sharper lens (remembered next time).'),
    LI('Flash:', 'switch to the phone’s native camera when you need the flash.'),
    LI('Tap to focus', 'anywhere on the frame — even while recording video.'),
    H2('Review & mark up'),
    LI('Swipe', 'through photos and video clips together in one viewer.'),
    LI('Mark up', 'with arrows, circles, or a pen in brand colors.'),
    LI('Gallery is built in', '— pull in an existing photo right from the camera (no separate upload).'),
    LI('Tag to a line item', 'so a photo attaches to the exact scope line it documents.'),
    FIG([
      { shot: I.camera, cap: 'In-app camera: location badge, lens chips, gallery, mark & shutter.' },
      { shot: I.markup, cap: 'Markup: arrows & circles over the location-stamped photo.' },
    ]),
  );

  const p6 = SEC(
    H1('6', 'The 1099 Leasing Agent Inspection'),
    T(S.intro, 'A guided walk that captures the home’s condition and listing health. The header shows type, status, listing price, and how long it’s been listed — plus your pass/fail tally and "all changes saved."'),
    H2('What you’ll cover'),
    LI('Listing feedback:', 'evaluate listing price (Reduce / Keep / Increase) and lead feedback (Good / Fail).'),
    LI('Action required:', 'a Fail prompts a required note and optional photos so the issue is documented.'),
    LI('Whole house, HVAC & utilities:', 'device hubs, exterior & interior photos, HVAC components, filters, meter numbers, trash bins.'),
    P('Answer the questions, capture the required photos, then Submit. The progress count (e.g. "8/19 answered") shows what’s left.'),
    FIG([{ shot: I.leasing, cap: 'A question with pass/fail, required note, and photos.' }]),
  );

  const p7 = SEC(
    H1('7', 'The Scope Rate Card Inspection'),
    T(S.intro, 'The full turn scope and the financial heart of the app — you build the work room by room and it prices it.'),
    H2('Build the scope'),
    LI('Sections (rooms):', 'add, rename (pencil), or delete (X) sections.'),
    LI('Line items:', 'pick a category, sub-category, and item; set quantity; choose the vendor; adjust the vendor price or tenant bill-back %.'),
    LI('Auto-proration:', 'the tenant chargeback is automatically prorated by how long the tenant lived there.'),
    LI('Internal Resolution:', 'assign a line to "Internal Resolution" for work your team completes in-house (with a Now/Later choice and after-photos).'),
    H2('See the money before you submit'),
    LI('Totals strip:', 'Lines, Vendor, Client, Tenant, and Net Turn update live at the top.'),
    LI('Drill-down:', '"Expand all" breaks costs out by category and line item across Vendor, Tenant, and Net.'),
    CALL('VALIDATE THE CHARGEBACK', 'Before finalizing, confirm the tenant total lines up with what you expect — the drill-down makes it a quick check.'),
    FIG([
      { shot: I.addline, cap: 'Add a line — category, qty, vendor, tenant %, live pricing.' },
      { shot: I.drilldown, cap: 'Expand-all drill-down by category, with the live totals strip.' },
    ]),
  );

  const p8 = SEC(
    H1('8', 'Adding Lines by Voice & Camera AI'),
    T(S.intro, 'You don’t have to tap through menus — talk to it, or point the camera and describe what you see. (Look for the mic and AI buttons in the scope footer.)'),
    H2('Voice assistant'),
    STEP(1, 'Tap the microphone at the bottom of the scope.'),
    STEP(2, 'Say the work plainly — e.g. "clean whole house, level one sales clean," or "go to the kitchen and replace the microwave."'),
    STEP(3, 'It finds the matching catalog line, prices it, and reads back what it added. The mic stays open so you can reply or add the next item without tapping again.'),
    H2('Camera AI'),
    P('Open the AI camera and describe (or scan) the issue — it suggests the right line item in real time. Great for capturing a defect and scoping the fix in one motion.'),
    CALL('SPEAK NATURALLY', 'List several things in one breath ("the yard needs leaves raked and a gutter cleaning, 50 linear feet, two-story") — it splits them into separate lines and asks if it needs a quantity.', true),
  );

  const p9 = SEC(
    H1('9', 'The Final Checklist'),
    T(S.intro, 'At the bottom of the scope, a closing checklist makes sure the essentials are captured. (The 1099 inspection has a similar checklist.)'),
    LI('Bluetooth lock:', 'mark online/offline and record the serial number.'),
    LI('Universal garage remotes:', 'if missing, the app offers to add the line — choose "Add line" or "Not needed." Added lines appear back at the top.'),
    LI('Mailbox:', 'same add-line prompt if missing.'),
    LI('HVAC:', 'confirm it’s functioning; if not, you can be prompted to add a service/clean line.'),
    LI('Major appliances + label stickers:', 'photograph the label/serial stickers — feeds warranty tracking.'),
    LI('Air filters:', 'capture filter details for the Second Nature delivery program.'),
    LI('Final notes:', 'add anything else about the inspection.'),
    CALL('PROMPTS CATCH MISSES', 'The checklist actively prompts you to add the right line when something’s missing — so remotes, mailbox keys, and HVAC service don’t slip through.'),
  );

  const p10 = SEC(
    H1('10', 'AI Review (before you submit)'),
    T(S.intro, 'Before a Scope Rate Card can be submitted, it runs an AI Review — a second set of eyes on your scope and photos.'),
    H2('What it checks'),
    LI('Logic:', 'do the selected line items make sense together?'),
    LI('Duplicates:', 'flags work scoped twice (e.g. cleaning a carpet you’re replacing).'),
    LI('Missing info:', 'prompts you to add a photo for a line, or to justify a missing cleaning or painting scope — so they’re never accidentally skipped.'),
    H2('You’re in control'),
    P('For each suggestion you can ', B('Edit'), ', ', B('Add'), ', or ', B('Ignore'), ' it — in real time. Nothing changes without you.'),
    CALL('GREEN MEANS GO', 'Once you’ve worked through the review it turns green and Submit unlocks. The review is required for scope inspections, so a quick pass keeps quality high before a manager sees it.'),
  );

  const p11 = SEC(
    H1('11', 'Submitting, Approval & Hand-off'),
    T(S.intro, 'Submitting a scope kicks off an approval and automation chain — what used to be manual now happens for you.'),
    H2('The flow'),
    STEP(1, 'You submit → the inspection moves to Pending Approval.'),
    STEP(2, 'A regional manager or director reviews the line items and photos and confirms they match before dispatch.'),
    STEP(3, 'They hit Finalize.'),
    H2('What Finalize does automatically'),
    LI('Generates the PDFs', '(master, vendor, tenant chargeback).'),
    LI('Emails them', 'to the SODA box.'),
    LI('Creates a turnkey ticket', 'in Honeybadger MM — documents attached, under Unit Turns — for the MC to dispatch.'),
    LI('Pushes the charge import', 'to the ledgers for tenant chargebacks. Issues route a second email to the SODA box for PM Accounting.'),
    CALL('TWO SETS OF EYES', 'The person who submits a scope cannot finalize their own submission — a second reviewer must approve it. Every turn is double-checked.'),
  );

  const p12 = SEC(
    H1('12', 'The Turn Reinspection'),
    T(S.intro, 'After the vendor completes the work, create a reinspection to verify it — quickly, against the original scope.'),
    H2('How it works'),
    STEP(1, 'Create a Turn Re-Inspect QC. It defaults to the most recently submitted scope and copies every line with its "before" photo.'),
    STEP(2, 'Go line by line: see the before photo, then validate the work — a quick Pass / Fail.'),
    STEP(3, 'Take the "after" photo for each line as proof.'),
    STEP(4, 'A Fail requires a note explaining what happened and what’s needed.'),
    STEP(5, 'Give the overall inspection a Pass / Fail at the end.'),
    P('The overall result determines whether the property goes ', B('on market'), ' or stays ', B('off market'), ' until failed lines are done. On submit, the maintenance coordinator is notified in real time.'),
    FIG([{ shot: I.reinspect, cap: 'Reinspect: before/after strips, per-line pass/fail, required fail note.' }]),
  );

  const p13 = SEC(
    H1('13', 'Reports & PDFs'),
    T(S.intro, 'Every finalized scope produces a clean set of PDFs, downloadable from the completed inspection.'),
    H2('The documents'),
    LI('Master report:', 'page 1 is a summary of every line item; following pages break it down by room and section.'),
    LI('Per-vendor PDFs', 'and the Internal Resolution PDF — full transparency for each vendor and in-house work.'),
    LI('Tenant chargeback', 'PDF and the charge import (xlsx).'),
    H2('Clickable photos'),
    P('Every photo in a PDF is clickable — it opens the actual photo gallery to swipe through. These are public links vendors can open directly.'),
    CALL('CHARGEBACKS ARE AUTOMATIC', 'On finalize, the charge import file is pushed to the ledgers automatically. Any issue routes to the SODA box for PM Accounting to correct.'),
    FIG([
      { shot: I.download, cap: 'Download any document — or all six — from the completed inspection.' },
      { shot: I.masterpdf, cap: 'The Master report: line-item summary, then photo galleries by room.' },
    ]),
  );

  const p14 = SEC(
    H1('14', 'Good to Know'),
    T(S.intro, 'A few things working quietly in the background that make ResiWALK reliable in the field.'),
    H2('Autosave'),
    P('You never hit "save." Every answer, line, and photo saves as you work; offline, changes queue and upload the moment you reconnect.'),
    H2('Offline-first photos'),
    P('Photos and clips are stored on the device and sync in the background — a dead zone never blocks the walk or loses a capture.'),
    H2('Audit trail'),
    P('Each inspection keeps a history under its ⚙️ menu — who submitted, approved, reopened, cancelled, and edited it, and when. Edits log once per session (and again after you leave and return), so the record stays clear without noise.'),
    H2('Updates'),
    P('When a new version ships, a banner offers a one-tap reload. The app otherwise updates itself in the background.'),
    CALL('IF SOMETHING LOOKS OFF', 'Reload from the update banner (or fully close and reopen the app) to be sure you’re on the latest version before reporting an issue.', true),
  );

  // Sections flow across a few shared, auto-paginating pages (instead of one
  // forced page break per section) so the whole guide stays within 15 pages.
  const doc = h(Document, { title: 'ResiWALK — App Training Guide', author: 'ResiHome / ResiWALK', subject: 'How to use the ResiWALK field inspection app', creator: 'ResiWALK' },
    cover, toc,
    // Figure-bearing sections render one-per-page (a wrap:false figure inside a
    // multi-section flow trips a react-pdf layout loop); consecutive text-only
    // sections share pages to keep the whole guide within 15 pages.
    ContentPage(p1), ContentPage(p2), ContentPage(p3),
    ContentPage(p4),
    ContentPage(p5), ContentPage(p6), ContentPage(p7),
    ContentPage(p8, p9, p10, p11),
    ContentPage(p12), ContentPage(p13),
    ContentPage(p14));

  const buf = await renderToBuffer(doc);
  const out = path.join(__dirname, '..', 'ResiWALK_Training_Guide.pdf');
  fs.writeFileSync(out, buf);
  console.log('Wrote', out, buf.length, 'bytes; logo:', LOGO ? 'yes' : 'MISSING', '; shots:', Object.keys(I).length);
})().catch((e) => { console.error(e); process.exit(1); });
