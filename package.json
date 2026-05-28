"""
Phase 1, Step 1: Create the rate_card_line_item custom object schema.

This object holds the 853-row catalog of available rate card items. One record per
catalog row (uniquely keyed by line_item_code).

Run order:
    python phase1_step1_create_rate_card_catalog_object.py

Idempotent: re-running is safe. The object is created on first run; subsequent runs
skip the creation and just verify/patch property definitions.
"""

from _hubspot_helpers import (
    create_custom_object_schema,
    ensure_property,
    ensure_property_group,
    find_object_schema_by_name,
    update_schema_display_and_search,
)


OBJECT_NAME = "rate_card_line_item"


def main():
    print("=" * 70)
    print(f"Phase 1, Step 1: Create '{OBJECT_NAME}' custom object")
    print("=" * 70)

    # 1) Create the object schema if it doesn't exist.
    # The 'primaryDisplayProperty' is the field shown as the record's "name" in HubSpot UI.
    # Required properties must be defined here at creation time; other properties get added below.
    #
    # IMPORTANT: secondaryDisplayProperties and searchableProperties at creation time can ONLY
    # reference properties defined inline in `properties` below. Adding refs to properties that
    # only get created in subsequent ensure_property calls causes HubSpot to return 500.
    # We can extend these lists in a follow-up step after the object exists.
    definition = {
        "name": OBJECT_NAME,
        "labels": {
            "singular": "Rate Card Line Item",
            "plural": "Rate Card Line Items",
        },
        "primaryDisplayProperty": "labor_short_description",
        "secondaryDisplayProperties": ["line_item_code"],
        "searchableProperties": [
            "line_item_code",
            "labor_short_description",
        ],
        "requiredProperties": ["line_item_code", "labor_short_description"],
        "properties": [
            {
                "name": "line_item_code",
                "label": "Line Item Code",
                "type": "string",
                "fieldType": "text",
                "hasUniqueValue": True,
                "description": "Unique natural key (e.g., 'APLSL1009'). Maps to catalog labor code.",
            },
            {
                "name": "labor_short_description",
                "label": "Labor Short Description",
                "type": "string",
                "fieldType": "text",
                "description": "Short description shown in inspector dropdown (e.g., 'Replace Electric Cooktop White 30').",
            },
        ],
        # Association to Inspection is created explicitly in phase1_step4.
        # The schema endpoint's `associatedObjects` shortcut only accepts built-in
        # object names like 'CONTACT', 'COMPANY', 'DEAL' — not custom objects.
    }
    create_custom_object_schema(definition)

    # Verify the object now exists.
    schema = find_object_schema_by_name(OBJECT_NAME)
    if not schema:
        raise RuntimeError(f"Object '{OBJECT_NAME}' not found after creation.")
    print(f"\nObject: {OBJECT_NAME} (objectTypeId={schema.get('objectTypeId')})")

    # 2) Create property group.
    print("\nProperty group:")
    ensure_property_group(OBJECT_NAME, "catalog", "Catalog Data")

    # 3) Add the rest of the catalog properties.
    print("\nProperties:")

    # The two required ones are already defined; the rest follow.
    ensure_property(OBJECT_NAME, "category", "Category", "enumeration", "select",
                    group_name="catalog",
                    description="Top-level category (e.g., Plumbing, Appliance).",
                    options=_category_options())

    ensure_property(OBJECT_NAME, "subcategory", "Subcategory", "string", "text",
                    group_name="catalog",
                    description="Mid-level grouping under category.")

    ensure_property(OBJECT_NAME, "labor_code", "Labor Code", "string", "text",
                    group_name="catalog",
                    description="Internal labor code from the catalog.")

    ensure_property(OBJECT_NAME, "labor_full_description", "Labor Full Description", "string", "textarea",
                    group_name="catalog",
                    description="Full labor description / scope of work.")

    ensure_property(OBJECT_NAME, "labor_meas", "Labor Unit of Measure", "enumeration", "select",
                    group_name="catalog",
                    description="Unit of measure for labor: EA, LF, SF, HR, etc.",
                    options=_meas_options())

    ensure_property(OBJECT_NAME, "labor_hours", "Labor Hours per Unit", "number", "number",
                    group_name="catalog",
                    description="Labor hours required per 1 unit of labor measure.")

    ensure_property(OBJECT_NAME, "labor_hourly_rate_list", "Labor Hourly Rate (List / Reference)", "number", "number",
                    group_name="catalog",
                    description="List/reference hourly rate from the catalog. Actual rate at calculation time comes from the region_rate matrix.")

    ensure_property(OBJECT_NAME, "material_code", "Material Code", "string", "text",
                    group_name="catalog",
                    description="Internal material code from the catalog.")

    ensure_property(OBJECT_NAME, "material_description", "Material Description", "string", "textarea",
                    group_name="catalog",
                    description="Full material description / SKU detail.")

    ensure_property(OBJECT_NAME, "material_meas", "Material Unit of Measure", "enumeration", "select",
                    group_name="catalog",
                    description="Unit of measure for material: EA, LF, SF, etc.",
                    options=_meas_options())

    ensure_property(OBJECT_NAME, "material_rate", "Material Rate (Consumption Ratio)", "number", "number",
                    group_name="catalog",
                    description="Material consumption per labor unit. E.g., 0.125 means 0.125 material units per 1 labor unit.")

    ensure_property(OBJECT_NAME, "material_qty", "Material Quantity Multiplier", "number", "number",
                    group_name="catalog",
                    description="Multiplier on quantity for material side. Usually 1.0.")

    ensure_property(OBJECT_NAME, "material_cost", "Material Cost (Base)", "number", "number",
                    group_name="catalog",
                    description="Base material cost per unit, before regional adjustments.")

    ensure_property(OBJECT_NAME, "bill_to", "Bill To", "enumeration", "select",
                    group_name="catalog",
                    description="Who is responsible for paying this line.",
                    options=[
                        {"label": "Owner", "value": "Owner", "displayOrder": 0},
                        {"label": "Tenant", "value": "Tenant", "displayOrder": 1},
                        {"label": "ResiHome", "value": "ResiHome", "displayOrder": 2},
                    ])

    ensure_property(OBJECT_NAME, "work_type", "Work Type", "enumeration", "select",
                    group_name="catalog",
                    description="Repair or Replace.",
                    options=[
                        {"label": "Repair", "value": "Repair", "displayOrder": 0},
                        {"label": "Replace", "value": "Replace", "displayOrder": 1},
                        {"label": "Other", "value": "Other", "displayOrder": 2},
                    ])

    ensure_property(OBJECT_NAME, "is_labor_only", "Is Labor Only", "enumeration", "booleancheckbox",
                    group_name="catalog",
                    description="If true, material cost is zero regardless of catalog values.",
                    options=[
                        {"label": "Yes", "value": "true", "displayOrder": 0},
                        {"label": "No", "value": "false", "displayOrder": 1},
                    ])

    ensure_property(OBJECT_NAME, "is_bid_item", "Is Bid Item", "enumeration", "booleancheckbox",
                    group_name="catalog",
                    description="If true, the inspector enters custom labor and/or material price at line creation.",
                    options=[
                        {"label": "Yes", "value": "true", "displayOrder": 0},
                        {"label": "No", "value": "false", "displayOrder": 1},
                    ])

    ensure_property(OBJECT_NAME, "is_active", "Is Active", "enumeration", "booleancheckbox",
                    group_name="catalog",
                    description="False if this catalog item is deprecated. Historical inspections may still reference it.",
                    options=[
                        {"label": "Yes", "value": "true", "displayOrder": 0},
                        {"label": "No", "value": "false", "displayOrder": 1},
                    ])

    ensure_property(OBJECT_NAME, "catalog_version", "Catalog Version (Last Loaded)", "string", "text",
                    group_name="catalog",
                    description="Version tag of the catalog file this record was last loaded from. Helps track data freshness.")

    # Now that all the searchable/display properties exist, widen the schema's lists.
    # We deferred this from object creation because HubSpot 500s if these lists reference
    # properties that don't exist yet at create time.
    # NOTE: HubSpot caps secondaryDisplayProperties at 2 entries. We keep the most
    # useful: line_item_code (the natural key) and category (the top-level grouping).
    # Subcategory remains searchable but is not shown as a column.
    print("\nExtending schema's display and searchable property lists:")
    update_schema_display_and_search(
        OBJECT_NAME,
        secondary_display_properties=["line_item_code", "category"],
        searchable_properties=[
            "line_item_code",
            "labor_short_description",
            "labor_code",
            "material_code",
            "category",
            "subcategory",
        ],
    )

    print("\n[done] Step 1 complete.")
    print(f"Verify in HubSpot: Settings > Objects > {OBJECT_NAME}")


def _category_options() -> list[dict]:
    """Catalog categories. Order roughly alphabetical."""
    cats = [
        "Appliance", "Cabinet", "Carpentry", "Cleaning", "Concrete", "Doors",
        "Drywall", "Electrical", "Fence", "Flooring", "Garage Doors", "Gutters",
        "HVAC", "HVAC SIBI Units", "Inspections", "Landscape", "Painting",
        "Pest Control", "Plumbing", "Remediation", "Roofing", "Septic", "Siding",
        "Trash/Debris Removal", "Unit Turns (Paint/Clean/Minor Repairs)",
        "Utility Activation", "Windows/Glass",
    ]
    return [{"label": c, "value": c, "displayOrder": i} for i, c in enumerate(cats)]


def _meas_options() -> list[dict]:
    """Units of measure used in the catalog. Sourced from the Excel."""
    units = ["EA", "LF", "SF", "HR", "DAY", "RM", "SQ", "CY", "BND", "LBS", "GAL", "BAG", "ROLL"]
    return [{"label": u, "value": u, "displayOrder": i} for i, u in enumerate(units)]


if __name__ == "__main__":
    main()
