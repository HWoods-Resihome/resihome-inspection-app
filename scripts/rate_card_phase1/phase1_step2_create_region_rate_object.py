"""
Phase 1, Step 2: Create the region_rate custom object schema.

This object holds 18 records (one per region), each with:
  - Material cost adjustment (decimal multiplier)
  - Material tax adjustment (decimal multiplier)
  - 26 category-specific hourly labor rates

Categories: matches the catalog category list (including HVAC SIBI Units).

Run order:
    python phase1_step2_create_region_rate_object.py

Idempotent: safe to re-run.
"""

from _hubspot_helpers import (
    create_custom_object_schema,
    ensure_property,
    ensure_property_group,
    find_object_schema_by_name,
    update_schema_display_and_search,
)


OBJECT_NAME = "region_rate"


# All categories that have an hourly rate column in the region matrix.
# We add HVAC SIBI Units (user-supplied rates) but exclude "Unit Turns" for now
# per the planning decisions.
CATEGORY_RATE_FIELDS = [
    ("rate_appliance", "Appliance"),
    ("rate_cabinet", "Cabinet"),
    ("rate_carpentry", "Carpentry"),
    ("rate_cleaning", "Cleaning"),
    ("rate_concrete", "Concrete"),
    ("rate_doors", "Doors"),
    ("rate_drywall", "Drywall"),
    ("rate_electrical", "Electrical"),
    ("rate_fence", "Fence"),
    ("rate_flooring", "Flooring"),
    ("rate_garage_doors", "Garage Doors"),
    ("rate_gutters", "Gutters"),
    ("rate_hvac", "HVAC"),
    ("rate_hvac_sibi_units", "HVAC SIBI Units"),
    ("rate_inspections", "Inspections"),
    ("rate_landscape", "Landscape"),
    ("rate_painting", "Painting"),
    ("rate_pest_control", "Pest Control"),
    ("rate_plumbing", "Plumbing"),
    ("rate_remediation", "Remediation"),
    ("rate_roofing", "Roofing"),
    ("rate_septic", "Septic"),
    ("rate_siding", "Siding"),
    ("rate_trash_debris_removal", "Trash/Debris Removal"),
    ("rate_unit_turns", "Unit Turns (Paint/Clean/Minor Repairs)"),
    ("rate_utility_activation", "Utility Activation"),
    ("rate_windows_glass", "Windows/Glass"),
]


def main():
    print("=" * 70)
    print(f"Phase 1, Step 2: Create '{OBJECT_NAME}' custom object")
    print("=" * 70)

    definition = {
        "name": OBJECT_NAME,
        "labels": {
            "singular": "Region Rate",
            "plural": "Region Rates",
        },
        "primaryDisplayProperty": "region",
        "secondaryDisplayProperties": [],
        "searchableProperties": ["region"],
        "requiredProperties": ["region"],
        "properties": [
            {
                "name": "region",
                "label": "Region",
                "type": "string",
                "fieldType": "text",
                "hasUniqueValue": True,
                "description": "Region key matching the 'region' property on the home/property object (e.g., 'GA: Atlanta').",
            },
        ],
    }
    create_custom_object_schema(definition)

    schema = find_object_schema_by_name(OBJECT_NAME)
    print(f"\nObject: {OBJECT_NAME} (objectTypeId={schema.get('objectTypeId')})")

    # Property groups
    print("\nProperty groups:")
    ensure_property_group(OBJECT_NAME, "material_adjustments", "Material Adjustments")
    ensure_property_group(OBJECT_NAME, "labor_rates", "Labor Rates by Category")
    ensure_property_group(OBJECT_NAME, "meta", "Meta")

    # Material adjustments
    print("\nMaterial adjustment properties:")
    ensure_property(OBJECT_NAME, "material_cost_adjustment", "Material Cost Adjustment",
                    type="number", field_type="number", group_name="material_adjustments",
                    description="Multiplier applied to base material cost (e.g., 1.0152 means +1.52%).")

    ensure_property(OBJECT_NAME, "material_tax_adjustment", "Material Tax Adjustment",
                    type="number", field_type="number", group_name="material_adjustments",
                    description="Tax adjustment applied additively: adjusted_cost = base * cost_adj * (1 + tax_adj). E.g., 0.07 means 7% tax.")

    # Category hourly rates
    print("\nLabor rate properties (one per category):")
    for prop_name, cat_label in CATEGORY_RATE_FIELDS:
        ensure_property(OBJECT_NAME, prop_name, f"Labor Rate \u2014 {cat_label}",
                        type="number", field_type="number", group_name="labor_rates",
                        description=f"Hourly labor rate for {cat_label} in this region.")

    # Meta
    print("\nMeta properties:")
    ensure_property(OBJECT_NAME, "rates_version", "Rates Version (Last Loaded)",
                    type="string", field_type="text", group_name="meta",
                    description="Version tag of the region matrix file this record was last loaded from.")

    ensure_property(OBJECT_NAME, "is_active", "Is Active",
                    type="enumeration", field_type="booleancheckbox", group_name="meta",
                    description="False if this region is no longer in use.",
                    options=[
                        {"label": "Yes", "value": "true", "displayOrder": 0},
                        {"label": "No", "value": "false", "displayOrder": 1},
                    ])

    # Now that material adjustment properties exist, set them as secondary display fields.
    print("\nExtending schema's display property list:")
    update_schema_display_and_search(
        OBJECT_NAME,
        secondary_display_properties=["material_cost_adjustment", "material_tax_adjustment"],
    )

    print("\n[done] Step 2 complete.")
    print(f"Verify in HubSpot: Settings > Objects > {OBJECT_NAME}")


if __name__ == "__main__":
    main()
