"""
Phase 1, Step 4: Create the Inspection <-> Rate Card Line Item association schema.

This lets HubSpot reports show "which inspections reference catalog item X" and
"which catalog items appear on inspection Y".

Note: at the line level, the FK is stored as a string (line_item_code) on
inspection_answer. The association at the Inspection level is for reporting.

Run order:
    python phase1_step4_create_associations.py

Idempotent: safe to re-run.
"""

from _hubspot_helpers import (
    ensure_association,
    get_object_type_id,
)


def main():
    print("=" * 70)
    print("Phase 1, Step 4: Create Inspection <-> Rate Card Line Item association")
    print("=" * 70)

    inspection_id = get_object_type_id("inspection")
    line_item_id = get_object_type_id("rate_card_line_item")

    print(f"\nObject type IDs:")
    print(f"  inspection           = {inspection_id}")
    print(f"  rate_card_line_item  = {line_item_id}")

    # Forward (inspection references catalog items)
    print("\nForward association (inspection -> rate_card_line_item):")
    ensure_association(
        from_type=inspection_id,
        to_type=line_item_id,
        label="Uses Catalog Item",
        name="uses_catalog_item",
    )

    # Reverse (catalog item is used by inspections) — HubSpot auto-creates a reverse,
    # but we explicitly create a labeled reverse so reports can show it cleanly.
    print("\nReverse association (rate_card_line_item -> inspection):")
    ensure_association(
        from_type=line_item_id,
        to_type=inspection_id,
        label="Used By Inspection",
        name="used_by_inspection",
    )

    print("\n[done] Step 4 complete.")


if __name__ == "__main__":
    main()
