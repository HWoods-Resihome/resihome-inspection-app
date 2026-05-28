# Rate Card Phase 1 — Run Guide

Five Python scripts, run in order, to set up the Rate Card data model in HubSpot sandbox.

## Prerequisites

- Python 3.9+
- `pip install pandas openpyxl`
- HubSpot private app token with object/schema/property write scopes
  - Set as `HUBSPOT_TOKEN` env var, OR
  - In the inspection app's `.env.local` file (the script walks up to find it)

## Files in this directory

```
_hubspot_helpers.py                                   # shared HTTP + schema helpers
phase1_step1_create_rate_card_catalog_object.py       # creates rate_card_line_item object
phase1_step2_create_region_rate_object.py             # creates region_rate object
phase1_step3_extend_inspection_and_answer.py          # adds fields to existing objects
phase1_step4_create_associations.py                   # creates association schemas
phase1_step5_load_data.py                             # loads 853 catalog rows + 18 regions
line_items.xlsx                                       # the catalog Excel (source data)
region_matrix.xlsx                                    # the region matrix Excel (source data)
PHASE1_SPEC.md                                        # full data model documentation
```

## Run order

```bash
# Verify token is set
echo $HUBSPOT_TOKEN  # or check .env.local

# Step 1: catalog object (rate_card_line_item)
python3 phase1_step1_create_rate_card_catalog_object.py

# Step 2: region rate object (region_rate)
python3 phase1_step2_create_region_rate_object.py

# Step 3: extend inspection + inspection_answer
python3 phase1_step3_extend_inspection_and_answer.py

# Step 4: associations
python3 phase1_step4_create_associations.py

# Step 5: load all data (catalog + region rates)
python3 phase1_step5_load_data.py
```

Each step is idempotent — safe to re-run. The loader (step 5) upserts by natural key
(line_item_code for catalog, region for regions), so re-running updates existing
records and creates new ones without duplicates.

## What you'll see

- Each script logs `[create]`, `[skip]`, `[patch]` for individual operations
- Step 5 prints progress every 100 records during catalog upsert (8-9 batches total)
- Total run time: ~3-5 minutes for a clean first run

## Verification

See PHASE1_SPEC.md "Verification checklist after running" for what to spot-check
in the HubSpot UI.

## When something goes wrong

- `HTTP 401`: token is wrong or missing — check env / .env.local
- `HTTP 403`: token doesn't have required scopes — regenerate with object/schema/property write access
- `HTTP 409` on object creation: object already exists with that name — usually OK (script handles this)
- Catalog upsert fails partway: re-run step 5; it picks up where it left off (upsert is idempotent)

## After Phase 1

Move to Phase 2: API endpoints for catalog reads and line CRUD.
