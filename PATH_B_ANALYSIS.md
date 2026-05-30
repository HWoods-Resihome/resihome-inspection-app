# Path B Migration Analysis — Offline-Capable Capacitor Client

**Repo:** `resihome-inspection-app` (v0.21.0) · Next.js 14.2.35, Pages Router
**Goal:** Split the app so the inspection **capture** flow runs fully offline inside a
Capacitor native shell (iOS/Android), syncing to the existing Vercel/HubSpot backend on
reconnect.
**Scope of this document:** Read-only diagnosis + plan. No application code, config, env, or
HubSpot schema was changed in producing it. This is the only file written.

> Note: this report is a planning artifact. Where it says "change X", that is a
> recommendation for a *future* implementation phase, not something done here.

---

## PHASE 1 — Current Architecture Inventory

### 1.1 Router type & route list
**Pages Router** (`pages/`). No `app/` directory. No `getServerSideProps`,
`getStaticProps`, or `getInitialProps` anywhere in `pages/` — every page is a
client component that fetches its data at runtime via `fetch()`.

**Page routes (4 user-facing):**
| Route | File | Rendering | Data fetch |
| --- | --- | --- | --- |
| `/` (home) | `pages/index.tsx` | Client | `useEffect` → `fetch` (6 calls: inspections list, users, bulk-cancel, etc.) |
| `/login` | `pages/login.tsx` | Client | 1 `fetch` (`/api/auth/login`) then full-page redirect to Google |
| `/inspection/new` | `pages/inspection/new.tsx` | Client | 9 `fetch` (properties, questions, regions, create…) |
| `/inspection/[id]` | `pages/inspection/[id].tsx` | Client (dynamic param) | 7 `fetch` (inspection, answers, questions, qc-data, finalize…) |

Plus `pages/_app.tsx` (wraps `ErrorBoundary` + `AppDialogProvider` + global viewport) and
`pages/_document.tsx`.

**API routes (28):** see §1.3.

### 1.2 Page classification
All four pages are **client-rendered, no server data at render time**. This is the single
most important finding for static export: the UI layer is already a SPA in disguise — it
talks to the backend exclusively through `/api/*` calls from the browser. The only thing
standing between today's app and a static bundle is (a) `middleware.ts`, (b) the co-located
`/api` routes, and (c) the default `next/image` loader (not used — the app uses raw `<img>`
everywhere; confirmed no `next/image` imports).

### 1.3 API route inventory (purpose · HubSpot objects · server libs)

Legend for objects: **I**=inspection, **A**=inspection_answer, **Q**=inspection_question,
**RCLI**=rate_card_line_item, **RR**=region_rate, **P**=property, **U**=HubSpot users,
**F**=HubSpot Files.

| Route | Purpose | R/W objects | Server libs |
| --- | --- | --- | --- |
| `auth/login` | Validate email is an active HubSpot user (no session minted) | U (r) | hubspot |
| `auth/google-login` | Pre-auth: re-validate user, redirect to Google consent | U (r) | gmailAuth, hubspot |
| `auth/gmail/callback` | OAuth callback; LOGIN flow mints 30-day session, CONNECT flow stores Gmail token | U (r) | auth, gmailAuth, hubspot |
| `auth/gmail/connect` | Start Gmail-send OAuth (needs session) | — | auth, gmailAuth |
| `auth/gmail/status` | Report whether Gmail is connected | — | auth, gmailAuth |
| `auth/logout` | Clear session cookie | — | auth |
| `auth/me` | Return current session user | — | auth |
| `users` | List HubSpot users | U (r) | auth, hubspot |
| `properties` | List properties | P (r) | auth, hubspot |
| `properties/[id]/rate-card-inspections` | Source Scope cards for a property (QC picker) | I (r) | auth, hubspot |
| `questions` | Question template for a template type | Q (r) | auth, hubspot |
| `rate-card/catalog` | 853-row line-item catalog (cached 60 min) | RCLI (r) | auth, hubspot |
| `rate-card/regions` | Region rate matrix (cached) | RR (r) | auth, hubspot |
| `inspections` | List inspections (home) | I (r) | auth, hubspot |
| `inspections/create` | Create scheduled inspection (+ copy QC lines) | I (w), A (w), P (r) | auth, hubspot |
| `inspections/[id]/index` | GET inspection + all its answers (via associations) | I (r), A (r) | auth, hubspot |
| `inspections/[id]/answers` | Upsert/archive answers (autosave target) | A (w), I (w) | auth, hubspot |
| `inspections/[id]/rate-card-lines` | Upsert Scope line answers w/ server-side calc | A (w), RCLI (r), RR (r) | auth, hubspot |
| `inspections/[id]/qc-data` | QC copied lines enriched from catalog + after-photos | A (r), RCLI (r) | auth, hubspot |
| `inspections/[id]/submit` | Mark question-form inspection complete | I (w) | auth, hubspot |
| `inspections/[id]/finalize` | **Scope finalize**: 4 PDFs + xlsx, upload, attach, email | I (w), A (r), RCLI (r), RR (r), F (w) | auth, hubspot, pdfMaster, pdfVendor, pdfChargeback, pdfShared, xlsxChargeback, email, gmail |
| `inspections/[id]/qc-finalize` | **QC finalize**: QC PDF, upload, attach, complete | I (w), A (r), F (w) | auth, hubspot, pdfQc, pdf-images |
| `inspections/[id]/reopen` | Set status back to `in_progress` | I (w) | auth, hubspot |
| `inspections/[id]/cancel` | Mark inspection cancelled | I (w) | auth, hubspot |
| `inspections/bulk-cancel` | Cancel many (concurrency 5) | I (w) | auth, hubspot |
| `pdf` | Question-form PDF: render, upload, patch URL, attach | I (w), A (r), F (w) | auth, hubspot, pdf, pdf-images |
| `upload` | Receive base64 image, push to HubSpot Files | F (w) | auth, hubspot |

### 1.4 Server-only dependency usage map
| Dependency | Where used | Nature |
| --- | --- | --- |
| `sharp` | `lib/pdf-images.ts` (image fetch/normalize for PDFs) | Native binary — **server only**, cannot run in browser/Capacitor webview |
| `@react-pdf/renderer` | `lib/pdf.tsx`, `pdfMaster`, `pdfVendor`, `pdfChargeback`, `pdfQc`, `pdfShared`, `pages/api/pdf.ts` | Heavy; runs in Node on the server today |
| `exceljs` | `lib/xlsxChargeback.ts` (tenant chargeback importer) | Server only |
| `jose` | `lib/auth.ts` (sign/verify JWT), `middleware.ts` (verify) | Sign = server. Verify could run client-side but secret must stay server |
| `cookie` | `lib/auth.ts`, `lib/gmail*.ts`, all `auth/*` routes, `middleware.ts` | HTTP cookie serialize/parse — server |
| `browser-image-compression` | `lib/photoUpload.ts` | **Client only** — this is the one browser dep, on the photo path |

### 1.5 Auth flow (end to end)
1. `/login` (client) posts email to `/api/auth/login`. That route only **validates** the
   email is an active HubSpot user via `fetchUsers()`; it does **not** mint a session.
   Returns `{ ok, next: 'google', email }`.
2. Client does a full-page redirect to `/api/auth/google-login?email=…`. That route
   re-validates the email server-side, packs a CSRF token + claimed email into the OAuth
   `state`, sets a short-lived `resihome_login_oauth_state` cookie, and 302s to Google.
3. Google returns to `/api/auth/gmail/callback`. Presence of the login-state cookie selects
   the **LOGIN** branch: it exchanges the code, decodes the verified email from the Google
   `id_token` (`emailFromIdToken`), confirms it matches the claimed email, re-confirms the
   HubSpot user, then mints the session.
4. **Session** = HTTP-only cookie `resihome_session` containing a `jose` HS256 JWT
   `{ userId, email, name, exp }`, signed with `SESSION_SECRET` (≥32 chars).
   **Lifetime: 30 days** (`SESSION_DURATION_HOURS = 24 * 30`, `lib/auth.ts`).
5. `middleware.ts` verifies the JWT on every non-public request (`jwtVerify`), redirecting
   browser routes to `/login` and returning 401 for `/api/*`. API routes additionally call
   `getSessionFromRequest()` / `requireSession()` as a backstop.

### 1.6 HubSpot data layer
- **Wrapper:** `lib/hubspot.ts` (~1660 lines). Single private `hubspotFetch(path, init)` helper
  → `https://api.hubapi.com`, `Authorization: Bearer ${token()}`, with 429 backoff retry
  (`BACKOFFS_MS`). API version pinned: `HUBSPOT_API_VERSION = '2026-03'` for the dated
  association endpoints.
- **Token/env:** `HUBSPOT_SANDBOX_TOKEN` (PAT). Object type IDs from env:
  `HUBSPOT_INSPECTION_TYPE_ID`, `HUBSPOT_INSPECTION_QUESTION_TYPE_ID`,
  `HUBSPOT_INSPECTION_ANSWER_TYPE_ID`, `HUBSPOT_PROPERTY_TYPE_ID`,
  `HUBSPOT_RATE_CARD_LINE_ITEM_TYPE_ID`, `HUBSPOT_REGION_RATE_TYPE_ID` (latter two also
  discoverable via `/crm/v3/schemas`).
- **Reads by object:**
  - **inspection:** `fetchInspections`, `fetchInspectionById`, `fetchInspectionWithPropertyRef`, `fetchSourceRateCardInspections`, `fetchPropertyRegion`
  - **inspection_answer:** `fetchAnswersForInspection` (association batch-read → property batch-read), `fetchSourceSectionPhotos`
  - **inspection_question:** `fetchQuestionsForTemplate`
  - **rate_card_line_item:** `fetchRateCardCatalog` (853 rows, paged), `fetchRateCardLineItemByCode`
  - **region_rate:** `fetchRegionRates` (18 rows)
  - **property:** `fetchProperties`, `fetchPropertyRegion`
  - **users:** `fetchUsers`
- **Writes by object:**
  - **inspection:** `createScheduledInspection`, `updateInspection`, `submitInspection`, `attachPdfUrlToInspection`
  - **inspection_answer:** `upsertAnswers` (upsert-by-`answer_id_external` natural key), `archiveAnswers`, `copyRateCardLinesToQc`
  - **Files:** `uploadFile`, `uploadFileWithId`, `attachFilesToInspectionRecord` (note + `hs_attachment_ids` + association)
- **Idempotency pattern (critical for sync):** answers upsert by a **deterministic natural
  key** `answer_id_external` (`useAutosave.buildAnswerExternalId` →
  `${inspectionExternalId}_${questionId}__${instanceKey}`). Re-sending the same answer
  updates rather than duplicates. This is the foundation Path B sync will reuse.

### 1.7 Finalize pipeline (Scope — the heaviest)
`pages/api/inspections/[id]/finalize.ts` (maxDuration 60s):
- **Inputs:** inspection record id; pulls inspection + answers + catalog + region rates.
- **Server steps:** recompute totals (server-authoritative), build address/filenames, render
  **Master PDF** (`pdfMaster`), **Tenant Chargeback PDF** (`pdfChargeback`), **per-Vendor PDFs**
  (`pdfVendor`, one per assigned vendor), **Tenant Chargeback xlsx** (`xlsxChargeback`,
  importer file — only if chargeback lines exist). Upload each via `uploadFileWithId` to the
  `/inspection_pdfs` Files folder, attach all to the record's Attachments
  (`attachFilesToInspectionRecord`), patch URL props on the inspection
  (`pdf_master_url`, `pdf_chargeback_url`, `pdf_vendor_urls_json`, `pdf_zip_url`,
  `pdf_chargeback_xlsx_url`, `pdf_generated_at`), and (optionally) email via `lib/email.ts` +
  `lib/gmail.ts`.
- **Outputs/stored:** HubSpot Files (PDFs + xlsx) + URL properties on the inspection record +
  Attachments-card associations. The "ZIP bundle" is referenced in props
  (`pdf_zip_url`) and assembled in the finalize/backfill path.
- **QC finalize** (`qc-finalize.ts`, now 60s) and **question-form PDF** (`pdf.ts`, now 60s after
  v0.20.9) are lighter single-PDF variants of the same render→upload→attach→patch shape.

### 1.8 Client capture & photo path
- Capture UI: `RateCardForm` (Scope lines + section photos), `QuestionForm` + `QuestionItem`
  (Q&A + per-question + section photos), `QcReinspectForm` (before/after + pass/fail),
  `CameraCapture` (in-app getUserMedia camera w/ torch + native `<input capture>` fallback),
  `PhotoStrip` (shared single-line scrolling collapsible photo strip).
- Photo path (`lib/photoUpload.ts`): compress with `browser-image-compression`
  (~600 KB / 1280 px target) → canvas downscale fallback → base64 → `POST /api/upload`
  → HubSpot Files → returns a CDN URL stored in the answer's `photo_urls`.
- Autosave: `lib/useAutosave.ts` (Q&A) and `lib/useRateCardAutosave.ts` (lines) — debounced,
  dirty-tracked, natural-key upsert, archive queue for cleared answers.

### 1.9 `next.config.js` (verbatim)
```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};
module.exports = nextConfig;
```
**No** `output: 'export'`, no custom image loader, no rewrites/redirects, no `basePath`. A
near-empty config — favorable. For Path B the capture client needs `output: 'export'` +
`images.unoptimized` (latter is moot since `next/image` isn't used) + a Capacitor `webDir`.

---

## PHASE 2 — Offline Classification

| Data interaction | Class | Rationale (from code) |
| --- | --- | --- |
| Rate-card catalog (853 rows) | **A — cache** | `fetchRateCardCatalog`, already cached 60 min server-side; changes rarely |
| Region rates (18 rows) | **A — cache** | `fetchRegionRates`, cached; pricing matrix, rarely changes |
| Question templates | **A — cache** | `fetchQuestionsForTemplate`, per template type, static between deploys |
| Section lists (`section_list_json` defaults) | **A — cache** | `lib/sections.ts`; template-driven |
| Properties list | **A — cache** | `fetchProperties`; changes occasionally — cache w/ periodic refresh |
| Users list | **A — cache** | `fetchUsers`; for assignment dropdowns |
| Create inspection | **B — local-first + outbox** | `createScheduledInspection`; assign local UUID = `inspection_id_external` |
| Upsert answers (Q&A + lines) | **B — local-first + outbox** | `upsertAnswers` already idempotent by `answer_id_external` |
| Archive answers | **B — outbox** | `archiveAnswers`; queue deletions, replay on sync |
| Photos | **B — local file + outbox** | store blob locally; upload via `/api/upload` on reconnect, then patch `photo_urls` |
| Submit / reopen / cancel / bulk-cancel (status) | **B — outbox** | status transitions; replay after writes land |
| Auth issuance (login, Google, JWT mint) | **C — online only** | `jose` signing + Google OAuth need network + `SESSION_SECRET` |
| All PDF/xlsx/finalize | **C — online only** | `sharp` (native), `@react-pdf/renderer`, `exceljs` — server only |
| HubSpot Files upload | **C — online only** (queued) | `/api/upload`; needs PAT, runs server-side |

Matches the brief's expectations: catalog/regions/templates/sections = A;
inspection/answer/photo writes = B; auth + PDF/xlsx/finalize = C.

---

## PHASE 3 — Static-Export Blockers (capture client)

The capture client must become a static SPA (`output: 'export'`). Blockers and required
changes:

| Blocker | Where | Required change |
| --- | --- | --- |
| `middleware.ts` (JWT gate) | root | `output: 'export'` does not support middleware. Move the auth gate **into the client** (route guard component that checks a cached session) and keep server-side verification only on the Vercel API tier. |
| Co-located `/api/*` routes | `pages/api/**` | Static export drops API routes. **Split**: API routes stay on Vercel as the backend; the exported client calls them by absolute URL (`NEXT_PUBLIC_API_BASE`). |
| Dynamic route `/inspection/[id]` | `pages/inspection/[id].tsx` | Static export needs `getStaticPaths` or a fallback. Simplest: switch the capture client to **client-side routing** (hash or query param `?id=`) so no per-id HTML is prerendered. |
| `next/image` default loader | — | **Not a blocker** — app uses raw `<img>`. (If ever added, set `images.unoptimized: true`.) |
| Server-read runtime env in pages | pages read none directly | **Not a blocker** — pages use only `NEXT_PUBLIC_*` at most. All secret env stays on the Vercel API tier. |
| `rewrites`/`redirects` | none | n/a |
| SSR (`getServerSideProps`) | none | n/a — already all client fetch |

**Net:** the capture client is unusually close to exportable already. The real work is the
**split** (client ↔ remote API) and replacing middleware-based gating with client-side
gating, not rewriting pages.

---

## PHASE 4 — Target Path B Architecture (design only)

### 4.1 Frontend/backend split
- **Bundled static Capacitor client** (the capture flow): `/`, `/inspection/new`,
  `/inspection/[id]` (as client-routed), `/login` (online-only gate). Reads reference caches
  from local SQLite; writes inspections/answers/photos local-first to SQLite + outbox.
- **Stays as Vercel API functions** (unchanged backend): all `/api/auth/*`, all HubSpot
  reads/writes, `/api/upload`, `/api/pdf`, `/api/inspections/[id]/finalize`,
  `/api/inspections/[id]/qc-finalize`. These are the **C** operations. The client calls them
  over HTTPS with the cached JWT in an `Authorization: Bearer` header (cookie→header change
  needed; see 4.4).

### 4.2 Local persistence schema (SQLite, mirrors HubSpot natural keys)
```
inspections(
  inspection_id_external TEXT PK,   -- = HubSpot natural key (generated locally on create)
  hubspot_record_id TEXT NULL,      -- filled after first sync
  template_type, property_ref, property_address_snapshot,
  region_snapshot TEXT,             -- captured at create (see 4.x; mirrors current behavior)
  status TEXT,                      -- local lifecycle (see 4.5)
  payload_json TEXT,                -- denormalized misc fields
  updated_at, synced_at
)
inspection_answers(
  answer_id_external TEXT PK,       -- = ${inspectionExternalId}_${qId}__${instanceKey}
  inspection_id_external TEXT FK,
  hubspot_record_id TEXT NULL,
  answer_type TEXT,                 -- 'qa' | 'rate_card_line' | 'section_photo'
  section, location, answer_value, note, quantity, assigned_to,
  rate_card_fields_json TEXT,       -- code, qty_decimal, tenant_pct, custom_*, computed totals
  photo_local_ids TEXT,             -- JSON array of local photo ids
  dirty INTEGER, archived INTEGER, updated_at, synced_at
)
photos(
  local_id TEXT PK, inspection_id_external FK, answer_id_external FK NULL,
  file_path TEXT,                   -- Capacitor Filesystem path
  hubspot_url TEXT NULL,            -- filled after upload
  uploaded INTEGER, updated_at
)
ref_catalog(line_item_code PK, json TEXT, version, fetched_at)
ref_regions(region PK, json TEXT, fetched_at)
ref_questions(template_type, question_id_external, json TEXT, PRIMARY KEY(template_type, question_id_external))
ref_properties(property_id PK, json TEXT, fetched_at)
ref_users(user_id PK, json TEXT, fetched_at)
outbox(
  id INTEGER PK AUTOINCREMENT, op TEXT,  -- 'create_inspection'|'upsert_answers'|'archive_answers'|'upload_photo'|'submit'|'reopen'|'cancel'
  entity_key TEXT, payload_json TEXT, attempts INTEGER, next_attempt_at, created_at
)
```
Keying every table by the **HubSpot natural key** means the existing
`upsert-by-natural-key` idempotency in `upsertAnswers`/`createScheduledInspection` is reused
verbatim — sync just replays writes and they converge.

### 4.3 Outbox / sync engine
- **Connectivity:** Capacitor `@capacitor/network` for online/offline events; flush on
  regain + on app foreground + periodic.
- **Flush ordering (respects associations):** `create_inspection` → `upload_photo` (get
  HubSpot URLs) → `upsert_answers` (with resolved photo URLs) → `archive_answers` →
  status ops (`submit`/`reopen`/`cancel`). Never send an answer before its inspection exists
  server-side.
- **Retry/backoff:** per-outbox-row `attempts` + `next_attempt_at` exponential backoff;
  mirror the existing `BACKOFFS_MS` 429 handling already in `hubspotFetch`.
- **Idempotency:** natural keys make replays safe; a partially-synced batch re-runs cleanly.
- **Large photos:** stored as files via `@capacitor/filesystem`, uploaded one/two at a time
  (mirror `photoUpload` concurrency=2), compressed **on device** before queueing so the
  outbox holds small blobs.

### 4.4 Offline auth strategy
- **Online-only issuance** (Phase C op): login + Google + JWT mint must happen online.
- After login, **cache the JWT securely** (`@capacitor-community/secure-storage` / Keychain /
  Keystore). The client sends it as `Authorization: Bearer <jwt>` to the Vercel API.
  **Required backend change:** API routes currently read the session from the **cookie**
  (`getSessionFromRequest` reads `req.headers.cookie`). Add acceptance of a `Bearer` header
  so the native client (no cookie jar semantics) can authenticate. Keep cookie path for web.
- **Offline:** allow capture if a **non-expired** cached JWT exists (verify `exp` locally; no
  secret needed to read claims, though signature can't be re-verified offline — acceptable
  because the server re-verifies on every sync call). 30-day lifetime already supports long
  field stints.
- **On reconnect:** if JWT expired, block sync + prompt re-login; local captured data stays
  queued and flushes after re-auth.
- **Permitted offline:** all capture/edit. **Blocked offline:** login, finalize, PDF, email.

### 4.5 Finalize/PDF + record state machine
Finalize stays **online-only** (sharp/react-pdf/exceljs). Design a "queue finalize on
reconnect" UX: the inspector taps Submit offline → record enters `pending sync`; once synced
the user (or an auto-step) triggers finalize online.

```
local draft ──(submit offline)──▶ pending sync ──(outbox flush ok)──▶ synced
   synced ──(user taps Finalize, online)──▶ pending finalize ──(finalize API ok)──▶ finalized
   finalized ──(reopen)──▶ synced            (any state) ──(cancel)──▶ cancelled
```
Finalize/PDF buttons are **disabled offline** with a clear "available when online" state.

### 4.6 Capacitor integration
- `webDir`: the Next static export output (`out/`).
- `next.config`: `output: 'export'`, `images.unoptimized: true`, `trailingSlash: true`
  (Capacitor file serving likes trailing slashes), client-side routing for `[id]`.
- **Plugins:** `@capacitor/network` (connectivity), `@capacitor/filesystem` (photo blobs),
  `@capacitor/camera` (native camera; complements existing `getUserMedia`),
  `@capacitor/geolocation` (optional capture metadata),
  `@capacitor-community/sqlite` (local DB), secure storage for the JWT, optional
  `@capacitor/app` (foreground events for sync), optional Live Updates/OTA (e.g. Capgo) for
  shipping web fixes without store review.
- **Dev/build/deploy:** `next build && next export` → `npx cap sync` → open Xcode/Android
  Studio → archive/upload. CI can automate the web build + `cap sync`; native signing stays
  in the platform toolchains.

---

## PHASE 5 — Functionality Preservation Matrix

| Feature | Lands | Risk |
| --- | --- | --- |
| (PM) Scope Rate Card capture | Offline-capable (B) | Med — line calc must run **client-side offline** (see §6) |
| (PM) Turn Re-Inspect QC capture | Offline-capable (B) | Med — needs source Scope lines cached at create time (QC copies lines) |
| (PM) Community / Visit, Vacancy/Occupancy, (1099) Leasing Agent, New Construction RRQC | Offline-capable (B) | Low — pure Q&A + section photos |
| Rate-card line entry incl. **bid-item / custom-price overrides** | Offline-capable (B) | Med — `customVendorCost`/bid-item logic currently in `rateCardMath.ts` (shared) must be bundled client-side |
| Region snapshotting + line calc formula (`client = vendor×1.20`, `tenant = client×pct/100`, `FALLBACK_REGION_KEY='GA: Atlanta'`) | Offline-capable (B) | **High** — today `rate-card-lines` recomputes **server-side authoritatively**; offline needs the same math on device, then server re-validates on sync |
| Section customization (`section_list_json`) | Offline-capable (B) | Low — store JSON locally |
| Photos (capture, compress, attach) | Offline-capable (B) | Med — local store + deferred upload + URL backfill into answers |
| Master / Tenant / per-Vendor PDFs | Online-only (C) | Low — unchanged server path |
| Tenant Chargeback xlsx | Online-only (C) | Low — unchanged |
| ZIP bundle | Online-only (C) | Low — unchanged |
| Email send (finalize) | Online-only (C) | Low — unchanged |
| Auth (login, Google verify, 30-day session) | Online-only issuance; offline use of cached JWT | Med — cookie→Bearer acceptance needed |

Nothing is dropped. The split is: **capture = offline**, **finalize/PDF/xlsx/email/auth-issuance = online**.

---

## PHASE 6 — Risk Register + Effort

Ranked highest-risk first.

1. **Client-side rate-card math parity (HIGH risk, M effort).** `rateCardMath.ts` is already a
   pure, server-shared module — good — but today the **authoritative** numbers come from
   `rate-card-lines.ts` on the server. Offline must compute on device and the server must
   re-validate identically on sync. Risk: silent drift between device and server totals.
   Mitigation: server remains source of truth on sync; device numbers are provisional and
   reconciled.
2. **Auth cookie→Bearer + offline session (MED risk, M effort).** Backend must accept a
   `Bearer` JWT in addition to the cookie; client must store/refresh it securely. Risk:
   weakening the auth model if done carelessly.
3. **Sync engine correctness (MED–HIGH risk, L effort).** Ordering, idempotency, partial
   failure, photo backfill into answers. The natural-key idempotency de-risks this
   substantially, but it's the largest net-new subsystem.
4. **SQLite schema + migrations on device (MED risk, M effort).** New persistence layer;
   needs versioned migrations.
5. **Static export split (LOW–MED risk, M effort).** Mechanical: move middleware gating
   client-side, point client at `NEXT_PUBLIC_API_BASE`, client-route `[id]`. Low logic risk
   because pages already fetch everything at runtime.
6. **Capacitor shell + plugins + store signing (LOW risk, M effort).** Well-trodden; effort
   is in provisioning/signing/store setup, not logic.
7. **Photo storage on device (LOW–MED risk, S–M effort).** Filesystem plugin + compress on
   device (already compress in browser today).

---

## PHASE 7 — Path C Staging (actionable roadmap)

**Stage 0 — v1 Capacitor wrapper, ONLINE-ONLY (ship first).**
Wrap the **existing live Vercel app** in a Capacitor shell that loads the production URL in a
webview. No offline, no SQLite, no split. This gets the app into the App Store / Play Store
immediately and validates native packaging, signing, camera permissions, and store review —
with **zero changes to app logic**. (This is also the lowest-risk way to get off the Safe
Browsing-flagged domain concern for end users, since the native shell doesn't show a browser
warning bar.) Add the deep-link/redirect handling for the Google OAuth round-trip in a
webview (the one integration wrinkle to verify here).

**Stage 1 — Split the client from the API.**
Introduce `NEXT_PUBLIC_API_BASE`; make all client `fetch` calls absolute to the Vercel API.
Move auth gating from `middleware.ts` into a client route guard. Add `Bearer`-header
acceptance to the API tier (keep cookies for web). Still online; still one codebase.

**Stage 2 — Reference caching (Class A) offline-readable.**
Add SQLite + cache catalog/regions/questions/sections/properties/users locally with periodic
refresh. Capture forms read from cache. Inspector can *open* and *navigate* forms offline;
writes still require online. Low risk, immediately useful on flaky LTE.

**Stage 3 — Local-first capture writes (Class B) + outbox.**
Inspections/answers/photos write to SQLite first; outbox flushes on reconnect using the
existing natural-key upserts. Implement the state machine (§4.5) and photo backfill. This is
the core of Path B.

**Stage 4 — Offline auth + finalize-on-reconnect UX.**
Cache JWT securely, allow offline capture under a valid token, block + queue finalize/PDF
until online. Polish connectivity indicators and conflict/error surfacing.

**Stage 5 — Hardening + OTA.**
Add Live Updates/OTA for web-layer fixes without store review, telemetry on sync
success/failure, and a "stuck outbox" recovery UI.

Each stage is independently shippable and de-risks the next. Stage 0 delivers store presence
in days; Stages 2–4 deliver true offline incrementally.

---

## Appendix — Key file references
- Config: `next.config.js`, `vercel.json` (function `maxDuration`: finalize/qc-finalize/pdf = 60s), `middleware.ts`
- Auth: `lib/auth.ts`, `lib/gmailAuth.ts`, `pages/api/auth/*`
- HubSpot layer: `lib/hubspot.ts` (single wrapper; natural-key upserts)
- Math (offline-critical): `lib/rateCardMath.ts` (`MARKUP_MULTIPLIER=1.20`, `FALLBACK_REGION_KEY='GA: Atlanta'`)
- Autosave (sync model precedent): `lib/useAutosave.ts`, `lib/useRateCardAutosave.ts`
- Photo path (offline-critical): `lib/photoUpload.ts`, `components/CameraCapture.tsx`, `components/PhotoStrip.tsx`
- Finalize (online-only): `pages/api/inspections/[id]/finalize.ts`, `qc-finalize.ts`, `pages/api/pdf.ts`, `lib/pdf*.tsx`, `lib/xlsxChargeback.ts`, `lib/pdf-images.ts` (`sharp`)
- Capture forms: `components/RateCardForm.tsx`, `components/QuestionForm.tsx`, `components/QcReinspectForm.tsx`
