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
### Service (`service`)
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
- **Status:** Estimated, Assigned, Submitted, AI Processing, Review, Completed, Canceled
- **Coverage Scope:** Property, Community · **Property Mode:** All, List
- **AI Verdict:** Clean, Needs Review · **Stop Mode:** Condition, Date, Count
- **Operators:** is, is any of, is not, changes to

## Rollout order
1. **Dry-run** → review the report.
2. **Apply** → objects + properties + Question props (+ associations; re-run apply
   once objects exist so association type ids resolve).
3. Set the two env vars, redeploy.
4. Phase 1: build the Services read layer (`/api/services`) and swap the home
   list + calendar from sample data → real Services (behind the flag).
