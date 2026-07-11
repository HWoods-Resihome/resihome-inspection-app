# ResiWalk - Services — Planning Doc

> **Project name: "ResiWalk - Services."** In-house recurring field services
> (grass cuts, pool service, cleans, community contracts) with our own scheduling,
> dispatch, evidence, and invoicing.
>
> **Naming rule (hard):** "PPW" is ONLY informal shorthand for the incumbent
> external vendor this initiative replaces (the current grass/clean/pool default in
> `lib/vendors.ts`). It must **NEVER** appear in any artifact we create — code
> identifiers, env vars, routes, or HubSpot fields/objects. Everything is
> "Services" / `service_*` / `SERVICES_*`.
>
> **Status: PLANNING (living doc). No code yet.** This captures the vision, what we
> can reuse from the existing inspection app, and what's net-new, so we can keep
> refining and then execute in phases. Edit freely as decisions land.

---

## 1. Vision (one paragraph)

Extend ResiWALK beyond one-off inspections to **recurring field services** (grass
cuts, cleans, pool service, etc.) across the property portfolio. A **Rules Engine**
auto-generates **work orders** on the right cadence (regional + seasonal +
community/client overrides), an **assignment engine** routes each to the best
vendor by worktype/coverage/capacity/performance, vendors execute in the field with
**before/after photos + GPS-verified evidence + AI verification**, a **coordinator**
reviews, and approved work flows into **invoicing / export-to-pay** with no
double-billing. Same field-grade reliability the inspection app already has
(offline capture, evidence stamps, durable photo sync).

---

## 2. Is the Grok breakdown "about right"? — Assessment

**Yes — it's a strong start.** The Gherkin coverage (happy / edge / unhappy /
security) is exactly the right shape and surfaces the hard parts early
(rule precedence, capacity throttling, geofence/spoofing, payment locking,
audit). Keep it — we'll turn each scenario into acceptance criteria per phase.

What it gets right and we should lock in:
- **Rules precedence** (Community > Client/State) and **duplicate prevention** — these are the two rules that make or break trust. Good catch.
- **Capacity + OTD throttling** on assignment — the real engine, not just round-robin.
- **Offline caching + spoof/geofence detection** — we already do most of this for inspections; big reuse.
- **Payment locking + Export-to-Pay date + historical recovery** — prevents the classic double-pay bug.
- **Role gating + immutable audit on rule edits** — correct; we already have an audit log to build on.

Gaps / things to decide that the breakdown doesn't yet resolve (captured in §6 & §8):
- **Is a "work order" a new object or a reused inspection?** (Recommendation below — new object, reuse the app.)
- **Source of truth for properties/eligibility** — HubSpot vs **Snowflake** (the breakdown assumes Snowflake; today the app is 100% HubSpot). Big decision.
- **Geofence is a polygon** in the breakdown; today we do **point + radius (250m)**. Polygon is net-new.
- **Vendor portal** — vendors executing implies a vendor-facing app/login. Today all users are internal/1099-inspector. New surface.
- **Slack** notifications — new integration (today: web/native push + Gmail).
- **Client/billing model** — "bill the client", rate cards per client/worktype. Today rate cards are turn-scope-oriented. Needs a recurring-services rate model.
- **AI before/after diff verification** — different from today's scope AI review; net-new model/prompt.

Net: the vision is coherent and buildable. ~50–60% can lean on existing
infrastructure/patterns; the Rules Engine, vendor capacity/scorecard, polygon
geofencing, vendor portal, Snowflake sync, and Slack are the net-new pillars.

---

## 3. What we can REUSE from the existing app

Legend: ✅ reuse mostly as-is · 🟡 reuse pattern but extend · 🔴 net-new

| Capability | Today (inspection app) | Recurring Services | Reuse |
|---|---|---|---|
| **Field photo capture** | `CameraCapture` (Modern/Legacy), in-app camera, video | Before/After service photos | ✅ |
| **Offline durability** | `offlinePhotoStore` (ArrayBuffer/IDB), `offlineOutbox`, background-sync SW | Dead-zone caching of photos+metadata | ✅ (just hardened) |
| **GPS evidence stamp** | `evidenceStamp`, burned-in lat/long+time, proximity verdict | On-site proof, geofence | 🟡 point+radius → **polygon** |
| **AI field assist / review** | `rateCardAiCore`, `room-scan-live`, AI review gate | AI before/after **diff** verification ("dirty pool") | 🟡 new prompt/model + diff scoring |
| **PDF generation** | `pdfMaster/Chargeback/Vendor`, react-pdf, gallery links, DRAFT mark | Service report / invoice PDFs | 🟡 new templates, same engine |
| **Status pipeline + finalize** | scheduled→in_progress→pending_approval→completed; `finalize`/`submit`, dual-approval lock | WO lifecycle (review→pay→paid, fix-item) | 🟡 same pattern, new states |
| **Vendors** | `lib/vendors.ts` (static list, colors, default routing, per-vendor PDFs) | Vendor master w/ worktype, coverage, capacity, OTD | 🔴 needs real vendor object + metrics |
| **Billing fields / export** | `vendor_invoice_amount`, `client_invoice_amount`, broker_code, **SFTP** chargeback xlsx | Export-to-pay ledger, payment lock | 🟡 reuse export plumbing, new ledger/lock model |
| **Regions** | `region_snapshot`, `region_rate` (18 regions, "GA: Atlanta"), state prefix | Regional rule keys (state/market) | ✅ |
| **Cron** | Vercel crons: sftp-watch (1m), blob-cleanup, auto-cancel-stale (daily), insights rebuild (30m) | **Nightly Rules Engine** generation | ✅ add a cron entry |
| **Audit log** | `lib/auditLog.ts` (`recordAuditEvent`) | Immutable rule-change + WO audit | ✅ extend |
| **Notifications** | Web push + native FCM (`pushSender`/`pushClient`), Gmail send | Coordinator/vendor alerts; **Slack** | 🟡 reuse push; 🔴 add Slack |
| **Roles / access** | `adminAccess` (app admin), `userAccess` (internal vs 1099 external), `finalizeAccess`, `insightsAccess` | Super Admin, Rules Engineer, Coordinator, Vendor | 🟡 extend role model |
| **Property data** | HubSpot Property object (status, region, coords, community assoc.) | Eligibility (vacant?), community, polygon | 🟡 + **Snowflake?** |
| **Admin hub** | `/admin/flows` ("Admin") — setup, regenerate, backfills | Rules Engine admin, vendor scorecards | ✅ extend the hub |
| **Impersonation / view-as** | admin "view as user" | Coordinator viewing vendor view | ✅ |

---

## 4. Proposed data model (new objects / fields)

> **Recommendation: a new `service_work_order` object, NOT an overloaded
> inspection.** Inspections and recurring WOs differ in lifecycle, financials,
> assignment, and volume (recurring = high churn). Keep them separate objects but
> reuse the app's UI/infra. Open to debate (§6).

### New HubSpot custom objects (proposed)
- 🔴 **`service_work_order`** — one job instance. Fields (draft):
  `worktype`, `property_id_ref`, `region_snapshot`, `status` (pipeline below),
  `scheduled_date`, `assigned_vendor_id`, `generated_by` (rules-engine|manual),
  `source_rule_id`, `before_photo_urls`, `after_photo_urls`, `condition_form_json`,
  `ai_verification_score`, `ai_verification_state`, `geofence_state`,
  `vendor_cost`, `client_charge`, `coordinator`, `approved_by`, `approved_at`,
  `export_to_pay_date`, `paid_at`, `payment_locked`, `invoice_number`.
- 🔴 **`service_rule`** — the Rules Engine config. Fields (draft):
  `worktype`, `scope` (state | client | community | property), `scope_key`,
  `season` (growing|cold|all), `frequency_days` (or per-month), `active`,
  `priority` (for precedence), `effective_from/to`, `created_by`, `updated_by`.
- 🔴 **`service_vendor`** (or extend the existing vendor concept) —
  `name`, `worktypes[]`, `coverage_areas[]` (regions/markets), `weekly_capacity`,
  `active_allocation`, `otd_rate`, `quality_score`, `rate_card_ref`, `status`,
  `payout_method`.
- 🔴 **`vendor_rate`** — contracted flat rate per `(vendor, worktype, region, client)` → `amount`; drives the invoice-mismatch block.
- 🟡 **`worktype`** — could be config/enum in code (like `formTemplates`) rather than an object: `grass_cut`, `clean`, `pool`, … with default season logic.

### Reused objects
- ✅ **Property** (HubSpot) — add fields: `service_eligible`, `polygon_geojson`,
  `client_id`, `community_id` (some exist), `is_vacant` source.
- ✅ **Agent** (config storage) — already holds admins/templates JSON; can hold
  rules/role maps short-term before dedicated objects.

### Work Order pipeline (status) — proposed
`Scheduled → Assigned → In Progress → Pending AI Verify → (AI Pass) → Pending
Coordinator Review → Approved → Pending Payment → Exported → Paid`
with branches: `Fix Item / Vendor Revision`, `Geofence Failure`, `Cancelled`,
`Skipped (duplicate)`. (Mirrors the inspection status pattern + finalize/lock.)

---

## 5. The net-new pillars (where the real work is)

1. 🔴 **Rules Engine (nightly cron)** — evaluate every eligible property × worktype,
   apply season (growing/cold by region+date), apply precedence
   (Community > Client > State), check "no open WO of this type" (dedupe),
   generate WOs + next-run date. Needs: season calendar per region, rule
   precedence resolver, idempotency/dedupe, dry-run + audit. Builds on existing
   cron infra.
2. 🔴 **Assignment engine** — filter vendors by worktype ∩ coverage ∩ capacity,
   rank by OTD/quality, assign, increment allocation; throttle on SLA breach;
   fall through to runner-up at capacity ceiling.
3. 🔴 **Vendor portal + scorecard** — vendor login/role, "my work orders", field
   execution (reuse camera/offline/evidence), and a coordinator-facing scorecard
   (OTD %, capacity slider, bid iterations, avg market cost).
4. 🔴 **AI before/after verification** — diff scoring + worktype-specific checks
   (e.g., "pool still has debris"), Pass/Fix routing. New from the scope AI.
5. 🔴 **Polygon geofencing + anti-spoof** — property polygon, on-device live-metadata
   enforcement (reject camera-roll/mismatched GPS → Geofence Failure).
6. 🔴 **Financial export-to-pay + locking** — payment ledger, batch export stamp,
   immutable lock once paid, historical date recovery. Reuse SFTP/xlsx export.
7. 🟡 **Integrations** — **Slack** alerts (new), and **Snowflake** as the
   property/eligibility source of truth (new; today HubSpot-only).

---

## 6. Key architectural decisions (need owner input)

1. **Work order = new object vs. reuse `inspection`?**
   → Recommend **new `service_work_order`** (volume, lifecycle, financials differ),
   reusing the app's field/infra layers. Confirm.
2. **System of record for properties/eligibility: HubSpot or Snowflake?**
   The breakdown assumes a Snowflake sweep. Today everything is HubSpot. Options:
   (a) Snowflake → HubSpot sync, app stays HubSpot-native; (b) app reads Snowflake
   directly for eligibility. This is the biggest architecture fork.
3. **Vendor execution surface** — do vendors get logins in *this* app (new vendor
   role + portal), or a separate app? Reusing this app's camera/offline is a huge
   win → recommend vendor role here.
4. **Client/billing model** — multi-client? per-client rate cards + invoices? This
   shapes `vendor_rate`, `client_charge`, and export grouping.
5. **Geofence fidelity** — polygon (GeoJSON) vs. keep point+radius. Polygon is more
   work but matches the vision.
6. **Where do worktypes + season calendars live** — code config (fast to iterate)
   vs. editable objects (admin-managed, audited). Likely start config, graduate to
   objects.
7. **Notifications** — Slack channel(s) mapping (per region? per coordinator?).
8. **Volume/scale** — recurring WOs are far higher volume than inspections; confirm
   HubSpot object limits/rate are acceptable or whether WOs live in our own DB.

---

## 7. Roles (proposed, extends current model)

| Role | Today | Recurring Services |
|---|---|---|
| Super Admin | `isAppAdmin` | full incl. rules engine write |
| System Rules Engineer | — 🔴 | edit seasonal/client/state rules (audited) |
| Coordinator | — 🔴 | review/approve WOs, manage exports, vendor oversight |
| Vendor | — 🔴 (1099 ext. is closest) | see/execute *assigned* WOs only |
| Finance | `finalizeAccess`-ish | export-to-pay, mark paid |

`/admin/rules-engine` and rule writes → Super Admin / Rules Engineer only (403 otherwise), every edit audited (User, Timestamp, Old→New).

---

## 8. Open questions to resolve next (checklist)

- [ ] New `service_work_order` object confirmed? Field list reviewed?
- [ ] Snowflake vs HubSpot as property/eligibility source of truth?
- [ ] Vendor portal in this app (new Vendor role) confirmed?
- [ ] Worktypes list + each one's season/frequency defaults (the actual cadence table)?
- [ ] Region → season calendar (which states/markets, growing vs cold month ranges)?
- [ ] Rule precedence order final (Community > Client > State > default)?
- [ ] Client list + per-client rate cards + invoice format?
- [ ] Polygon source (do properties have polygons, or geocode+radius for v1)?
- [ ] Payment export target (SFTP like chargeback? a specific accounting system?)?
- [ ] Slack workspace/channels + which events alert?
- [ ] Capacity/OTD/SLA exact formulas + throttle percentages?
- [ ] AI verification: per-worktype pass criteria + who tunes thresholds?

---

## 9. Phased roadmap (draft — sequence, not commitment)

- **Phase 0 — Foundations & decisions:** lock §6 decisions; define `service_work_order`,
  `service_rule`, `service_vendor`, `vendor_rate` schemas; worktype + season config.
- **Phase 1 — Manual WOs end-to-end:** create a WO manually, assign a vendor, vendor
  executes (reuse camera/offline/evidence), coordinator reviews/approves, basic PDF.
  *(Proves the reuse story without the engine.)*
- **Phase 2 — Rules Engine:** nightly generation w/ season + precedence + dedupe;
  admin rules UI; audit; dry-run.
- **Phase 3 — Assignment engine + vendor scorecard:** capacity/OTD/coverage routing,
  throttling, runner-up fallback, scorecard UI.
- **Phase 4 — AI verification + polygon geofence + anti-spoof.**
- **Phase 5 — Financials:** rate-card enforcement, export-to-pay, payment lock,
  historical recovery.
- **Phase 6 — Integrations:** Slack alerts; Snowflake sync (or earlier if it's the
  source of truth).

---

## 10. Appendix — Grok's Gherkin breakdown (verbatim, source material)

> Pasted from the owner's session with Grok; the basis for acceptance criteria.
> Kept as-is so we don't lose the original framing.

### 1. Happy Path
- **Feature 1 — Automated Work Order Generation & Rules Engine:** GA vacant property,
  no community restrictions, growing months (June), no open Grass Cut → nightly engine
  generates a Grass Cut WO, next run +10 days. Colder months (Dec) → 1×/month.
- **Feature 2 — Intelligent Auto-Assignment & Vendor Capacity:** Pool Cleaning WO in
  Orlando → filter by WorkType + Coverage + OTD>threshold → assign highest-ranked
  vendor with capacity → allocation +1.
- **Feature 3 — Vendor Field Execution & AI Verification:** vendor uploads Before,
  fills condition form, completes, uploads After; GPS within polygon; AI "Pass" →
  status Pending Coordinator Review + Slack alert.
- **Feature 4 — Financials & Export to Pay (No Duplication):** Coordinator "Approve and
  Complete" → Pending Payment → batch export stamps Export-to-Pay Date → once Paid,
  locked from any future export.

### 2. Edge Cases
- **Overlapping Community vs. Property/Client rules** → defer to Community (14-day) over
  State (7-day).
- **Duplicate prevention** → ad-hoc WO opened yesterday; engine warns + cancels its own
  scheduled run today to avoid double-billing.
- **Vendor at 100% capacity (50/50)** → skip, route to runner-up.
- **OTD below SLA** → auto-throttle max allocation by system rule %.
- **Low connectivity / offline caching** → cache raw images+timestamps+geo locally,
  upload on restore, no loss.
- **Time/Date/Location spoofing** → camera-roll photo lacking live metadata / mismatched
  GPS → reject + flag Geofence Failure.
- **Missed item recovery** → Export-to-Pay historical date filter to capture omitted
  record without refetching processed files.

### 3. Unhappy Path
- **Invoice price mismatch vs rate card** ($45 contracted, $55 submitted, no approved
  supplemental) → block + inline error + Slack warning.
- **AI detects dirty pool** → insufficient before/after diff → revert to Fix Item /
  Vendor Revision Required + in-app ping.
- **Snowflake/HubSpot API outage** → catch gracefully, halt corrupted batch generation,
  high-priority Slack alert with failing endpoint.

### 4. Security & Permissions
- **Rule write access** → only Super Admin / System Rules Engineer; Coordinators/Vendors
  hitting `/admin/rules-engine` → 403.
- **Audit logging** → every rule edit writes immutable line: User ID, Timestamp, Old
  Value, New Value.

### Grok's offered next steps
- (a) Build the Snowflake-to-proprietary-software sync data-mapping schemas, or
- (b) Design the Vendor Scorecard UI (OTD %, bid iteration counters, avg market costs).

---

## 10.5 Dev / test workflow (how we build PPW without touching resiwalk.com)

Decided setup — **isolated deploy, shared (production) HubSpot data:**

- **Branch, not main.** All PPW work lands on the **`recurring-services`** branch.
  Only `main` auto-deploys to `resiwalk.com`, so production stays pristine while we
  iterate. Every push to the branch builds its own **Vercel Preview URL**
  (`…-git-recurring-services-<team>.vercel.app`), gated behind Vercel's login.
- **Production HubSpot, on purpose.** The preview inherits prod env vars —
  including the live `HUBSPOT_TOKEN` — so PPW is developed against the **real
  portal** (no sandbox). Nothing to configure on the HubSpot side.
- **⚠️ Preview writes hit LIVE data.** Because there's no sandbox, any HubSpot
  object PPW creates from the preview lands in production. Two rules follow:
  - Stamp every PPW-created object with **`PPW_TEST_MARKER`** whenever
    `ppwWritesAreTest` is true (see `lib/featureFlags.ts`) so preview/test records
    are trivially findable and bulk-removable in prod.
  - Keep object-creating flows behind the admin gate below until they're trusted.
- **Feature gate (`lib/featureFlags.ts`):**
  - `PPW_FLAG_ON` — inlined client flag. ON when `NEXT_PUBLIC_PPW_ENABLED === '1'`
    (set it **Preview-scoped** in Vercel) or in local `next dev`. UNSET in
    Production → PPW is invisible on `resiwalk.com` **even after code merges to
    main**, until that var is deliberately flipped.
  - `ppwEnabled(email)` (in `lib/ppwAccess.ts` — kept separate so the admin/HubSpot
    server code never reaches the client bundle) — server/API gate: flag on **and**
    caller is an app admin. Put it at the top of every `/api/ppw/*` handler so a
    normal inspector can never reach PPW even where the flag is on.
  - `PpwEnvBadge` (mounted in `_app.tsx`) shows a "PPW PREVIEW · writes to PROD
    HubSpot" marker wherever the flag is on; renders null in production.
- **One-time Vercel step:** add `NEXT_PUBLIC_PPW_ENABLED=1` as a **Preview**-scoped
  env var (Production left unset). No other env changes — the HubSpot token is
  shared from Production as-is.
- **Merge path:** phases can merge to `main` early because everything is
  flag+admin gated and dark in prod. Flip `NEXT_PUBLIC_PPW_ENABLED` in Production
  (and later drop the gates) only when a phase is ready to go live.

## 10.6 Architecture v1 — LOCKED decisions (owner, this session)

> Where this conflicts with the earlier exploratory §2/§4/§6, THIS wins. Source of
> truth for properties/eligibility is **HubSpot** (not Snowflake) for v1.

### Object map (v1)
- **Reuse as-is:** `Questions` + `Answers` (field capture), `Properties`, `Communities`.
- **Vendors = the existing `Companies` object** (`0-2`, portal 22536354). Add PPW
  fields there; **no new vendor object** (retires the §4 `service_vendor` idea).
- **New object `Services`** — the job instance; carries all job details.
- **New object `Service Rule`** — the rules engine config.
- **Worktype** = one **dropdown (enum)** property, canonical option set, used on
  Services (and mirrored on Rule + Company capabilities).
- **Vendor rate** resolves from the **Service Rule** (by worktype) **or** the
  **Company** (vendor-specific) — precedence in the Rate section below.

### `Services` object — fields (draft)
Association-first; scalars only for what we filter/report/bill on.
- **Assoc/identity:** `service_id_external` (idempotency key), → Property (1),
  → Company/vendor (1), → Community (via Property), → Answers (N, field data),
  `source_rule_id`, `generated_by` (rules_engine | manual).
- **Classification:** `worktype` (enum), `region_snapshot`, `season_snapshot`.
- **Lifecycle `status`:** scheduled → dispatched → in_progress → submitted →
  in_review → approved → export_to_pay → paid (+ fix_item, cancelled);
  `scheduled_date`, `completed_at`, `approved_by`, `approved_at`.
- **Evidence roll-up** (detail lives on Answers): `before_photo_urls`,
  `after_photo_urls`, `geofence_state`, `ai_verification_state`,
  `ai_verification_score`.
- **Money:** `vendor_cost`, `client_charge`, `rate_source` (rule|company|manual),
  `export_to_pay_date`, `paid_at`, `payment_locked`, `invoice_number`.
- **Test:** `ppw_preview_test` (stamped when created from a non-prod deploy — see
  `PPW_TEST_MARKER`).

### Vendors on `Companies` — fields to ADD
- `ppw_is_vendor` (bool), `ppw_worktypes` (multi-enum capabilities),
  `ppw_coverage` (regions/markets), `ppw_weekly_capacity`, `ppw_active_allocation`,
  `ppw_otd_rate`, `ppw_quality_score`, `ppw_payout_method`, and vendor rate as
  **`ppw_rate_json`** ({ "<worktype>[:<region>]": amount }). JSON prop over a child
  object for v1 (matches the `section_list_json` pattern; revisit if rates need
  effective-dating / per-client tiers).

### Worktype — single source of truth
- Canonical list in code (`lib/ppw/worktypes.ts`), mirrored to the HubSpot enum on
  Services/Rule/Company and kept in lockstep like `lib/vendors.ts`. v1 options TBD
  (grass cut, cleaning, pool service, …).

### Field capture — REUSE Questions + Answers
- Each worktype → a **question set** (reuse `Questions`, tagged by worktype) = the
  vendor's before/after + condition form.
- Answers are **keyed to the Service** (association + `service_id_external` on the
  answer, exactly how answers key to an inspection today) → we reuse
  `CameraCapture`, `offlinePhotoStore`, the evidence stamp, durable photo sync, and
  the answer-render/PDF pipeline **unchanged**.

### Rate resolution (precedence — top wins)
1. **Manual override** on the Service (coordinator-set).
2. **Company (vendor) rate** for (worktype[, region]) from `ppw_rate_json`.
3. **Service Rule** default rate for the worktype/scope.
- Stamp `rate_source` so the invoice-mismatch guard knows what it compared against.
- ⚠️ **Owner decision:** is #2 (vendor-specific) above #3 (rule default) — my draft —
  or should the rule be authoritative? 

### `Service Rule` object — the customizable engine (the hard part)
A rule = **who it applies to** (condition tree) + **what it generates**
(worktype / cadence / rate) + **precedence**.
- **HubSpot fields:** `rule_name`, `worktype` (enum), `active` (bool),
  `priority` (int → precedence), `scope_label` (community|client|state|property,
  for humans), `frequency_days`/cadence, `season`, `effective_from/to`,
  `default_vendor_cost`/`default_client_charge` (optional), `created_by`/
  `updated_by`, and the core **`conditions_json`** (long-text prop, same
  store-JSON-in-a-property pattern as `section_list_json`).
- **`conditions_json` — nested predicate tree over ANY associated field:**
  ```json
  {
    "op": "AND",
    "rules": [
      { "object": "property",  "field": "property_status", "operator": "in", "value": ["Vacant","Pending MOI"] },
      { "op": "OR", "rules": [
        { "object": "community", "field": "region",   "operator": "eq", "value": "GA: Atlanta" },
        { "object": "property",  "field": "has_pool", "operator": "eq", "value": true }
      ]}
    ]
  }
  ```
  - `object` = which associated object the field is from (`property` | `community`,
    extensible). Operators: eq, neq, in, not_in, gt, gte, lt, lte, between,
    contains, exists, not_exists. Arbitrary AND/OR nesting = "logic on ANY field
    from ANY associated object."

### Rule builder (the URL) + "which properties does this touch?"
- **Editing surface `/admin/ppw/rules/[id]`** (admin-gated app page):
  1. loads the **field schema** for Property + Community from HubSpot's properties
     API (cached) → a searchable field picker with type-aware operator/value inputs;
  2. compose the nested AND/OR tree;
  3. **live preview: "matches N properties" + a browsable list** so you see exactly
     which properties a rule touches *before* saving — plus a per-property "which
     rules hit me?" reverse view;
  4. save `conditions_json` + metadata to the `Service Rule` HubSpot object.
     **The URL is the editor; HubSpot is the store.**
- **Evaluation engine (HYBRID — this is the key technical call):**
  - Push **property-level** predicates down to the **HubSpot CRM Search API**
    (`filterGroups` = AND-of-OR; operators map to EQ/IN/GT/BETWEEN/HAS_PROPERTY/…)
    → HubSpot returns the matching property set (scales; gives the list for free).
  - Evaluate **community-level / cross-object** predicates **app-side** on that
    narrowed set (resolve Property→Community, fetch community fields, apply). HubSpot
    search can't filter a Property by an *associated* Community's field in one query
    — that constraint is what forces the hybrid.
  - **One evaluator** powers both the live preview and the nightly generator, so
    "preview == what actually generates."

### Generation flow (nightly cron) + precedence + dedup
- New Vercel cron → `/api/cron/ppw-generate` (pattern: `sftp-watch`):
  1. for each active rule by `priority`, evaluate → matching properties;
  2. **precedence** Community > Client > State: when rules collide on the same
     (property, worktype), only the highest-priority/most-specific wins;
  3. **dedup:** skip if an open/active Service already exists for (property,
     worktype) within the cadence window (kills the double-billing bug);
  4. create `Services` (status `scheduled`, `source_rule_id`, resolved rate) +
     associations; stamp the preview marker when non-prod.
- Immutable audit (`lib/auditLog`) on every rule edit.

### Associations (crm/v4)
Service→Property (1), Service→Company/vendor (1), Service→Answers (N),
Service→Service Rule (source), Property→Community (existing, reused).

### Open decisions needing owner input
1. **Rate precedence** — vendor Company rate above rule default (draft) or rule wins?
2. **Vendor rate storage** — `ppw_rate_json` on Company (draft) vs a child object.
3. **Worktype v1 list** — confirm the starting options.
4. **Vendor portal** — do vendors log in and upload evidence in v1 (new external
   auth surface), or do coordinators enter results first? Big scope lever.
5. **Live-preview scale** — cap/paginate the "matches N properties" list for very
   broad rules? (Nightly cron evaluates fully regardless.)

---

## 10.7 Architecture v2 — LATEST (supersedes v1 where they differ)

Owner input added three things that reshape v1: **two work models**, **vendor
logins (non-HubSpot)**, and a **conflict-clean rules engine**. This section is the
authoritative picture; §10.6 stands for anything not restated here.

### 0. The organizing insight: TWO work models
Everything below flows from this. We run two very different kinds of work and must
handle both in one system:

| | **A. Scattered SFR** | **B. Community contract** |
|---|---|---|
| Unit of work | one **property** | a **community** (whole or a zone/part) |
| Dispatch | single Work Order per property | recurring occurrences per contract cadence |
| Billing | per job (per property) | per cadence occurrence (flat/contract rate) |
| Rate authority | worktype default → **vendor (Company)** override | worktype default → **Community** override |
| Rule targets | properties (field predicates) | communities (field predicates) + optional zone |

→ A single `Services` object serves both, distinguished by a **`scope_level`**
field (`property` | `community`). A rule declares which level it generates.

### 1. Worktype taxonomy — RECOMMENDATION: scope is orthogonal to worktype
You listed "Community Work" as a category (community grass cut / pool clean / pet
station / model clean…). I recommend we **NOT** make "Community Work" its own
worktype. Instead:

- **`worktype`** = *what* the work is: `grass_cut`, `pool_service`, `house_cleaning`,
  `pet_station`, `trash_pickup`, `model_clean`, … (+ optional `subcategory` per
  worktype).
- **`scope_level`** = *where* it applies: `property` | `community` (the separate
  field above).

So "Community Grass Cut" = `worktype=grass_cut` + `scope_level=community` — NOT a
separate worktype. Why: a grass cut's question set, evidence rules, and AI check are
the same whether scattered or community; duplicating "grass cut" into two worktypes
would fork rates, forms, and rules. Each worktype declares `allowed_scopes`
(some, like `pet_station`/`trash_pickup`, are community-only). The UI still groups
`scope_level=community` items under a **"Community Work"** heading so it matches how
you think about it. Canonical taxonomy in `lib/ppw/worktypes.ts`, mirrored to the
HubSpot enums. *(Owner: confirm this vs. a literal "Community Work" worktype.)*

### 2. Rates — three tiers, no new object (per owner)
Default is the **worktype rate**; Company or Community override it by worktype.
- **Worktype default** → JSON on a **singleton HubSpot config record** (the same
  admin/config record the app already uses for `app_admins_json`), key
  `ppw_worktype_rates_json` = `{ "<worktype>[:<sub>]": amount }`. Editable at an
  admin URL. This is the "where does it live" answer: **not its own object** — a
  config blob in HubSpot.
- **Company override** → `ppw_rate_json` on the Company (vendor-negotiated).
- **Community override** → `ppw_rate_json` on the Community (contract rate).

**Resolution ladder (most-specific wins), stamped as `rate_source` on the Service:**
1. Manual override on the Service.
2. **community-scoped** job → **Community** `ppw_rate_json[worktype]`.
   **property-scoped** job → **Company (assigned vendor)** `ppw_rate_json[worktype]`,
   then the property's **Community** `ppw_rate_json[worktype]`.
3. **Worktype default** (config JSON).
*(Owner: confirm the property-scoped order — vendor override before community.)*

### 3. `Services` object — additions for two models
On top of §10.6 fields, add:
- `scope_level` (`property` | `community`), `subcategory` (enum, worktype-scoped),
  `billing_model` (`per_job` | `contract`), `contract_cadence` (for community),
  `zone_key` (optional — names a sub-part of a community; see §5).
- Association is `→ Property (1)` when property-scoped, `→ Community (1)` when
  community-scoped. Answers, vendor(Company), source_rule assoc unchanged.

### 4. Vendor login — non-HubSpot users (NEW surface)
Vendors log in to the app, see only their assigned jobs, and upload evidence. They
are **not** HubSpot users and **not** internal/1099 staff — a new, more-restricted
user class.
- **Identity** = a designated login email on the Company: add **`ppw_login_email`**
  (or a JSON list for multi-user vendors). We authorize ONLY that email — never an
  arbitrary Company contact.
- **Auth** = reuse the existing **email OTP** flow (`otp-request`/`otp-verify`) as
  the password solution (passwordless code by email — fine as the "temp" that can
  stay). `otp-request` for a vendor email → verify it matches a Company with
  `ppw_is_vendor=true` and a matching `ppw_login_email` → mint a **vendor session**.
- **Vendor session** carries `role: 'vendor'` + `vendorCompanyId`. New hard gate
  `vendorScopeDenial(session, serviceId)`: a vendor can reach ONLY `/vendor/*` and
  APIs for Services assigned to their `vendorCompanyId` — everything else 403
  (middleware + per-endpoint). This is stricter than `isExternalEmail`; keep it
  separate.
- **Vendor UI** = a minimal `/vendor` surface: "my jobs" list → open a Service →
  reuse the same **Answers capture** (in-app camera, before/after, evidence stamp,
  offline photo store, durable sync) → submit. No scope/rate/admin visibility.
- Requires a **security review** (new external auth + prod-data exposure). OTP
  rate-limits already exist; add per-vendor scoping tests. Ships as its own phase.

### 5. Community "parts/zones"
A community contract can cover the whole community or a **part**. v1: `zone_key` on
the Service + an optional property-predicate on the rule that selects a subset of
the community's properties (reusing the §10.6 condition engine, scoped to that
community's members). If unset → whole community. Full polygon/zone management is a
later extension.

### 6. Rules engine — CONFLICT-CLEAN engineering (the "advanced" ask)
The requirement: as rules pile up, adding one must never silently clobber another,
and the outcome must be predictable and explainable. Rules are **independent
configs — they never mutate each other**; "overwriting" is really "which rule WINS
for a target." We make winning **deterministic and visible**:

- **Deterministic resolution.** For each `(target, worktype)` the winner is the
  first rule under a **total order**: `priority` (desc) → **specificity** (desc,
  a documented score = # predicate leaves + exact-match weighting + scope
  narrowness) → `effective_from` (desc) → id. No ambiguity, ever.
- **Save-time conflict analyzer.** On create/edit of rule R (worktype W): compute
  R's population, intersect with every other active W-rule, and show a report —
  *"R overlaps Rule X on 42 targets; R (priority 20) would take over 30 that X
  currently wins; R is fully shadowed by Y (never wins → likely a mistake)."* You
  resolve it **before** activating.
- **Dry-run / simulation.** "Activating R would create X new services tonight,
  reassign Y, change Z rates" — zero writes.
- **Coverage board.** Per worktype: targets with **no** rule (gaps) and targets with
  **>1** (overlaps), so the whole portfolio is legible.
- **Explain view.** For any property/community: every matching rule per worktype,
  the winner, and *why* (priority/specificity). This is the "which rules touch this
  / which properties this rule touches" navigation you asked for, both directions.
- **Generation invariants.** Exactly **one winner** per (target, worktype, cadence
  window); dedup against existing open Services; never double-generate/​double-bill.
- **Guardrails on save:** warn on empty-population rules (match nothing),
  fully-shadowed rules (dead), and overlapping cadences that would double-bill.
- **Immutable audit + effective-dating** on every activate/edit/deactivate.

One evaluator (the §10.6 hybrid: HubSpot Search for property predicates + app-side
for community/cross-object) powers preview, conflict analysis, dry-run, AND the
cron — so what you preview is exactly what generates.

### 7. Generation cron — both models
`/api/cron/ppw-generate` nightly:
- **SFR (scope_level=property):** for each active property-rule by the resolution
  order, evaluate → winning properties → create per-property Services (dedup on
  (property, worktype, window)).
- **Community (scope_level=community):** for each active community-rule, evaluate →
  winning communities (+ zone) → create one **contract-occurrence** Service per
  cadence hit (dedup on (community, worktype, zone, occurrence-date)).
- Both stamp `source_rule_id`, resolved rate + `rate_source`, preview marker if
  non-prod; assignment (vendor by worktype/coverage/capacity) runs after.

### 8. Suggested build phases
1. **Foundation:** worktype taxonomy (`lib/ppw/worktypes.ts`) + `Services` object +
   `scope_level`; Company/Community `ppw_*` fields + rate config record.
2. **Capture slice (end-to-end):** manually create a Service → reuse Answers capture
   → coordinator review/approve → PDF. Proves the reuse spine before the engine.
3. **Vendor login + `/vendor` UI** (OTP vendor session + scope gate + security
   review).
4. **Rules engine:** condition builder URL + hybrid evaluator + conflict
   analyzer/dry-run/explain; then the **generate cron** (SFR then community).
5. **Assignment, billing/export-to-pay, AI before/after** — later pillars.

### 9. Still-open decisions
1. **Worktype vs scope** — adopt orthogonal `scope_level` (recommended) or a literal
   "Community Work" worktype?
2. **Property-scoped rate order** — vendor(Company) before community, or reverse?
3. **Vendor multi-user** — one `ppw_login_email` per Company or a list?
4. **Zones** — is whole-community enough for v1, or are parts needed day one?
5. **Assignment engine** — auto (capacity/OTD) vs. coordinator-assigns in v1.

## 10.8 Architecture v3 — LATEST decisions (owner) + naming

Refines §10.7. Where they differ, THIS wins.

### Naming — project is "ResiWalk - Services"
"PPW" is only shorthand for the incumbent vendor being replaced. **Nothing we build
carries that name** — not code, env vars, routes, or HubSpot fields/objects. Code
artifacts already renamed: `SERVICES_FLAG_ON`, `servicesEnabled` (`lib/
servicesAccess.ts`), `ServicesEnvBadge`, `NEXT_PUBLIC_SERVICES_ENABLED`,
`SERVICES_TEST_MARKER = 'services_preview_test'`, preview tab "ResiWalk - Services".
All new HubSpot fields use a **`service_*`** prefix; routes are `/services/*`,
`/admin/services/*`, `/vendor`, `/api/services/*`, cron `/api/cron/services-generate`.

### 1. Scope level — CONFIRMED
`scope_level` (`property` | `community`) on `Services`, orthogonal to `worktype`, as
in §10.7. Good.

### 2. Rates — individual NUMERIC FIELDS, not JSON
Reversed from §10.7's `*_rate_json`. Each rate is its **own numeric HubSpot
property** (reportable, filterable, override-able in the UI without JSON editing):
- **Worktype default rate** → a numeric field per worktype on the **singleton
  Services config record** (e.g. `service_default_rate_grass_cut`,
  `service_default_rate_pool_service`, …). Not its own object.
- **Vendor override** → a numeric field per worktype on the **Company** object
  (e.g. `service_rate_grass_cut` …). Only for worktypes that vendor is priced on.
- **Community rate** → a numeric field per worktype on the **Community** object
  (same field names).
- **Resolution (stamp `rate_source` on the Service):**
  - **property scope:** worktype default → **overridden by the Company (vendor)
    field** when set.
  - **community scope:** **ALWAYS the Community field** (falls back to worktype
    default only if the community field is blank).
- Field naming grows with the worktype list; keep the set in `lib/services/
  worktypes.ts` and mirror to HubSpot so code + fields stay in lockstep.

### 3. Vendor login — ONE per Company
Single `service_login_email` on the Company (not a list). Email-OTP vendor session
bound to that Company, as in §10.7 §4.

### 4. Coverage areas & ZONES — needed day one (Region ▸ County)
Vendors (and community zones) are scoped by an **area = a checklist of Regions and
Counties**, where **counties nest under a region**:
- **Regions** = the existing unique region set on the Property object
  (`region_snapshot` / `region_rate`, e.g. "GA: Atlanta") — reused, not reinvented.
- **Counties** = unique county values on the Property object, **grouped under their
  region** (e.g. GA: Atlanta ▸ {Fulton, DeKalb, Cobb, Gwinnett, Clayton…}).
- Build a cached **coverage taxonomy** `Region → Counties[]` derived from Property
  data (refreshed on a schedule), presented as a nested checklist.
- **Vendor coverage** = the selected regions/counties, stored on the Company as
  `service_coverage_json` (the ONE place a JSON list is justified — it's a
  selection set, not a queried numeric). Used by auto-assignment (match a Service's
  property/community region+county to covering vendors) and to define community
  **zones** (a contract can target a region/county subset of a community).

### 5. Assignment — auto, editable in the rules engine (which is ALL-encompassing)
The **rules engine governs everything**: generation conditions, cadence, scope,
worktype, **rate resolution, AND assignment** — not just "who to generate."
- **Assignment is auto by default:** match Service (region+county, worktype) → the
  set of vendors whose `service_coverage_json` covers it and whose `service_worktypes`
  include it → rank by capacity/OTD/quality → assign. The rule can **override**
  (pin a vendor, restrict the candidate pool, or set a manual assignment) right in
  the engine. One engine, one place to reason about all logic.

### 6. ⚠️ MOCKUP FIRST — before any build
Owner wants to **see a rules-engine mockup** before we build. Deliverable: an
interactive design mockup of the all-encompassing rules engine (rule list/coverage
board, the rule editor with condition builder + cadence + rate resolution preview +
assignment + live "matches N / which targets" + conflict analyzer). Build starts
only after mockup sign-off.

### Still-open (post-mockup)
- Worktype **subcategory** depth (per §10.7) — finalize once the mockup shows how
  rules branch on them.
- County source field name on Property (confirm the exact HubSpot property).
- Capacity/OTD inputs for auto-assignment ranking (which metrics, from where).

## 10.9 Architecture v4 — rules-engine refinements (owner feedback on the v1 mockup)

### Branding
Match the live app: reuse the current ResiWalk mark (`public/favicon.svg`, the pink
house) + wordmark **"ResiWalk Services"**. Same look as production, not a bespoke
console skin.

### Targeting — portfolio/community FIRST, field-conditions optional
This changes the rule's primary shape. The everyday way to aim a rule is a list
pick, not field predicates:
- **Scope = Property → labeled "SFR".** Primary target = **Portfolio** (multi-select).
  Options are a **dynamic unique list of portfolios pulled from the Property object.**
- **Scope = Community.** Primary target = **Community name** (multi-select), options
  = the **unique community names from the Community object.**
- Either selection shows the **exact property impact count** ("these portfolios /
  communities = N properties").
- The nested **AND/OR field-condition builder stays but is OPTIONAL** — collapsed by
  default, used only to narrow further (home type, lot size, has-lawn, etc.).

→ Implies a **Portfolio** concept (see New objects). Portfolios group properties and
carry pricing markup.

### Cadence — relative to LAST COMPLETION (not a calendar tick)
"Every 14 days" means **14 days after the last completed** service of that worktype
on that property — not a fixed calendar cadence. The generator reads the last
completed Service date per (property, worktype) and schedules the next accordingly.

### Cease / stop conditions (NEW rule component)
A rule must also say **when to STOP.** e.g. a home becomes tenant-occupied/leased →
stop generating grass cuts AND auto-cancel any open (scheduled, not-yet-done) work
orders for it. Modeled as a stop-predicate over property/community fields; on match,
halt future generation + cancel open WOs for that target+worktype.

### Coverage area — keep; multi-region confirmed
Region ▸ County checklist stays. Multi-region selection is expected.

### Assignment
- Multi-region select.
- **Vendor capacity is a field on the vendor (Company) object** — used in ranking.
- Keep **on-time %**. Auto-assign by **vendor coverage (regions/counties) + capacity
  + OTD**.

### Vendor Management — a SEPARATE Services section (NEW)
A dedicated area (nav tab) to manage each **recurring-service-eligible** vendor:
- `service_is_vendor_eligible` toggle,
- **coverage**: pick serviced **regions + counties** (the checklist lives HERE on the
  vendor, not inside each rule),
- `service_weekly_capacity`, `service_otd_rate`, quality.
Coverage/capacity are owned by the vendor record; rules and auto-assign read them.

### Rates — vendor amount + client amount, markup % by PORTFOLIO per worktype
Reworks §10.8's single number:
- Every Service resolves **both a vendor amount and a client amount.**
- Both can **vary by portfolio.**
- **Markup % is defined per (portfolio, worktype):** `client = vendor × (1 + markup%)`.
- **Vendor amount** source: worktype default → assigned-vendor's rate (Company).
- **Client amount** = resolved vendor amount × the (portfolio, worktype) markup %.
- Stamp both + `rate_source` on the Service.

### New objects (owner is open to adding for clean organization)
Recommended minimal set:
- **`Portfolio`** (NEW object) — the dynamic groupings properties already carry;
  promote to a real object so it can hold **per-worktype markup %** and associate to
  Properties (and Communities). This is where client pricing lives.
- **`Rate Book`** — a small object of rows `(scope: default|portfolio, portfolio,
  worktype) → vendor_amount, markup_pct`. Alternative to putting markup fields
  directly on Portfolio; pick one (recommend markup on **Portfolio**, base vendor
  amounts in a tiny default Rate Book, to avoid a 2nd object).
- Everything else as prior: `Services`, `Service Rule` (+ cease + cadence-from-
  completion + portfolio/community targeting), Companies (vendors), Community.
- **Open:** for community-scope work, does the client markup come from a
  Portfolio the community maps to, or a Community-level rate? (Flag — decide when we
  wire pricing.)

### Mockup v2 (this session)
Rebuilt with ResiWalk branding + a 3-tab console — **Rules Engine / Vendors / Rate
Book** — reflecting all of the above.

## 10.10 Mockup sign-off tweaks + build protocol

### Final rule-model tweaks (mockup approved after these)
- **No `subcategory`, no `priority`.** Drop both fields. Overlap resolution is now by
  **specificity** (a rule targeting specific portfolios/communities beats an
  all-portfolios base rule); the conflict analyzer still surfaces genuine ties for
  the author to resolve — no silent clobber.
- **Cadence = any interval.** "Repeat every **N** days from the last completed"
  (free numeric, not presets).
- **Work-order due date = issue date + N** (the repeat interval).
- **Active window = start month → stop month** (explicit months, replaces "season").

### Build protocol (owner directive)
- **Step-by-step, announce-before-build.** Before writing code for any step, state
  exactly what that step builds and wait for the go-ahead. One increment at a time.
- **Branch-only.** ALL Services work stays on `recurring-services` (Vercel preview,
  prod-HubSpot, flag+admin gated) until the owner says otherwise.
- **Home toggle on deploy.** The ResiWalk home page gets an **Inspections (current)
  ↔ Services (new)** switch so the owner can track every Services item as it lands.
  This is the first build increment (the container the rest lands in). Flag+admin
  gated → invisible on production `resiwalk.com`.

## 10.11 Preview feedback round 2 — rules-engine restructure + completion flow

### Services list / card
- Card no longer shows region; the card is **clickable → a service completion
  flow** (`/services/[id]`): a short question checklist, before + after photos, and
  Submit Completion (moves it to Submitted). This is the vendor's execution surface
  (reuses the Answers/photo pattern for real in a later step).

### Rules engine — hard rule + restructure
- **One property → one rule per worktype.** Overlapping coverage (same worktype +
  scope, shared portfolio/community with another ACTIVE rule) **blocks save**. This
  replaces the "overlap hint / live-impact conflict" panel — that's removed; a rule
  that would overlap simply can't be saved.
- **Rule list actions:** active/inactive toggle, **duplicate** (clone all settings,
  then just change the community/portfolio), and **delete**.
- **Three sections (assignment removed):**
  1. **Work type → coverage (Property/Community + portfolio/community pick) →
     pricing:** vendor cost, **markup % (editable)**, client cost (= vendor ×
     (1+markup), shown).
  2. **Cadence:** every **X days / weeks / months**; weeks → pick day-of-week,
     months → pick day-of-month. **Per-month cadence blocks** — assign each month to
     a cadence (e.g. every 2 wks Jun–Jul, every 10 days elsewhere). A month belongs
     to exactly one block. **All 12 months must be covered to save** (a property has
     one rule per worktype, so the rule owns the whole year).
  3. **Enrollment & stop (one section):** an **enrollment trigger** (property status
     or any field criteria) **creates** the services; each service **auto-recreates
     when the last is submitted** until the **optional stop criteria** is met.
- **Live impact removed** → just a **"properties covered"** count.
- **Vendor assignment is NOT in the engine.** The engine only *creates* services;
  assignment happens separately in **Vendor Management** (driven by Properties /
  Communities coverage). To be built as its own area later.

## 10.12 Callout — community contracts live on the Community object

Owner clarification (no build). For **community-level** work, the **vendor(s),
pricing, and scope-of-work / cadence all live on the Community object** — not in a
rules-engine rule. That configuration surfaces and is managed in **Vendor
Management** (reached from the **gear/settings** dropdown on the Services tab).

So the split is:
- **Scattered SFR** → generated by the **Rules Engine** (portfolio targeting,
  enrollment/stop, cadence, pricing), assigned separately by Vendor Management.
- **Community contracts** → configured **per community on the Community record**
  (vendor + pricing + scope + cadence), managed in **Vendor Management**; the engine
  doesn't own these.

Implication to confirm when we build: this likely means the Rules Engine's
**Community coverage option is dropped** (the engine becomes SFR-only), and the
current mockup's "Community" scope moves into the Vendor Management / Community-record
UI. Flag — decide at Step-2 planning. Vendor Management itself is still a later step.

## 10.13 Service status pipeline (owner-defined)

The `Services` status enum (Step 3):
**Estimated → Assigned → Submitted → Review → Completed**, plus **Canceled**
(terminal; set when the stop logic cancels a late/open order).
- Open (for the bubbles) = Estimated / Assigned / Submitted / Review; Completed &
  Canceled are closed. (Completed feeds On-Time %.)
- **`Estimated` is only for BID ITEMS** — a bid service starts in Estimated (needs a
  vendor estimate before work). **Every non-bid service starts at `Assigned`**
  (skips Estimated). The generator sets the initial status by whether the line is a
  bid item.
(Replaces the earlier sample scheduled/dispatched/in_progress/cancelled set.)

## 10.14 Default pricing, answer-driven price rules, and Q&A storage

### Default vendor pricing (property coverage) + markup
Per-worktype base vendor cost, with a **default 20% markup** on every service
(client = vendor × 1.20; markup still editable per rule):
- **Grass Cut** — base **$45** (< 6 in).
- **Pool Service** — **$100**.
- **Clean** — **$75**.
New rules prefill vendor cost from the worktype and markup to 20%.

### Answer-driven pricing (applied at completion)
- **Grass length tiers** — the completion checklist asks grass length; the vendor
  payout **promotes** to the tier: **< 6 in $45 (default) · 6–12 in $60 · > 12 in $90**.
- **Yard access** — completion asks "had access to the whole yard/backyard?"; if
  **No**, a **global rule reduces the vendor payout by 25%**.
→ So some questions carry a **price effect** (set/promote a tier, or apply a
  payout adjustment). This lives with the question definition (below).

### Q&A storage per service type (design)
Each worktype has a **small completion question set (≤5)**, **editable in ResiWalk
Services settings**. Recommended:
- **Definition** (the questions) → a JSON blob per worktype on the **Services config
  record** (same config-record pattern as the rate defaults), editable via a
  Settings screen. Each question: `id, label, type (yesno | select | short | long |
  photo), options[], required`, plus an optional **`priceEffect`** (e.g.
  `{ kind:'tier', map:{'6-12in':60,'>12in':90} }` or `{ kind:'payoutAdjustPct',
  when:'no', value:-25 }`).
- **Answers** (what the vendor submits) → the existing **Answers object**, keyed to
  the Service (reusing the inspection Answers pattern + photo pipeline), so the
  completion flow, evidence photos, and PDF reuse carry over unchanged.
- The completion screen renders the worktype's question set; price-effect answers
  recompute the vendor payout at submit. (Editable-settings screen = a later step.)

### Vendor Assignment
Added the **Vendor Assignment** link to the Services gear menu → a gated
**"Coming Soon"** page for now (assignment is separate from the Rules Engine).

## 10.15 Generation & scheduling logic (nightly job)

Applies to ALL worktypes, both property and community coverage.

### Optional "initial due" on the rule
Each rule has an **initial due** = the first order's due date is **N days after
enrollment** (usually quicker than the recurring cadence), **defaulting to 5 days**.
Blank → the standard cadence applies to the first order too. (Built into the
Cadence section.)

### Nightly job — what it does
1. Find every property/community that **meets a rule's enrollment criteria**.
2. Skip any that already have an **OPEN work order** for that worktype, where
   **open = {Assigned, Submitted}** among **non-bid** services. **Bid-item services
   are ignored entirely** — they don't block a new recurring order. (See the
   `is_bid_item` field below — bid classification is a persistent flag, NOT the
   `Estimated` status.)
3. If it needs one, create it:
   - **Initial order** (the target just met enrollment / has no prior order for this
     rule) → due date = enrollment date + **initial due** (if set), else standard
     cadence.
   - **Subsequent order** → **standard cadence** (below).
4. A target keeps generating as long as it still meets enrollment, **until the stop
   criteria is met**.

### Next-order due date (the recurrence math)
`next due = MAX(completion date, current due date) + cadence interval`
where completion date = when the vendor submitted.
- e.g. due Jul 10, every 14 days, completed **early** Jul 7 → next due =
  max(Jul 7, Jul 10) + 14 = **Jul 24**.
- completed **late** Jul 12 → max(Jul 12, Jul 10) + 14 = **Jul 26**.

### Stop criteria → cancel open orders
When a target hits the stop criteria, **cancel its open orders**, EXCEPT:
- never touch **Review / Completed** orders,
- never touch **bid-item services** (they're not part of the recurring lifecycle),
- **protect imminent ones — due within the next 48 hours** (a vendor may already be
  dispatched, so let them run). CONFIRMED.
- Everything else open (not Review/Completed, not a bid, not due in <48h) is
  canceled — including **past-due, not-yet-completed** orders (they're late).
- Canceling sets the new **`Canceled`** status (a terminal state).

### `is_bid_item` — a persistent flag (not a status)
Bid classification is its **own boolean field on the Services record**, set when the
service is created and **independent of status** — because a bid's status changes
over its life (Estimated → Assigned → …). Generation and stop-cancel both key off
`is_bid_item`, NOT the `Estimated` status. (`Estimated` remains the *initial status*
for bid items per §10.13, but it is not how we identify a bid afterward.)

## 10.16 Property coverage inclusion: "all" (future-inclusive) vs fixed "list"

A property-scope rule stores coverage as **portfolios + regions + a `propsMode`**:
- **`all`** (chosen via unfiltered "Select all") — every applicable property in the
  selected portfolios ∩ regions, and **NEW properties added later auto-include**.
- **`list`** — a **fixed** set of property ids (`includedProps`). Set whenever the
  user hand-picks: any individual deselect, or a "Select all" done while searching.
  **Future-added properties do NOT auto-include.**
So auto-include-on-add happens **only** when the whole set was selected; a specific
hand-picked list stays exactly as chosen. (Step-3 generation reads the same rule:
in `all` mode it re-resolves the applicable set each night; in `list` mode it uses
the stored ids.)

## 10.17 Worktype + subtype taxonomy, rates, pet stations, contract cadence

### Worktype + Subtype (every worktype has ≥1 subtype — uniform)
- **Landscaping** → Cut, Flowers, Tree Trimming, Mulch / Pine Straw
- **Cleaning** → Common Area, Model Home, Move-In Clean, Vacant Clean, One-Time
  Clean, On-Market Clean
- **Pools** → Pool Cleaning
- **Trash Removal** → Trash Pickup
- **Trip Fee** → Base Trip Fee
Both worktype and subtype are selectable everywhere (rules engine, New Service);
the card/completion show "Worktype · Subtype".

### Default rates (per subtype, before the 20% markup)
- Cleaning: **Common Area $125/wk · Model Home $100/wk · Move-In / Vacant /
  One-Time / On-Market $75** each.
- Pools: Pool Cleaning **$100**. Landscaping: Cut **$45**. Others unset (editable).
Default rate lives on the subtype; new rules / worktype+subtype changes prefill
the vendor cost. Description default is per worktype (editable per rule).

### Community "Include pet stations?" (on the RULE)
For **community**-scope rules, a **Yes/No** toggle. When **Yes**, each generated
work order gets a **dedicated pet-station Before/After** photo group in the
completion flow (separate from the main before/after).

### Cadence generation nuance (contracts vs one-offs) — refines §10.15
- **Weekly / Monthly cadence = a contract:** generate on schedule whenever the
  enrollment criteria is met, **regardless of open work orders**.
- **Daily (every N days) = the prior logic:** only generate when nothing is open
  (Assigned/Submitted, non-bid), next due = MAX(completion, current due) + N.
- Cadence UI: the interval number is freely editable (clearable), and the weekly
  day-of-week / monthly day-of-month is **optional** ("Any day").

## 10.18 Recurring toggle + vendor assignment on the rule (owner-defined)
### Recurring vs one-time (on the RULE)
- Section 2 opens with **"First order due after enrollment" (default BLANK** — blank
  = due on the enrollment date; a number = due N days later).
- Then a required **"Is this recurring?" Yes/No** gate:
  - **Yes** → show one cadence block by default; the No-Service (skip months) block
    is **not** shown by default — it's added on demand. Both **`+ Cadence`** and
    **`+ No Service`** let the user add as many as needed. The "every month
    accounted for" validation applies only when recurring.
  - **No** → one-time: no cadence UI, no ability to add cadence/no-service, and the
    month-coverage validation is skipped. A single work order is created when the
    enrollment criteria is met. Because there is no cadence to schedule from, the
    **"First order due after enrollment" is REQUIRED** when recurring = No (it sets
    the single order's due date); it stays optional when recurring = Yes.
- Model: `recurring: boolean` on the Service Rule.

### Vendor assignment on the rule (equal-volume rotation + sticky-per-address)
- Section 1, under pricing: **Vendor Assignment** — searchable multi-select of
  companies (Vendors = Companies object). **At least one** required to save; the
  picker shows each company's **current open volume** as the count.
- Model: `vendors: string[]` on the Service Rule.
- Assignment logic (generation-time — plan only; not executed in the sample preview):
  - **One vendor** → every service on the rule is assigned to them.
  - **Multiple vendors** → **net-new enrollments** are assigned to keep **open
    volume even** across the rule's vendors: the vendor with the lowest open count
    gets the next enrollment, ties broken deterministically, until balanced (e.g.
    counts 5/4/2 → the next two enrollments go to the "2" vendor, then round-robin).
  - **Sticky per address:** once a property is enrolled, **every subsequent service
    for that property keeps the same vendor** for the life of that enrollment —
    regardless of the equal-volume rule — e.g. a vacant-home grass cut every 10 days
    stays with the same vendor for all 3 months it's vacant.
  - Re-enrollment resets stickiness: if enrollment **stops** and later **re-starts**,
    the property rejoins the equal-volume rotation and may land on any current vendor.
  - If a vendor is **removed** from the rule's vendor list, in-flight sticky
    properties fall back to the equal-volume rotation on their next enrollment.

## 10.19 Stop-criteria modes + one-time (run-once) enrollment integrity
### Stop criteria — three modes (on the RULE)
`stopMode` ∈ {`condition`, `date`, `count`}:
- **condition** — a Property/Deal field changes (existing behavior, e.g. status → Occupied).
- **date** — stop on a fixed date; cancel remaining open orders past that date.
- **count** — stop after N completed services on the property (rolling per enrollment).

### The move-in-clean problem (run-once, event-triggered)
Scenario: dispatch a **move-in clean** when a property's associated **deal** reaches a
leasing-pipeline stage; it must run **once** and must NOT be recreated by the nightly
job if the clean completes before the property flips to leased/occupied.

Root cause to design around: a **level-triggered** enrollment ("deal IS in stage X")
stays true for days, so a nightly job that only checks "condition true AND no open WO"
will happily create a second clean after the first completes. Recommended safeguards:

1. **Edge-trigger, not level-trigger.** Enroll on the **transition into** the stage,
   not on the stage being true. Persist the last-seen stage per deal (or consume
   HubSpot stage-change events) so the trigger fires exactly once per transition.
2. **Idempotency key per enrollment instance.** For run-once rules, key generation on
   the **triggering entity** — the deal id: *one service per (rule, deal)*. Record the
   deal id (or a hash) on the created Service (`enrollment_key`). The nightly job skips
   any (rule, deal) it has already produced — regardless of whether that service is
   open, completed, or canceled. This is the durable guarantee, independent of timing.
3. **Non-recurring = terminal on completion.** Recreation logic (MAX(completion,due)+
   interval, open-WO checks) applies to `recurring:true` only. A `recurring:false` rule
   never recreates; completion is the end state for that enrollment.
4. **Re-arm only on a new enrollment instance.** The rule can fire again only when a
   *new* triggering entity appears (a new deal / a fresh vacant→leased cycle) — i.e. a
   new `enrollment_key`. The same deal never yields a second clean.
5. **Guard window / dedup lookback.** Belt-and-suspenders: before creating, check for
   any Service on the property for this rule within a lookback window (e.g. the current
   lease/enrollment) and skip if found — covers races and manual creations.

Net: for the move-in clean, set the rule **non-recurring**, enroll on the deal-stage
**edge**, and dedupe on the **deal id**. That combination makes "run exactly once per
lease" robust even when completion beats the property-status change.

## 11. Changelog
- _init_ — created from owner's vision + Grok breakdown; reuse map grounded in the
  current codebase (HubSpot objects, cron infra, vendors, billing, evidence, roles).
- _architecture-v1_ — locked object model (reuse Q&A + Properties + Communities;
  Vendors = Companies; new Services + Service Rule; worktype enum; hybrid rule
  evaluator with app URL editor + HubSpot store; rate precedence; nightly generate
  cron). Open decisions listed in §10.6.
- _architecture-v4_ (§10.9, LATEST) — rules-engine refinements from mockup feedback:
  ResiWalk branding; portfolio/community list-targeting first (dynamic unique lists)
  with exact property impact counts, field-conditions optional; cadence relative to
  last completion; cease/stop conditions; vendor capacity on the Company + a separate
  Vendor Management section owning coverage; rates split into vendor + client amounts
  with markup % by portfolio per worktype; new `Portfolio` object (+ optional Rate
  Book). Mockup v2 = Rules Engine / Vendors / Rate Book console.
- _architecture-v3_ (§10.8) — project named **ResiWalk - Services** (PPW =
  incumbent vendor only, never used in artifacts; code renamed); scope_level
  confirmed; rates as individual NUMERIC fields (worktype default on config record,
  Company + Community overrides) not JSON, with property→vendor / community→Community
  resolution; ONE vendor login; coverage areas & zones day-one as Region▸County
  checklists sourced from Property data; assignment auto + editable in the
  all-encompassing rules engine; MOCKUP required before build.
- _architecture-v2_ (§10.7) — owner input: two work models (scattered SFR
  single-WO vs community contracts) → `scope_level` on Services; scope made
  orthogonal to worktype (recommended); 3-tier rate resolution with worktype
  default in a HubSpot config record (no new object) + Company/Community overrides;
  non-HubSpot **vendor logins** via email-OTP vendor sessions + `/vendor` UI + hard
  scope gate; **conflict-clean rules engine** (deterministic resolution, save-time
  conflict analyzer, dry-run, coverage board, explain view, generation invariants);
  build phases. Still PLANNING — no product code yet.
- _dev-harness_ — added the `recurring-services` branch + Vercel Preview workflow,
  `lib/featureFlags.ts` (pure client-safe flags: PPW_FLAG_ON / ppwWritesAreTest /
  PPW_TEST_MARKER), `lib/ppwAccess.ts` (server `ppwEnabled` admin gate) and the
  `PpwEnvBadge`. Deploy isolated from resiwalk.com; HubSpot kept on production per
  owner. Still PLANNING — no product code yet.
