# ResiWALK → Recurring Services — Planning Doc

> **Codename / reference: "PPW Replacement."** This is the in-house recurring-services
> initiative meant to replace the external PPW vendor (the current default for grass
> cuts / cleans / pools — see `lib/vendors.ts`) by bringing those recurring services
> in-house with our own scheduling, dispatch, evidence, and invoicing.
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

## 11. Changelog
- _init_ — created from owner's vision + Grok breakdown; reuse map grounded in the
  current codebase (HubSpot objects, cron infra, vendors, billing, evidence, roles).
