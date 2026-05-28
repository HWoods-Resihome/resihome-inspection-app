"""
Phase 1, Step 5: Load data into HubSpot.

Loads:
  1. 853 catalog records into rate_card_line_item
     - Bid items detected (description match + code suffix 9998/9999, both consistent)
     - is_labor_only and is_bid_item flags set
     - is_active=true for all
     - catalog_version stamp = today's date

  2. 18 region_rate records, merging:
     - Original region matrix (region, material adjustments, 26 category rates)
     - HVAC SIBI Units rates (user-provided, separate sheet/manual entry)
     - rates_version stamp = today's date

Idempotent: upserts by natural key (line_item_code for catalog, region for regions).
Re-running updates existing records and creates new ones. No duplicates.

Run order:
    python phase1_step5_load_data.py

Environment:
    HUBSPOT_TOKEN must be set or be in .env.local.

Files (expected next to this script):
    line_items.xlsx     - the catalog spreadsheet
    region_matrix.xlsx  - the region matrix spreadsheet
"""

from __future__ import annotations
import datetime
import os
import sys

import pandas as pd

from _hubspot_helpers import batch_upsert_by_unique_property


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CATALOG_XLSX = os.path.join(SCRIPT_DIR, "line_items.xlsx")
REGION_XLSX = os.path.join(SCRIPT_DIR, "region_matrix.xlsx")


# HVAC SIBI Units rates per region (user-supplied; not in the region matrix Excel).
HVAC_SIBI_RATES = {
    "AL: Birmingham": 71.84,
    "AL: Huntsville": 71.67,
    "AZ: Phoenix": 100.00,
    "FL: Cape Coral": 76.33,
    "FL: Jacksonville": 65.72,
    "FL: Miami": 75.37,
    "FL: Orlando": 66.65,
    "FL: Space Coast": 76.15,
    "FL: Tampa": 67.87,
    "GA: Atlanta": 74.99,
    "GA: Savannah": 75.34,
    "IN: Indianapolis": 76.70,
    "NC: Charlotte": 73.49,
    "OK: Oklahoma City": 78.07,
    "SC: Greenville": 72.79,
    "TN: Nashville": 77.10,
    "TX: Dallas": 75.38,
    "TX: Houston": 78.05,
}


# Mapping from region matrix column name (catalog category) -> HubSpot property name on region_rate.
# Mirrors CATEGORY_RATE_FIELDS in phase1_step2.
CATEGORY_TO_PROPERTY = {
    "Appliance": "rate_appliance",
    "Cabinet": "rate_cabinet",
    "Carpentry": "rate_carpentry",
    "Cleaning": "rate_cleaning",
    "Concrete": "rate_concrete",
    "Doors": "rate_doors",
    "Drywall": "rate_drywall",
    "Electrical": "rate_electrical",
    "Fence": "rate_fence",
    "Flooring": "rate_flooring",
    "Garage Doors": "rate_garage_doors",
    "Gutters": "rate_gutters",
    "HVAC": "rate_hvac",
    "HVAC SIBI Units": "rate_hvac_sibi_units",
    "Inspections": "rate_inspections",
    "Landscape": "rate_landscape",
    "Painting": "rate_painting",
    "Pest Control": "rate_pest_control",
    "Plumbing": "rate_plumbing",
    "Remediation": "rate_remediation",
    "Roofing": "rate_roofing",
    "Septic": "rate_septic",
    "Siding": "rate_siding",
    "Trash/Debris Removal": "rate_trash_debris_removal",
    "Unit Turns (Paint/Clean/Minor Repairs)": "rate_unit_turns",
    "Utility Activation": "rate_utility_activation",
    "Windows/Glass": "rate_windows_glass",
}


def main():
    print("=" * 70)
    print("Phase 1, Step 5: Load data into HubSpot (sandbox)")
    print("=" * 70)

    if not os.path.exists(CATALOG_XLSX):
        print(f"ERROR: catalog file not found at {CATALOG_XLSX}", file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(REGION_XLSX):
        print(f"ERROR: region file not found at {REGION_XLSX}", file=sys.stderr)
        sys.exit(1)

    today = datetime.date.today().isoformat()

    # ----- Load catalog -------------------------------------------------
    print(f"\n--- Catalog ({CATALOG_XLSX}) ---")
    cat_df = pd.read_excel(CATALOG_XLSX)
    print(f"Read {len(cat_df)} catalog rows.")

    catalog_records = []
    for _, row in cat_df.iterrows():
        labor_code = _clean_str(row["Labor Code"])
        desc = _clean_str(row["Labor Short Description"])

        # Bid item: detected by both signals consistently. Use description match.
        is_bid = "bid item" in (desc or "").lower()
        is_labor_only = _clean_str(row.get("Labor Only", "")).lower() == "yes"

        props = {
            "line_item_code": labor_code,
            "labor_short_description": desc,
            "category": _clean_str(row.get("Category", "")),
            "subcategory": _clean_str(row.get("Subcategory", "")),
            "labor_code": labor_code,
            "labor_full_description": _clean_str(row.get("Labor Full Description", "")),
            "labor_meas": _clean_str(row.get("Labor Meas", "")),
            "labor_hours": _clean_num(row.get("Labor Hours")),
            "labor_hourly_rate_list": _clean_num(row.get("Labor Hourly Rate")),
            "material_code": _clean_str(row.get("Material Code", "")),
            "material_description": _clean_str(row.get("Material Description", "")),
            "material_meas": _clean_str(row.get("Mat Meas", "")),
            "material_rate": _clean_num(row.get("Material Rate")),
            "material_qty": _clean_num(row.get("Material QTY")),
            "material_cost": _clean_num(row.get("Material Cost")),
            "bill_to": _clean_str(row.get("Bill To", "")),
            "work_type": _clean_str(row.get("Type", "")),
            "is_labor_only": "true" if is_labor_only else "false",
            "is_bid_item": "true" if is_bid else "false",
            "is_active": "true",
            "catalog_version": today,
        }
        # Strip empties so HubSpot uses defaults / leaves blank rather than rejecting empty enums
        props = {k: v for k, v in props.items() if v != "" and v is not None}
        catalog_records.append({"properties": props})

    print(f"Prepared {len(catalog_records)} catalog records for upsert.")
    print("Upserting to rate_card_line_item (this takes ~1-2 minutes for 853 records)...")
    created, updated = batch_upsert_by_unique_property(
        object_type="rate_card_line_item",
        records=catalog_records,
        id_property="line_item_code",
    )
    print(f"[catalog] created={created}, updated={updated}")

    # ----- Load region rates --------------------------------------------
    print(f"\n--- Region rates ({REGION_XLSX}) ---")
    region_df = pd.read_excel(REGION_XLSX)
    print(f"Read {len(region_df)} region rows.")

    region_records = []
    missing_sibi = []
    for _, row in region_df.iterrows():
        region = _clean_str(row["Region"])
        props = {
            "region": region,
            "material_cost_adjustment": _clean_num(row.get("Material Cost Adjustment")),
            "material_tax_adjustment": _clean_num(row.get("Material Tax Adjustment")),
            "rates_version": today,
            "is_active": "true",
        }
        # Map each category column to its property
        for cat_label, prop_name in CATEGORY_TO_PROPERTY.items():
            if cat_label == "HVAC SIBI Units":
                # SIBI rates come from the user-supplied dict, not the Excel
                rate = HVAC_SIBI_RATES.get(region)
                if rate is None:
                    missing_sibi.append(region)
                    continue
                props[prop_name] = rate
            else:
                if cat_label in row.index:
                    val = _clean_num(row.get(cat_label))
                    if val is not None:
                        props[prop_name] = val
        props = {k: v for k, v in props.items() if v != "" and v is not None}
        region_records.append({"properties": props})

    if missing_sibi:
        print(f"WARNING: missing HVAC SIBI rates for: {missing_sibi}")

    print(f"Prepared {len(region_records)} region records for upsert.")
    print("Upserting to region_rate...")
    created, updated = batch_upsert_by_unique_property(
        object_type="region_rate",
        records=region_records,
        id_property="region",
    )
    print(f"[regions] created={created}, updated={updated}")

    print("\n[done] Step 5 complete.")
    print("\nNext: spot-check 5-10 records in HubSpot UI before moving to Phase 2.")
    print("  Settings > Objects > Rate Card Line Items > view records")
    print("  Settings > Objects > Region Rates > view records")


def _clean_str(v) -> str:
    """Convert a pandas/Excel value to a clean string for HubSpot."""
    if v is None:
        return ""
    if isinstance(v, float) and pd.isna(v):
        return ""
    s = str(v).strip()
    if s.lower() == "nan":
        return ""
    return s


def _clean_num(v):
    """Convert to float, or return None if NaN/empty. HubSpot accepts numerics as JSON numbers."""
    if v is None:
        return None
    if isinstance(v, str):
        v = v.strip()
        if v == "" or v.lower() == "nan":
            return None
        try:
            v = float(v)
        except ValueError:
            return None
    if pd.isna(v):
        return None
    return float(v)


if __name__ == "__main__":
    main()
