# ResiWalk - Services — HubSpot schema (Phase 0)

Living checklist for the "Make it Live" schema. Source of truth is
`lib/services/schemaSpec.ts`; the provisioner is `provisionServicesSchema()` in
`lib/hubspot.ts`, exposed at `/api/services/admin/provision`. Additive-only —
never touches inspection data. Object/property names are neutral (`service_*`);
the internal codename appears in no created artifact.

## Run it (admin-gated; PROD HubSpot via the preview)
- **Dry-run (read-only):** `https://ppw.resiwalk.com/api/services/admin/provision`
- **Apply (creates schema):** `https://ppw.resiwalk.com/api/services/admin/provision?apply=1`

Dry-run diffs the spec against HubSpot and reports what it *would* create. Apply
is idempotent — re-running skips anything that already exists. Both return JSON:
`{ mode, objects[], questionAdditions[], associations[], envVars{}, notes[] }`.

## After apply — set env vars
Apply returns the created `objectTypeId`s in `envVars`. Set them in Vercel
(Preview **and** Production) and redeploy so the app resolves the objects:
- `HUBSPOT_SERVICE_TYPE_ID`
- `HUBSPOT_SERVICE_RULE_TYPE_ID`

## Objects
### Service Work Order (`service_work_order`)
Primary display `service_name`. Fields: worktype, subtype, status, is_bid_item,
scope, service_description, due_date, region_snapshot, vendor_cost, markup_pct,
client_cost, vendor_cost_adjustment (+reason), vendor_name, generated_by_rule_id,
enrollment_key, pet_stations, property_id_ref, community_id_ref, submitted_at,
ai_verdict, ai_notes, completed_at, ontime, before_photo_urls, after_photo_urls.

### Service Rules Engine (`service_rule`)
Primary display `rule_name`. Fields: active, worktype, subtype, scope,
pet_stations, props_mode, vendor_cost, markup_pct, vendors_json,
service_description, recurring, cadences_json, initial_due_days, skip_months_json,
included_props_json, enroll_field/op/value, stop_enabled, stop_mode,
stop_field/op/value, stop_date, stop_count.

### Reused Question object — additive properties
`service_worktype`, `service_subtype`, `choice_price_json`, `trigger_json`.

### Associations (labeled, v4)
service → property · community · company(vendor) · service_rule;
service_rule → property · community · company(vendor).

## Dropdowns (enum options)
- **Work Type:** Landscaping, Cleaning, Pools, Trash Removal, Trip Fee
- **Subtype:** Grass Cut, Flowers, Tree Trimming, Mulch / Pine Straw, Common Area,
  Model Home, Move-In Clean, Vacant Clean, One-Time Clean, On-Market Clean,
  Pool Cleaning, Trash Pickup, Base Trip Fee
- **Status:** Estimated, Assigned, Submitted, Review, Completed, Canceled
  (AI Processing is a **tag on Submitted**, not a status — a submitted service stays
  Submitted while the AI reviews, then moves to Completed or Review. The `ai_processing`
  option created earlier in HubSpot is now unused and can be removed manually.)
- **Coverage Scope:** Property, Community · **Property Mode:** All, List
- **AI Verdict:** Clean, Needs Review · **Stop Mode:** Condition, Date, Count
- **Operators:** is, is any of, is not, changes to

## Re-apply for later-added properties
The spec has grown since the first apply — re-run `?apply=1` to add these (idempotent;
everything else reports `exists`):
- **Service Work Order** snapshots: `address_snapshot`, `locality_snapshot`,
  `community_name`, `property_status_snapshot`, `latitude`, `longitude`, `vendor_email`
- **Service Work Order** completion (Phase 4): `pet_before_photo_urls`,
  `pet_after_photo_urls`, `answers_json`
- **Service Work Order** review decision: `review_decision`, `review_notes`,
  `reviewed_by`, `reviewed_at` (reuses `vendor_cost_adjustment` + `_reason`)
- **Service Rules Engine** coverage: `portfolios_json`, `communities_json`, `regions_json`

## Live coverage data (rules engine + create service)
Coverage options are read LIVE from the real objects — new portfolios, regions,
communities, and properties appear automatically:
- **Portfolios / regions** — scanned from the Property object (`portfolio`, `region`),
  served at `/api/services/coverage` (10-min in-process cache; these lists rarely change).
- **Communities** — the Community object (`2-56454860`, name `community_name`),
  served at `/api/services/communities` (no cache).
- **Property drill-down / create-service search** — live Property Search
  (`/api/services/properties`, `/api/properties?q=`), never pre-loaded (15k+ records).
- Discovery (read-only): `/api/services/admin/inspect-properties` (field catalog +
  distinct values; `?fields=a,b&catalog=0`) and `/api/services/admin/inspect-communities`.

## Phase 5 — AI review (manual dry-run/apply, no cron yet)
Reviews submitted orders' evidence (answers + before/after photos) against the
service AI knowledge base and either auto-completes (clean) or routes to Review.
`runServiceAiReview()` in `lib/services/aiReview.ts` → `/api/services/admin/review`.
- **Dry-run (verdicts, no writes):** `https://ppw.resiwalk.com/api/services/admin/review`
- **Apply (writes verdict + moves status):** `https://ppw.resiwalk.com/api/services/admin/review?apply=1`
- Optional `&id=<recordId>` to review one order; `&today=YYYY-MM-DD` for on-time math.
- clean → `status=completed` (+ `completed_at`, `ontime`); needs_review → `status=review`;
  writes `ai_verdict` / `ai_notes`. Requires `ANTHROPIC_API_KEY`. Model: claude-sonnet-4-6.

## Nightly crons (Vercel)
Both engines are wired to nightly Vercel crons (run on the PRODUCTION deployment
once merged; `CRON_SECRET`-gated, safe no-op if unset):
- `/api/cron/services-generate` — 07:00 UTC daily (rule → work-order generation, apply).
- `/api/cron/services-review` — 07:30 UTC daily (AI review of submitted orders, apply).
Manual admin dry-run/apply endpoints remain for ad-hoc runs.

## Offline capture + sync, immediate review
- `lib/services/offlineServices.ts` — isolated from the inspection offline store
  (no regression risk) but reuses the same primitives: `compressToJpeg` +
  `uploadJpegBlob`, durable IndexedDB blobs, draft blob→hosted URL rekey. Photos
  captured offline show immediately and upload on reconnect; the submit itself
  queues durably and fires once photos resolve (`initServiceSync` runs on mount /
  `online`). On-device offline testing required (like camera/GPS).
- **Immediate AI review:** `/api/services/[id]/submit` runs the single-order AI
  review inline the moment a WO is submitted (best-effort). The nightly
  `services-review` cron remains a backstop for any that errored.

## Editable, persisted Form Builder + AI Knowledge
Both are now LIVE and editable (admin). Stored as JSON on the admin Agent record
(same store as the inspection AI KB; properties `service_forms_json` /
`service_ai_checks_json` self-provision on first Save — no new object):
- Form Builder Save → `/api/services/forms/save`; read by the completion screen +
  PDF (`readServiceForms`, falls back to seeded defaults per worktype:subtype).
- AI Knowledge Save → `/api/services/ai-checks/save`; read by the AI review
  (`readServiceAiChecks`, falls back to seeded checks).

## Completion, review & PDF
- Completion screen `/services/[id]` uses the shared 1099 camera (`CameraCapture`:
  in-camera capture + gallery + GPS stamp). Submit → status `submitted` (locked).
- Once submitted it is VIEW-ONLY (external users). Internal reviewers get Approve /
  Reject when status is `review` (`/api/services/[id]/review-decision`): approve →
  Completed (full payout); reject → Completed with adjusted payout (default $0, or
  "back yard not serviced" −25%) + reason/notes. Recomputes client cost.
- `GET /api/services/[id]/pdf` renders the completion PDF (header, pricing, answers,
  photos, AI + review notes); the "View PDF" link shows once submitted.

## Delete staging / test services (teardown)
`purgeServiceWorkOrders()` → `/api/services/admin/purge` (admin-gated). Dry-run
lists `wouldDelete`; `?apply=1` deletes. Default scope = TEST data only.
- **Dry-run (test data):** `https://ppw.resiwalk.com/api/services/admin/purge`
- **Delete generated + seeded:** `https://ppw.resiwalk.com/api/services/admin/purge?apply=1`
- **Delete ONLY rule-generated:** `…/api/services/admin/purge?scope=generated&apply=1`
- **Delete EVERYTHING (incl. manually-created):** `…/api/services/admin/purge?scope=all&apply=1`

## Rollout order
1. **Dry-run** → review the report.
2. **Apply** → objects + properties + Question props (+ associations; re-run apply
   once objects exist so association type ids resolve).
3. Set the two env vars, redeploy.
4. Phase 1: build the Services read layer (`/api/services`) and swap the home
   list + calendar from sample data → real Services (behind the flag).

## Phase 3b — generation engine (manual dry-run/apply, no cron yet)
Turns saved Service Rules Engine records into real Service Work Orders.
`runServiceGeneration()` in `lib/services/generate.ts`, exposed at
`/api/services/admin/generate`. Admin-gated; PROD HubSpot via the preview.
- **Dry-run (read-only):** `https://ppw.resiwalk.com/api/services/admin/generate`
- **Apply (creates work orders):** `https://ppw.resiwalk.com/api/services/admin/generate?apply=1`
- Optional `&today=YYYY-MM-DD` overrides "today" for due-date math (defaults to server today).

Idempotent via `enrollment_key = gen:<ruleId>:<targetId>`: one OPEN (non-terminal)
order per (rule, target) at a time — the next generates only after the current is
completed or canceled. v1 simplifications (reported in the response `notes`):
property targets from sample data; community targets from the rule's own list;
enrollment/stop conditions assumed met; due = today + First Order Due (days), else
+5; no cadence date math; first assigned vendor used (no rotation). No scheduled
cron — runs only when an admin hits the endpoint. Wire to a nightly cron once the
dry-run is validated against live rules.
