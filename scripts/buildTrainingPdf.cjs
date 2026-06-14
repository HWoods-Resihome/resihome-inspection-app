/* One-off: generate the branded ResiWALK training guide PDF.
   Run from the repo root:  node scripts/buildTrainingPdf.cjs  */
const React = require('react');
const fs = require('fs');
const path = require('path');
const { renderToBuffer, Document, Page, Text, View, Image, StyleSheet, Font } = require('@react-pdf/renderer');

Font.registerHyphenationCallback((w) => [w]);

// Brand logo (pink tile + white house/footprint), inlined in lib/brandLogo.ts.
let LOGO = '';
try {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'brandLogo.ts'), 'utf8');
  const m = src.match(/(data:image\/[a-zA-Z0-9+.\-]+;base64,[A-Za-z0-9+/=]+)/);
  if (m) LOGO = m[1];
} catch (_) {}

const C = {
  brand: '#ff0060', brandDark: '#cc004d', accent: '#0d9488', accentLt: '#73e3df',
  ink: '#1a1a1a', gray: '#5b6472', grayLt: '#9aa3b0', line: '#e5e7eb',
  bgPink: '#fff0f5', bgGray: '#f7f8fa', white: '#ffffff', amber: '#b45309', emerald: '#047857',
};

const S = StyleSheet.create({
  page: { fontFamily: 'Helvetica', fontSize: 10.5, lineHeight: 1.45, color: C.ink, paddingTop: 54, paddingBottom: 46, paddingHorizontal: 46 },
  // running header
  runHead: { position: 'absolute', top: 18, left: 46, right: 46, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  runHeadL: { flexDirection: 'row', alignItems: 'center' },
  runLogo: { width: 14, height: 14, borderRadius: 3, marginRight: 6 },
  runWord: { fontFamily: 'Helvetica-Bold', fontSize: 9, color: C.brand, letterSpacing: 0.5 },
  runRight: { fontSize: 8, color: C.grayLt },
  footer: { position: 'absolute', bottom: 20, left: 46, right: 46, flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 0.75, borderTopColor: C.line, paddingTop: 5 },
  footTxt: { fontSize: 7.5, color: C.grayLt },
  // cover
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
  // headings
  h1Wrap: { flexDirection: 'row', alignItems: 'center', marginTop: 8, marginBottom: 10 },
  h1Num: { fontFamily: 'Helvetica-Bold', fontSize: 13, color: C.white, backgroundColor: C.brand, paddingVertical: 3, paddingHorizontal: 8, borderRadius: 5, marginRight: 10 },
  h1: { fontFamily: 'Helvetica-Bold', fontSize: 17, color: C.ink, flex: 1 },
  h2: { fontFamily: 'Helvetica-Bold', fontSize: 12, color: C.brandDark, marginTop: 12, marginBottom: 4 },
  intro: { fontSize: 10.5, color: C.gray, marginBottom: 8, lineHeight: 1.5 },
  p: { marginBottom: 5 },
  // bullets
  liRow: { flexDirection: 'row', marginBottom: 4, paddingRight: 4 },
  dot: { width: 12, color: C.brand, fontFamily: 'Helvetica-Bold' },
  liTxt: { flex: 1 },
  liLabel: { fontFamily: 'Helvetica-Bold', color: C.ink },
  // numbered steps
  stepRow: { flexDirection: 'row', marginBottom: 6 },
  stepNum: { width: 18, height: 18, borderRadius: 9, backgroundColor: C.brand, color: C.white, fontFamily: 'Helvetica-Bold', fontSize: 9, textAlign: 'center', paddingTop: 3.5, marginRight: 9 },
  stepTxt: { flex: 1, paddingTop: 1 },
  // callout
  call: { backgroundColor: C.bgPink, borderLeftWidth: 3, borderLeftColor: C.brand, borderRadius: 4, padding: 9, marginTop: 8, marginBottom: 6 },
  callTitle: { fontFamily: 'Helvetica-Bold', fontSize: 9.5, color: C.brandDark, marginBottom: 3, letterSpacing: 0.5 },
  callTxt: { fontSize: 9.5, color: C.ink, lineHeight: 1.45 },
  tip: { backgroundColor: '#ecfdf5', borderLeftColor: C.emerald },
  tipTitle: { color: C.emerald },
  // toc
  tocRow: { flexDirection: 'row', justifyContent: 'space-between', borderBottomWidth: 0.5, borderBottomColor: C.line, paddingVertical: 5 },
  tocNum: { fontFamily: 'Helvetica-Bold', color: C.brand, width: 22 },
  tocTitle: { flex: 1, color: C.ink },
  divider: { height: 0.75, backgroundColor: C.line, marginVertical: 12 },
});

const h = React.createElement;
const T = (style, ...kids) => h(Text, { style }, ...kids);
const V = (style, ...kids) => h(View, { style }, ...kids);
// bullet; label is optional bold lead-in
const LI = (label, text) => h(View, { style: S.liRow }, T(S.dot, '•'),
  h(Text, { style: S.liTxt }, label ? h(Text, { style: S.liLabel }, label + '  ') : null, text));
const STEP = (n, text) => h(View, { style: S.stepRow }, T(S.stepNum, String(n)), h(Text, { style: S.stepTxt }, text));
const H1 = (num, title) => h(View, { style: S.h1Wrap }, T(S.h1Num, num), T(S.h1, title));
const H2 = (t) => T(S.h2, t);
const P = (...kids) => h(Text, { style: [S.p] }, ...kids);
const B = (t) => h(Text, { style: S.liLabel }, t);
const CALL = (title, text, tip) => h(View, { style: tip ? [S.call, S.tip] : S.call },
  T(tip ? [S.callTitle, S.tipTitle] : S.callTitle, title), T(S.callTxt, text));

function RunningHeader() {
  return V(S.runHead,
    V(S.runHeadL, LOGO ? h(Image, { src: LOGO, style: S.runLogo }) : null, T(S.runWord, 'RESIWALK')),
    T(S.runRight, 'Field Inspection App — Training Guide'));
}
function Footer() {
  return h(View, { style: S.footer, fixed: true },
    T(S.footTxt, 'ResiWALK — Confidential. For internal team & 1099 contractor use.'),
    h(Text, { style: S.footTxt, render: ({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}` }));
}
// Standard content page wrapper
function CPage(...kids) {
  return h(Page, { size: 'LETTER', style: S.page },
    h(View, { fixed: true }, RunningHeader()),
    ...kids,
    Footer());
}

// ---------- COVER ----------
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

// ---------- CONTENTS ----------
const tocItems = [
  ['1', 'Getting Started — Install & Sign In'],
  ['2', 'The Home Screen'],
  ['3', 'Scheduling & Assigning Inspections'],
  ['4', 'Inspection Types at a Glance'],
  ['5', 'The Camera & Media Tools'],
  ['6', 'The 1099 Leasing Agent Inspection'],
  ['7', 'The Scope Rate Card Inspection'],
  ['8', 'Adding Lines by Voice & Camera AI'],
  ['9', 'The Final Checklist'],
  ['10', 'AI Review (before you submit)'],
  ['11', 'Submitting, Approval & Hand-off'],
  ['12', 'The Turn Reinspection'],
  ['13', 'Reports & PDFs'],
  ['14', 'Good to Know (autosave, offline, audit)'],
  ['15', 'Quick Reference & Support'],
];
const toc = CPage(
  H1('', 'Contents'),
  T(S.intro, 'This guide walks through ResiWALK end-to-end — from signing in to finalizing and reporting. Internal staff and 1099 contractors use the same app; sections that differ by role are called out.'),
  V(null, ...tocItems.map(([n, t]) => h(View, { style: S.tocRow }, T(S.tocNum, n), T(S.tocTitle, t)))),
  CALL('THE BIG PICTURE',
    'ResiWALK turns a property walk into a structured, photo-backed record. You inspect, the app validates your entries with AI, a manager approves, and the system auto-generates the reports, emails the team, opens a maintenance ticket, and pushes tenant chargebacks to the ledger — no manual paperwork.'),
);

// ---------- 1. GETTING STARTED ----------
const p1 = CPage(
  H1('1', 'Getting Started — Install & Sign In'),
  H2('Install the app'),
  LI('Android:', 'Go to resiwalk.com/install and add the app to your home screen.'),
  LI('iPhone / iPad:', 'Open resiwalk.com in Safari, tap Share, then "Add to Home Screen" to save it as an app.'),
  LI('Anywhere:', 'You can also just use resiwalk.com in a browser — the installed app simply runs full-screen and works better offline.'),
  H2('Sign in'),
  LI('Internal team:', 'Enter your Resi email and authenticate through your Google account.'),
  LI('1099 contractors:', 'Sign in with Google or Microsoft, whichever matches your email provider.'),
  CALL('SECURE & SIMPLE', 'Everyone signs in with their work email — no separate password to remember. Only active users can sign in; deactivated accounts are blocked automatically.'),
  CALL('WORKS IN THE FIELD', 'ResiWALK is built for spotty service. Your answers and photos save as you go and automatically upload when you get signal again — you can keep working with no bars.', true),
);

// ---------- 2. HOME SCREEN ----------
const p2 = CPage(
  H1('2', 'The Home Screen'),
  T(S.intro, 'The home screen is your inspection pipeline — every open inspection in one list.'),
  H2('Find what you need'),
  LI('Filter', 'by inspector or by template (inspection type).'),
  LI('Sort', 'by date or by community.'),
  LI('Status toggles:', 'switch between Scheduled, In Progress, Pending Approval, and Completed.'),
  LI('Paging:', 'choose how many inspections show per page and move between pages.'),
  H2('Completed inspections'),
  P('Open any completed inspection to review it and download its PDFs (master report, tenant chargeback, charge import).'),
  CALL('TIP', 'Use the status toggles like a to-do list: work your "Scheduled" and "In Progress" lists down, and check "Pending Approval" if you are a reviewer.', true),
);

// ---------- 3. SCHEDULING ----------
const p3 = CPage(
  H1('3', 'Scheduling & Assigning Inspections'),
  T(S.intro, 'Inspections are created from the property record — most of the details fill themselves in.'),
  H2('Auto-populated from HubSpot'),
  P('When you open a scheduled inspection, ResiWALK pulls the property data straight from HubSpot: region, property status, bedroom & bathroom counts, and the scheduled date — so you are not re-typing anything.'),
  H2('Before you start, you can'),
  STEP(1, 'Reschedule the inspection to a different date.'),
  STEP(2, 'Reassign it to a different user (only active staff appear in the list).'),
  STEP(3, 'Proceed straight into the inspection interface.'),
  CALL('WHO CAN BE ASSIGNED', 'The assignee list shows active users only — you cannot accidentally assign an inspection to someone who has been deactivated.'),
);

// ---------- 4. TYPES ----------
const p4 = CPage(
  H1('4', 'Inspection Types at a Glance'),
  T(S.intro, 'ResiWALK supports several templates. The app shows the right questions and tools for each.'),
  LI('1099 Leasing Agent', '— a guided photo + question walk of the home (listing health, condition, HVAC, meters, trash, etc.). Covered in Section 6.'),
  LI('Scope Rate Card (Master)', '— the full turn scope: line items, quantities, vendors, pricing, and tenant chargebacks. Covered in Section 7.'),
  LI('Turn Reinspect', '— verify a vendor completed the scoped work, line by line, against "before" photos. Covered in Section 12.'),
  LI('Community Visit', '— confirm a community looks right and everything is in shape.'),
  LI('Vacancy / Occupancy Check', '— a quick drive-out to confirm whether a home is vacant or still occupied.'),
  LI('New Construction RQC', '— the readiness / quality-control report for built-to-rent communities and construction hand-off.'),
  CALL('SAME TOOLS EVERYWHERE', 'Every template uses the same camera, markup, voice, and validation tools — so once you learn one inspection, you know them all.', true),
);

// ---------- 5. CAMERA ----------
const p5 = CPage(
  H1('5', 'The Camera & Media Tools'),
  T(S.intro, 'Photos and video are the backbone of every inspection. The in-app camera does a lot — here is everything it offers.'),
  H2('Capturing'),
  LI('Two levels:', 'add photos to a specific line item, or to a whole section/room.'),
  LI('Location-stamped:', 'each capture validates and stamps location (address, time, GPS, and whether you are on-site or off-site) — proof the photo was taken at the property.'),
  LI('Lenses & zoom:', 'pinch or drag to zoom; tap the lens chips (e.g. 0.5× / 1×) to switch to a sharper lens. Your lens choice is remembered next time you open the camera.'),
  LI('Native camera option:', 'switch to the phone’s built-in camera when you need the flash.'),
  LI('Tap to focus:', 'tap the screen to refocus — even while recording video.'),
  H2('Video'),
  LI('Press & hold', 'the shutter to record a clip; narrate with a voiceover as you film.'),
  H2('Review & mark up'),
  LI('Swipe', 'through everything you captured — photos and video clips together — in one viewer.'),
  LI('Mark up', 'a photo with arrows and circles to point out exactly what matters.'),
  LI('Gallery is built in:', 'pull in an existing photo from your device right inside the camera (no separate upload button).'),
  LI('Tag to a line item', 'so the photo attaches to the exact scope line it documents.'),
  CALL('PROGRESS AT A GLANCE', 'As you work, ResiWALK tracks how many questions you have answered and how many pass/fail items remain — so you know what is left before you submit.'),
);

// ---------- 6. 1099 ----------
const p6 = CPage(
  H1('6', 'The 1099 Leasing Agent Inspection'),
  T(S.intro, 'A guided walk that captures the home’s condition and listing health. The header shows the inspection type, status, listing price, and how long it has been listed.'),
  H2('What you’ll cover'),
  LI('Listing feedback:', 'high-level input on listing price, maintenance, and occupancy (vacant or squatter-occupied).'),
  LI('Smart-home hubs', 'and device status.'),
  LI('Exterior', 'condition and photos.'),
  LI('Interior', 'photo documentation, room by room.'),
  LI('HVAC', 'components and filter details.'),
  LI('Utilities:', 'meter numbers.'),
  LI('Trash', 'bin presence.'),
  P('Answer the questions, capture the required photos, and submit when complete. The app shows your answered-question and pass/fail counts so nothing gets missed.'),
);

// ---------- 7. SCOPE ----------
const p7 = CPage(
  H1('7', 'The Scope Rate Card Inspection'),
  T(S.intro, 'The Scope Rate Card is the full turn scope and the financial heart of the app. You build the work needed room by room and the app prices it.'),
  H2('Build the scope'),
  LI('Sections (rooms):', 'add, rename (pencil), or delete (X) sections as needed.'),
  LI('Line items:', 'add work to a section (e.g. carpentry, bath accessories), set the quantity, choose the vendor, and adjust the vendor price or the tenant bill-back %.'),
  LI('Auto-proration:', 'the app automatically prorates the tenant chargeback based on how long the tenant lived there — depreciating tenant responsibility by tenancy length.'),
  H2('See the money before you submit'),
  LI('Drill-down:', 'use "Expand all" at the top to break costs out by category and line item across Vendor, Tenant, and Net cost.'),
  LI('Internal Resolution line:', 'a line at the top tracks the work your team can complete in-house, so you can see how much is handled internally vs. dispatched.'),
  CALL('VALIDATE THE CHARGEBACK', 'Before finalizing, always confirm the tenant chargeback total lines up with what you expect. The drill-down view makes this a quick sanity check.'),
);

// ---------- 8. VOICE & AI CAMERA ----------
const p8 = CPage(
  H1('8', 'Adding Lines by Voice & Camera AI'),
  T(S.intro, 'You don’t have to tap through menus to build a scope — talk to it, or point the camera and describe what you see.'),
  H2('Voice assistant'),
  STEP(1, 'Tap the microphone at the bottom of the scope.'),
  STEP(2, 'Say the work plainly — e.g. "clean whole house, level one sales clean," or "go to the kitchen and replace the microwave."'),
  STEP(3, 'It finds the matching catalog line, prices it, and reads back what it added. The mic stays open so you can reply or add the next item without tapping again.'),
  H2('Camera AI'),
  P('Open the AI camera and describe (or scan) the issue — it suggests the right line item in real time as you go. Great for capturing a defect and scoping the fix in one motion.'),
  CALL('SPEAK NATURALLY', 'You can list several things in one breath ("the yard needs leaves raked and a gutter cleaning, 50 linear feet, two-story") — the assistant splits them into separate lines. If it needs a quantity, it will ask.', true),
);

// ---------- 9. FINAL CHECKLIST ----------
const p9 = CPage(
  H1('9', 'The Final Checklist'),
  T(S.intro, 'At the bottom of the scope, a closing checklist makes sure the essentials are captured. (The 1099 inspection has a similar checklist.)'),
  LI('Bluetooth lock:', 'mark online/offline and record the serial number.'),
  LI('Universal garage remotes:', 'confirm the home has them. If you say no and no remote line exists, the app offers to add the line — choose "Add line" or "Not needed." Added lines appear back at the top of the scope.'),
  LI('Mailbox:', 'same add-line prompt if missing.'),
  LI('HVAC:', 'confirm it’s functioning. If not, you can be prompted to add a service/clean line so the issue is addressed.'),
  LI('Major appliances + label stickers:', 'photograph the appliance label/serial stickers — this feeds warranty tracking.'),
  LI('Air filters:', 'capture filter details for the Second Nature air-filter delivery program.'),
  LI('Final notes:', 'add any additional notes about the inspection.'),
  CALL('PROMPTS HELP YOU CATCH MISSES', 'The checklist actively prompts you to add the right line when something is missing — so universal remotes, mailbox keys, and HVAC service don’t slip through.'),
);

// ---------- 10. AI REVIEW ----------
const p10 = CPage(
  H1('10', 'AI Review (before you submit)'),
  T(S.intro, 'Before a Scope Rate Card can be submitted, it runs an AI Review — a second set of eyes on your scope and photos.'),
  H2('What it checks'),
  LI('Logic:', 'do the selected line items make sense together?'),
  LI('Duplicates:', 'flags work that’s been scoped twice (e.g. cleaning a carpet you’re replacing).'),
  LI('Missing info:', 'prompts you to add a photo for a specific line, or to justify a missing cleaning or painting scope — not because every home needs them, but so they’re never accidentally skipped.'),
  H2('You’re in control'),
  P('For each suggestion you can ', B('Edit'), ', ', B('Add'), ', or ', B('Ignore'), ' it — in real time, right there. Nothing is changed without you.'),
  CALL('GREEN MEANS GO', 'Once you’ve worked through the review, it turns green and the Submit button unlocks. The review is required for scope inspections, so a quick pass keeps quality high before anything reaches a manager.'),
);

// ---------- 11. APPROVAL ----------
const p11 = CPage(
  H1('11', 'Submitting, Approval & Hand-off'),
  T(S.intro, 'Submitting a scope kicks off an approval and automation chain — what used to be manual now happens for you.'),
  H2('The flow'),
  STEP(1, 'You submit → the inspection moves to Pending Approval.'),
  STEP(2, 'A regional manager or director reviews the line items and photos (placement of carpet, paint, trash-out, cleaning) and confirms the photos match before dispatch.'),
  STEP(3, 'They hit Finalize.'),
  H2('What Finalize does automatically'),
  LI('Generates the PDFs', '(master report, vendor, tenant chargeback).'),
  LI('Emails them', 'to the SODA box.'),
  LI('Creates a turnkey ticket', 'in Honeybadger Maintenance Management — with all documents uploaded, under Unit Turns, ready for the MC to dispatch.'),
  LI('Pushes the charge import', 'file to the ledgers for tenant chargebacks. If there’s ever an issue, a secondary email goes to the SODA box so PM Accounting can fix it manually.'),
  CALL('TWO SETS OF EYES', 'The person who submits a scope for approval cannot finalize their own submission — a second reviewer must approve it. This keeps every turn double-checked.'),
);

// ---------- 12. REINSPECT ----------
const p12 = CPage(
  H1('12', 'The Turn Reinspection'),
  T(S.intro, 'After the vendor completes the work, you create a reinspection to verify it — quickly and against the original scope.'),
  H2('How it works'),
  STEP(1, 'Create a Turn Reinspect for the property. It defaults to the most recently submitted scope and copies over every line item with its "before" photo.'),
  STEP(2, 'Go line by line: you see the before photo of what it looked like, then validate the work was done — a quick Yes / No.'),
  STEP(3, 'Take the "after" photo for each line as proof.'),
  STEP(4, 'If a line fails, you must add a note explaining what happened.'),
  STEP(5, 'At the end, give the overall inspection a Pass / Fail.'),
  H2('What the result does'),
  P('The overall pass/fail determines whether the property goes ', B('on market'), ' or stays ', B('off market'), ' until the failed lines are completed. On submit, the maintenance coordinator is notified in real time to pick up the report or move the home back on market.'),
  CALL('FAST & STRUCTURED', 'Because the lines and before-photos are pre-loaded, a reinspection is mostly tapping Yes/No and snapping after-photos straight down the list.', true),
);

// ---------- 13. REPORTS ----------
const p13 = CPage(
  H1('13', 'Reports & PDFs'),
  T(S.intro, 'Every finalized scope produces a clean set of PDFs, available to download from the completed inspection.'),
  H2('The documents'),
  LI('Master report:', 'page 1 is a summary of every line item; the following pages break it down by room and by section for detail.'),
  LI('Per-vendor PDFs', 'and the Internal Resolution PDF — full transparency for each vendor and for in-house work.'),
  LI('Tenant chargeback', 'and the charge import file.'),
  H2('Clickable photos'),
  P('Every photo in a PDF is clickable — it opens the actual photo gallery, where you (or a vendor) can swipe through the images. These galleries are public links vendors can open directly.'),
  CALL('CHARGEBACKS ARE AUTOMATIC', 'When a scope is finalized, the charge import file is automatically pushed to the ledgers for tenant chargebacks — no manual upload. Issues route to the SODA box for PM Accounting to correct.'),
);

// ---------- 14. GOOD TO KNOW ----------
const p14 = CPage(
  H1('14', 'Good to Know'),
  T(S.intro, 'A few things working quietly in the background that make ResiWALK reliable in the field.'),
  H2('Autosave'),
  P('You never hit "save." Every answer, line, and photo saves automatically as you work. Offline, changes queue on the device and upload the moment you reconnect.'),
  H2('Offline-first photos'),
  P('Photos and clips are stored on the device and sync in the background — so a dead zone never blocks the walk or loses a capture.'),
  H2('Audit trail'),
  P('Each inspection keeps a history under its ⚙️ menu — who submitted, approved, reopened, cancelled, and edited it, and when. Edits are logged once per editing session (and again if you leave the app and come back), so there’s a clear record without noise.'),
  H2('Updates'),
  P('When a new version ships, a banner offers a one-tap reload to get the latest. The app otherwise updates itself in the background.'),
  CALL('IF SOMETHING LOOKS OFF', 'Reload from the update banner (or fully close and reopen the app) to make sure you’re on the latest version before reporting an issue.', true),
);

// ---------- 15. QUICK REF ----------
const p15 = CPage(
  H1('15', 'Quick Reference & Support'),
  H2('Install'),
  LI('Android:', 'resiwalk.com/install → Add to home screen.'),
  LI('iPhone:', 'Safari → Share → Add to Home Screen.'),
  H2('Everyday flow (Scope Rate Card)'),
  STEP(1, 'Open the scheduled inspection (data auto-loads from HubSpot).'),
  STEP(2, 'Build sections & line items — by tapping, by voice, or with the camera AI.'),
  STEP(3, 'Capture & tag photos; mark up where helpful.'),
  STEP(4, 'Complete the final checklist.'),
  STEP(5, 'Run the AI Review and clear it to green.'),
  STEP(6, 'Submit → a manager finalizes → PDFs, email, ticket & chargebacks happen automatically.'),
  STEP(7, 'After the vendor finishes, create a Turn Reinspect to verify and set the home on/off market.'),
  V(S.divider),
  CALL('NEED HELP?',
    'For access issues, missing properties, or anything that doesn’t look right, contact your ResiWALK administrator or the SODA box team. Include the property address and a screenshot — it speeds things up.'),
  T([S.footTxt, { marginTop: 14, textAlign: 'center' }], 'ResiWALK — Field Inspection Platform   ·   ResiHome   ·   resiwalk.com'),
);

const doc = h(Document, {
  title: 'ResiWALK — App Training Guide',
  author: 'ResiHome / ResiWALK',
  subject: 'How to use the ResiWALK field inspection app',
  creator: 'ResiWALK',
}, cover, toc, p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, p11, p12, p13, p14, p15);

(async () => {
  const buf = await renderToBuffer(doc);
  const out = path.join(__dirname, '..', 'ResiWALK_Training_Guide.pdf');
  fs.writeFileSync(out, buf);
  console.log('Wrote', out, buf.length, 'bytes,', 'logo:', LOGO ? 'yes' : 'MISSING');
})().catch((e) => { console.error(e); process.exit(1); });
