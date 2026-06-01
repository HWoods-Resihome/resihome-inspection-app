# Rate Card — Phase 1 Specification

**Date:** 2026-05-27
**Status:** Schema setup + initial data load
**Target portal:** Sandbox 51415639 (ResiTest)

This document captures the complete data model and decisions for Phase 1.
Phases 2 (API), 3 (Inspector UI), and 4 (PDF generation) build on this foundation.

---

## Custom objects

### 1. `rate_card_line_item` (the catalog)

| Property | Type | Description |
|---|---|---|
| `line_item_code` | string (unique) | Natural key (e.g., `APLSL1009`). Maps to catalog Labor Code. |
| `labor_short_description` | string | Inspector-visible item name. |
| `category` | enum | Appliance, Cabinet, Carpentry, … (27 values including HVAC SIBI Units) |
| `subcategory` | string | Free-text mid-level grouping |
| `labor_code` | string | Internal labor code (same as line_item_code today) |
| `labor_full_description` | textarea | Full scope of work |
| `labor_meas` | enum | EA, LF, SF, HR, DAY, RM, SQ, CY, BND, LBS, GAL, BAG, ROLL |
| `labor_hours` | number | Labor hours per 1 unit |
| `labor_hourly_rate_list` | number | **Reference only.** Real rate comes from region matrix |
| `material_code` | string | Internal material code |
| `material_description` | textarea | Full SKU detail |
| `material_meas` | enum | Same as labor_meas |
| `material_rate` | number | Consumption ratio per labor unit (e.g., 0.125) |
| `material_qty` | number | Multiplier on quantity (usually 1.0) |
| `material_cost` | number | Base cost per unit, pre-regional-adjustment |
| `bill_to` | enum | Owner / Tenant / ResiHome |
| `work_type` | enum | Repair / Replace / Other |
| `is_labor_only` | bool | If true, material side is zero |
| `is_bid_item` | bool | If true, inspector enters custom price |
| `is_active` | bool | False for deprecated items (historical inspections preserved) |
| `catalog_version` | string | Date stamp of last load |

**Bid item detection:** description contains "Bid Item" (case-insensitive). All 25 bid items in the current Excel match BOTH the description text and the code suffix `9998`/`9999` — both signals are consistent.

### 2. `region_rate` (the rate matrix)

One record per region. Currently 18 regions.

| Property | Type | Description |
|---|---|---|
| `region` | string (unique) | E.g., `GA: Atlanta`. Matches `region` on the property/home object exactly |
| `material_cost_adjustment` | number | Decimal multiplier (e.g., 1.0152) |
| `material_tax_adjustment` | number | Decimal added: `1 + value` (e.g., 0.07 → 7%) |
| `rate_appliance` | number | Hourly rate for Appliance category |
| `rate_cabinet` | number | …Cabinet |
| `rate_carpentry` | number | …Carpentry |
| ... (26 category rates total including HVAC SIBI Units) | | |
| `rates_version` | string | Date stamp of last load |
| `is_active` | bool | |

### 3. Existing objects — fields added

#### `inspection_answer` (used for Rate Card line entries)

**Rate Card line metadata:**
- `rate_card_line_item_code` — FK to `rate_card_line_item.line_item_code`
- `quantity_decimal` — number
- `tenant_bill_back_percent` — enum (0%, 5%, 10%, …, 100%)
- `is_custom_priced` — bool

**Snapshots (12) — captured at line creation time:**
- `category_snapshot`, `subcategory_snapshot`, `region_snapshot`
- `labor_hours_snapshot`, `labor_hourly_rate_snapshot`
- `material_rate_snapshot`, `material_qty_snapshot`, `material_cost_snapshot`
- `material_cost_adjustment_snapshot`, `material_tax_adjustment_snapshot`
- `is_labor_only_snapshot`, `is_bid_item_snapshot`

**Computed totals (5) — stored, not live:**
- `labor_total`, `material_total`, `vendor_cost`, `client_cost`, `tenant_cost`

**Picklist addition:** `answer_type` += `rate_card_line`

#### `inspection`

**Aggregates:**
- `total_line_items`, `total_vendor_cost`, `total_client_cost`, `total_tenant_cost`, `total_line_quantity`

**PDFs:**
- `pdf_attachment_url` *(existing, reused for master)*
- `tenant_chargeback_pdf_url`
- `vendor_pdfs_json` *(JSON: vendor name → URL)*
- `pdf_bundle_zip_url`

**Region:**
- `region_snapshot` — captured at inspection start, locked thereafter

**Picklist additions:**
- `template_type` += `pm_scope_rate_card` ("(PM) Scope Rate Card")
- `status` += `pending_approval` ("Pending Approval")

---

## Associations

| From | To | Label |
|---|---|---|
| Inspection | Rate Card Line Item | "Uses Catalog Item" |
| Rate Card Line Item | Inspection | "Used By Inspection" |

---

## Calculation formula

At line save time, the app reads catalog values + region matrix values, snapshots them, and computes:

```
effective_labor_rate    = region_rate.rate_{category}            # falls back to GA:Atlanta / Inspections if no match
adjusted_material_cost  = material_cost
                        × material_cost_adjustment
                        × (1 + material_tax_adjustment)

labor_total    = labor_hours × effective_labor_rate × quantity
material_units = MAX(1, material_rate × material_qty × quantity)   # floor the FULL consumption at 1 whole unit
material_total = 0 if (is_labor_only OR material_rate == 0) else
                 material_units × adjusted_material_cost

vendor_cost = labor_total + material_total
client_cost = vendor_cost × 1.20            # markup hardcoded 20%
tenant_cost = client_cost × (tenant_bill_back_percent / 100)
```

**Bid items:** inspector can override `effective_labor_rate` and/or `adjusted_material_cost` at line creation. The formula still applies. `is_custom_priced=true` is set.

**Rounding:** no rounding until final display. Display rounded to 2 decimals.

**Fallback:** when region or category is not found in the matrix, use `GA: Atlanta` + `Inspections` rate ($53.71/hr).

---

## Deferred to later phases

- Phase 2: API endpoints (`/api/rate-card/catalog`, line CRUD)
- Phase 3: Inspector UI with line picker modal, edit-in-place, per-section totals
- Phase 4: Three PDFs (master, tenant, vendor-specific) + ZIP bundle, generated at Pending Approval → Completed transition
- Phase 4.5: Custom section management (add/remove sections beyond the standard 21)
- Phase 5: Email automation, Snowflake views, Power BI

---

## Run order

```bash
cd scripts/rate_card_phase1
# Make sure HUBSPOT_TOKEN is set (env or .env.local at repo root)
python3 phase1_step1_create_rate_card_catalog_object.py
python3 phase1_step2_create_region_rate_object.py
python3 phase1_step3_extend_inspection_and_answer.py
python3 phase1_step4_create_associations.py
python3 phase1_step5_load_data.py
```

Each step is idempotent. Safe to re-run any of them.

---

## Verification checklist after running

In HubSpot sandbox:

1. **Settings → Objects → Rate Card Line Items**
   - Object exists with 853 records
   - Spot check `APLSL1009` (Replace Electric Cooktop White 30)
   - Spot check `APLSL9999` (Bid Item, `is_bid_item=Yes`)
   - Spot check `APLSL1025` (Labor Only, `is_labor_only=Yes`)

2. **Settings → Objects → Region Rates**
   - Object exists with 18 records
   - Spot check `GA: Atlanta`: `rate_appliance=69.38`, `rate_inspections=53.71`, `rate_hvac_sibi_units=74.99`, `material_cost_adjustment=1.0152`, `material_tax_adjustment=0.089`

3. **Settings → Objects → Inspections → Properties**
   - New fields present: `total_line_items`, `total_vendor_cost`, `total_client_cost`, `total_tenant_cost`, `total_line_quantity`, `tenant_chargeback_pdf_url`, `vendor_pdfs_json`, `pdf_bundle_zip_url`, `region_snapshot`
   - `template_type` picklist includes `pm_scope_rate_card`
   - `status` picklist includes `pending_approval`

4. **Settings → Objects → Inspection Answers → Properties**
   - 17 new rate card properties present (rate_card_line_item_code, snapshots, totals)
   - `answer_type` picklist includes `rate_card_line`

5. **Settings → Objects → Inspections → Associations**
   - `Uses Catalog Item` association exists
