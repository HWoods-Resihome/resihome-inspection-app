# ARCHITECTURE.md — orientation map for ResiHome / ResiWALK

Read this alongside **CLAUDE.md** (working notes + hard rules). This file is the
**map**: the domain model, how an inspection flows from create → complete → email,
where the PDFs and notifications come from, and where the big files live. It exists
so a session doesn't have to re-derive these facts by reading 10k-line files.

> Keep it current: when you change a completion route, a notification, the PDF
> pipeline, or a templateType, update the matching table here in the same commit.
> A stale map is worse than none.

---

## 1. What this app is (one paragraph)

A Next.js **pages-router** app (deployed to Vercel, `resiwalk.com`) where **HubSpot
is the database** — there is no SQL store. Field users run property **inspections**
(and, separately, recurring **services**); the app renders **PDF reports**, writes
results back to HubSpot custom objects, files **HoneyBadger (HBMM) maintenance
tickets**, and emails the results. A thin **Capacitor** native shell (`mobile/`)
loads the live site. See CLAUDE.md for the web↔mobile parity rules.

---

## 2. HubSpot-as-database (domain model)

All persistence goes through **`lib/hubspot.ts`** (~10k lines). Custom objects are
addressed by numeric **type IDs** from env vars, resolved in `typeIds()` /
`rateCardTypeIds()` (module-private):

| Object | Env var | What it holds |
|---|---|---|
| **Inspection** | `HUBSPOT_INSPECTION_TYPE_ID` | one inspection record (status, templateType, verdict, PDF urls, snapshots) |
| **Question** | `HUBSPOT_INSPECTION_QUESTION_TYPE_ID` | template question definitions |
| **Answer** | `HUBSPOT_INSPECTION_ANSWER_TYPE_ID` | one row per answer; also the Final Checklist blob + rate-card lines |
| **Property** | `HUBSPOT_PROPERTY_TYPE_ID` | the home (address, beds/baths, gas provider, fees, listing refs) |
| **Rate Card Line Item / Region Rate** | `HUBSPOT_RATE_CARD_*_TYPE_ID` | scope catalog + per-region pricing |
| **Community, Listing, Agent, Deals** | `HUBSPOT_*_TYPE_ID` | associations (community walk emails, listing snapshot, 1099 agents) |
| **Service Work Order** | (see `lib/services/`) | recurring service jobs (grass/clean/pool) |

**Patterns that will bite you (all handled in `lib/hubspot.ts`):**
- **Search 400s on an unknown property name** — a filter on a property that isn't
  on the schema throws a swallowed 400 (returns `[]`). Validate names first.
- **PATCH merges** — `updateInspection(id, props)` only touches the props you pass;
  disjoint writes are safe, so best-effort side-writes are split out deliberately.
- **`typeIds()` / `hubspotFetch()` are module-private** — don't try to import them;
  add/extend an exported wrapper instead.
- **Answers persist as JSON blobs** where noted — e.g. the Final Checklist is ONE
  Answer record (`answerIdExternal` `FINALCHECKLIST-<id>`, `questionIdExternal`
  `fc__all`), parsed by `parseFcAnswers()`.

---

## 3. Inspection lifecycle — templateType → form → completion route → email

**This is the table sessions keep rebuilding.** Which client form renders, which API
route completes it, and who gets emailed with the PDF, is decided by `templateType`
in `pages/inspection/[id].tsx` (~line 722).

| templateType | Label | Client form | Completion route | Terminal status flow | Completion email (PDF attached) |
|---|---|---|---|---|---|
| `pm_scope_rate_card` | Scope Rate Card | `RateCardForm` | `POST /submit` → **pending approval**, then approver `POST /finalize` | scheduled → in_progress → **pending_approval** → completed | **Yes** — `finalize.ts` sends via `sendInspectionEmail` (Master + Chargeback + per-vendor PDFs) to **team `team{ST}@resihome.com` + property contacts** |
| `pm_turn_reinspect_qc` | Turn Re-Inspect QC | `QcReinspectForm` | `POST /qc-finalize` (no approval) | in_progress → **completed** | **Yes** — `qc-finalize.ts` → `notifyInspectionCompleted` to the **inspector**, QC report attached (added 2026-07; passes the in-process buffer) |
| `leasing_agent_1099_property_inspection` | Leasing Agent | `QuestionForm` | `POST /submit` (completes) | in_progress → **completed** | **Yes** — sent from **`/api/pdf`** on first PDF (`notifyInspectionCompleted`) to the **inspector** |
| `pm_vacancy_occupancy_check` | Vacancy / Occupancy | `QuestionForm` | `POST /submit` | → **completed** | **Yes** — via `/api/pdf`, inspector |
| `pm_community_inspection` | Community / Visit | `QuestionForm` | `POST /submit` | → **completed** | **Yes** — via `/api/pdf`, inspector |
| `qc_new_construction_rrqc` | New Construction RRQC | `QuestionForm` | `POST /submit` | → **completed** | **Yes** — via `/api/pdf`, inspector **+ community `rrqc_walk_email`** (fail-open) |

**Key nuances:**
- The **non-rate-card completion email is sent from `/api/pdf`**, NOT from `submit.ts`
  — because at submit time the PDF doesn't exist yet. `submit.ts` only re-sends
  (with the existing PDF) on a **reopen → resubmit** where a PDF already exists.
- All `notifyInspectionCompleted` sends are **gated on the inspector's own
  `inspection_completed` toggle** and are **first-completion only** (a reopen →
  re-finalize legitimately re-sends).
- **Scope** is the only type with an **approval step** (pending_approval) and the
  only one that emails a **team distribution** rather than the inspector.

### The completion routes at a glance (`pages/api/inspections/[id]/`)
- **`finalize.ts`** (~1.5k lines, maxDuration 300) — Scope terminal action: renders
  Master + Chargeback + Vendor PDFs, uploads, files HBMM ticket(s), drops chargeback
  xlsx to SFTP, sends the damages email. Has durable cross-instance locks + resume
  stamps (`finalize_email_sent_at`, `hbmm_ticket_id`, …) so a retry can't duplicate
  side effects. Also the **cron/backstop regenerate** entrypoint (CRON-bearer + a
  system session when `regenerateOnly`).
- **`qc-finalize.ts`** (maxDuration 300) — QC terminal action: renders the QC PDF
  (`renderQcPdf`), uploads/attaches, stamps verdict + counts, emails the inspector.
  Rejects an already-completed record (terminal guard) so it only runs once.
- **`submit.ts`** — QuestionForm types complete here; Scope routes to pending_approval
  here. Emits the completion email only in the reopen→resubmit case (see above).
- **`/api/pdf.ts`** (maxDuration 60) — renders the standalone **`InspectionPdf`**
  (`lib/pdf.tsx`) for QuestionForm types AND fires their first-completion email.

---

## 4. Notification triggers (`lib/notifications/triggers.ts`)

Every trigger is **best-effort** (swallows errors), checks the recipient's toggle
(`isNotificationEnabled(email, key)`), and sends via `sendNotificationEmail`
(`lib/notifications/send.ts`). Recipient email doubles as the prefs key.

| Function | Fires when | Recipient | Attachment | Pref key |
|---|---|---|---|---|
| `notifyInspectionCompleted` | inspection completed (QC + QuestionForm types; see §3) | inspector (+ RRQC community email) | report PDF | `inspection_completed` |
| `notifyServiceAssigned` | service assigned/reassigned to a vendor | vendor | — | `service_assigned` |
| `notifyServiceCompleted` | service review decision (approve/modify/reject), OR a bid approved/modified with **finalize=complete** | vendor | vendor service PDF | `service_completed` |
| `notifyServicePastDue` | a service is past due | vendor | — | `service_past_due` |
| `notifyServicesInboxStatus` | service hits **Estimated** or **Review** | `services@resihome.com` (env `SERVICES_ALERTS_INBOX`) | — | (inbox) |
| `notifyVendorPastDueDigest` | daily digest (cron `services-due`) | vendor | — | `service_past_due` |

Scope's damages email is separate: `composeInspectionEmail` (`lib/email.ts`) +
`sendInspectionEmail` (`lib/gmail.ts`), fired from `finalize.ts`.

---

## 5. Services (the "PPW replacement", recurring work orders)

Separate object + flow from inspections. Status enum (`lib/services/model.ts`):
`estimated → assigned → submitted → review → completed` (or `canceled`).

- Forms/logic under `lib/services/` (`worktypes`, `serviceForms`, `model`, `aiReview`).
- Completion PDF: **`lib/servicePdfRender.ts`** → `renderServicePdfBuffer(id, {variant})`
  (`vendor` shows vendor cost; `client` is internal-only). Served by
  `pages/api/services/[id]/pdf.ts` and attached to the `notifyServiceCompleted` email.
- Review decision route: `pages/api/services/[id]/review-decision.ts`.
- Bid items (`is_bid_item=true`, `subtype=bid_item`): vendor-flagged extra work spawned
  at submit (`enrollment_key=bid:<originalId>`, also `generated_by_rule_id=<originalId>`).
  Reviewed via `pages/api/services/[id]/bid-decision.ts` — approve/modify take a
  `finalize`: `assign` → Assigned (+ due date) or `complete` → straight to Completed +
  vendor email (work already done). The service record page shows a **Visit summary**
  (original order + this bid + total; client column internal-only) linking to the original.
- Crons drive generation/review/due (see §7).

---

## 6. PDF render + embed pipeline

**One embed helper, one rule.** Every report downscales photos to embedded JPEG
data URIs through **`lib/pdfImages.ts`**:
- `buildEmbeddedPhotoMap(urls, {deadlineMs?})` → `Record<posterUrl, dataUri>` for the
  inspection renderers.
- `embedPhotoDataUri(url, {edge, quality, deadline})` → single-photo primitive (used
  directly by the service PDF, which embeds 360px vs the inspection 520px).

It provides: a **warm thumbnail cache** (immutable HubSpot files, keyed by url+size),
**retry** over CDN propagation lag, **black/truncated-frame** rejection, and a
**global time budget** (so an upstream photo-CDN blip degrades over-budget photos to
clickable "View photo" links instead of timing the function into a 504). A renderer
only draws `data:` URIs — a missing/failed entry becomes a link (`lib/pdfShared.tsx`).

> There used to be a second, weaker helper (`lib/pdf-images.ts`, no cache/budget). It
> caused a qc-finalize CPU/timeout incident and was **deleted** — do not reintroduce a
> parallel image helper. See §9 naming rule.

| Renderer (`lib/`) | Produces | Called by | Embed source |
|---|---|---|---|
| `pdf.tsx` (`InspectionPdf`) | standalone inspection report | `/api/pdf` | `buildEmbeddedPhotoMap` |
| `pdfMaster.tsx` (`renderMasterPdf`) | Scope Master report | `finalize.ts` | `buildEmbeddedPhotoMap` (as `embeddedPhotoByUrl`) |
| `pdfChargeback.tsx` | Scope tenant chargeback | `finalize.ts` | shared ctx |
| `pdfVendor.tsx` (`renderVendorPdfs`) | per-vendor scope PDFs (2-wide pool) | `finalize.ts` | shared ctx |
| `pdfQc.tsx` (`renderQcPdf`) | Turn Re-Inspect QC report | `qc-finalize.ts`, `regenerate-qc-pdfs` | `buildEmbeddedPhotoMap` |
| `servicePdf.tsx` / `servicePdfRender.ts` | service completion PDF | `services/[id]/pdf`, `notifyServiceCompleted` | `embedPhotoDataUri` (360px) |

Shared bits live in `lib/pdfShared.tsx` (`PdfGalleryBaseProvider`, photo grid,
pagination). **@react-pdf gotcha:** the yoga-layout WASM has a one-time async-init
race — render ONE PDF alone first to warm it, then overlap the rest (see `finalize.ts`).

---

## 7. Cron jobs (`vercel.json` → `pages/api/cron/`)

| Path | Schedule | Purpose |
|---|---|---|
| `sftp-watch` | every min | watch/ingest SFTP |
| `warm-inspections` | every min | cache warmer |
| `notes-inbox` | every min | inbound vendor-note email → service notes |
| `fc-migrate-worker`, `reclaim-photos-worker` | every min | background job drains |
| `ticket-type-sweep` | */2 min | drain the HBMM ticket-enforce / docs queue |
| `finalize-backstop` | */15 min | ensure pending-approval PDFs exist + missing HBMM tickets get created (the incident-recovery swiss-army route) |
| `training-guide-sync` | */10 min | AI training guide sync |
| `insights/rebuild` | */30 min | rebuild insights |
| `report-schedules` | hourly | scheduled report emails |
| `services-leasestart-sync` | hourly | services ↔ lease-start sync |
| `services-generate` / `services-review` / `services-due` | daily (11:00 / 11:30 / 12:00) | generate recurring services, AI review, past-due digest |
| `blob-cleanup` (08:00), `auto-cancel-stale` (09:00) | daily | housekeeping |

Auth: cron routes accept the `CRON_SECRET` bearer; several also accept an app-admin
session so they can be triggered/watched manually.

---

## 8. Big files & where to look (index)

Don't read these whole — jump to the symbol.

| File | Lines | Go here for |
|---|---|---|
| `lib/hubspot.ts` | ~10.4k | ALL HubSpot reads/writes. `typeIds()`, `fetchInspectionWithPropertyRef`, `fetchAnswersForInspection`, `updateInspection`, `searchInspectionsMissingProp`, listing/community/agent lookups |
| `components/RateCardForm.tsx` | ~5.6k | Scope inspection UI + submit/finalize gating, Final Checklist embed, AI review gate |
| `components/QuestionForm.tsx` | ~2.7k | 1099 / Vacancy / Community / RRQC UI; reused Scope FinalChecklist widgets |
| `components/QcReinspectForm.tsx` | ~1.8k | QC before/after UI → `qc-finalize` |
| `pages/api/inspections/[id]/finalize.ts` | ~1.5k | Scope terminal action (PDFs, ticket, xlsx, email, locks, resume) |
| `lib/finalChecklist.ts` | ~790 | Final Checklist spec + gate (`fcQuestionVisible`, `finalChecklistGap`, `fcQuestionGap`) |
| `lib/email.ts` / `lib/gmail.ts` | — | Scope damages email compose + send |
| `lib/notifications/*` | — | all toggle-gated notifications (`triggers.ts`, `send.ts`, `prefs.ts`) |
| `middleware.ts` | — | auth, marketing-vs-app routing, CRON passthrough |

---

## 9. Conventions

- **Naming rule (prevents the `pdfImages` vs `pdf-images` trap):** a module's job is
  named ONCE. Do not create a second file whose name differs from an existing one
  only by case or hyphen/camelCase (`fooBar.ts` vs `foo-bar.ts`), and do not add a
  second helper that does an existing helper's job — extend the canonical one. When
  unsure which is canonical, grep for both and consolidate before adding a caller.
- **Shared helpers — reach for these instead of re-inlining:** `appBaseUrl(req)`
  (`lib/notifications/send.ts`) for the `x-forwarded-host`→origin string;
  `buildShortLink()` (`lib/shortLinks.ts`); `fmtMDY()` for M-D-YY dates; `titleCase()`
  (`lib/titleCase.ts`); `embedPhotoDataUri`/`buildEmbeddedPhotoMap` for PDF photos.
- **Verify before commit:** `npx tsc --noEmit` + `npm run build` (+ `npx vitest run`
  when touching tested lib code). See CLAUDE.md for the git/multi-session rules
  (fetch+rebase before every push; never force-push; ship web work to `main`).
- **Secrets live only in Vercel env**, never in code (see CLAUDE.md). Env groups:
  `HUBSPOT_*` (object type IDs + tuning), `HBMM_*` (HoneyBadger maintenance),
  `GMAIL_*` / `GOOGLE_EXTERNAL_*` (system email + OAuth), `CRON_SECRET`,
  `BLOB_READ_WRITE_TOKEN`, `SESSION_SECRET` (≥32 chars).

---

## 10. Canonical helpers & consolidation backlog

Prefer the canonical helper below over re-inlining. These are the parallel
implementations a dedup audit found — consolidate **opportunistically and per
call-site** (several have subtle behavioral drift; a blind swap can change output
in ways build/tests won't catch), and **don't add new copies**.

| Concern | Canonical | Drift / notes when consolidating |
|---|---|---|
| **M-D-YY date** (`fmtMDY`) | `lib/services/model.ts` (handles ISO + epoch-ms + Date) | Copies differ in the **fallback**: `notifications/triggers.ts` returns `—` on empty; `insightsBilling.ts` passes the original string through. Preserve each caller's intended empty-state before swapping. |
| **add days to YYYY-MM-DD** (`addDaysISO`) | `lib/services/time.ts` | ✅ Consolidated (was duplicated byte-for-byte in `reportSchedules.ts`). |
| **USD money** | `lib/photoUpload.ts` `formatMoney` (client) / `lib/pdfShared.tsx` `formatMoneyPdf` (PDF) | Re-declared ~12× (`email.ts`, `servicePdfRender.ts`, slack, ai-review, admin…). **Signatures differ**: some add `$`, `formatMoneyPdf` does not; some take `any` + guard NaN, others take `number`. Not a blind swap. `InspectionCard`/`insightsMetrics` use a 0-decimal currency variant — genuinely different, leave alone. |
| **request origin / baseUrl** | `lib/appUrl.ts` `reqOriginOf(req)` (also `appBaseUrl` in `lib/notifications/send.ts`) | The `x-forwarded-proto/host → origin` pattern is hand-rolled in 20+ handlers (`pdf.ts`, `finalize.ts`, `submit.ts`, `qc-finalize.ts`, admin/cron workers…). Mostly a mechanical replace. |
| **split URL list** (`splitUrls`) | (pick one → `lib/dates.ts`/`lib/format.ts` when created) | 5 copies with **drifting delimiters/validation** (`[\n,]+` + http-check vs no check vs `[,;]` in `hubspot.ts`). Real bug risk — some let non-URLs through. |
| **titleCase** | `lib/titleCase.ts` (minor-word + acronym aware) | `reportSchedules.ts` + `AiReviewModal.tsx` use weaker variants that mangle acronyms; `sections.ts titleCaseSectionName` is its own rule. |
| **photo downscale to JPEG** | `lib/pdfImages.ts` `embedPhotoDataUri` / `buildEmbeddedPhotoMap` | The AI-review + proof-extract paths (`services/aiReview.ts`, `inspections/[id]/ai-review.ts`, `services/proofExtract.ts`) re-roll `sharp().rotate().resize().jpeg()` (quality 60 vs 70). A shared `downscaleToJpeg(buf,{edge,quality})` would unify them. |
| **rekey temp→real inspection id** | 3 stores by design (`offlinePhotoStore`, `offlineOutbox`, `photoAttachOutbox`) | Same name/signature across 3 durable queues — a caller can update one and forget the others. Consider one orchestrator that fans out. |
| **templateType classification** | (centralize `isRateCard()`/`isQc()`/`FC_TEMPLATES` in `lib/templateLabels.ts`) | `=== 'pm_scope_rate_card'` / `=== 'pm_turn_reinspect_qc'` recur inline across routes; `FC_TEMPLATES` is an ad-hoc local `Set` in `submit.ts`. |

Deliberately **not** duplicates (don't chase): `CameraCapture{,Legacy,Modern}`
(platform fork), server/client halves (`*Reporter`, `aiFeedback*`), `servicePdf.tsx`
(component) vs `servicePdfRender.ts` (renderer), `pushSender`/`fcmSender`/`pushClient`
(distinct transports), `aiReview.ts` vs `services/aiReview.ts` (different domains).
