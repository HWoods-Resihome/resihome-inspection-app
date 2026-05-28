"""
Phase 3c follow-up: add fields to inspection_answer so we can persist (and
later reload) the inspector's RAW override inputs:

  - custom_labor_rate                 (number; overrides labor_hourly_rate)
  - custom_adjusted_material_cost     (number; overrides material_cost adjustment)
  - custom_vendor_cost                (number; overrides the final vendor_cost)

Without these, the FINAL totals get stored correctly, but when an inspection
is reopened the form can't pre-populate the override input fields — the
user would see "is_custom_priced=true" without knowing what number to keep.

This script is idempotent — re-running just confirms the properties exist.

Usage:
    python phase3c_step1_add_override_fields.py
"""

from __future__ import annotations
import sys
import os

# Reuse Phase 1 helpers
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'rate_card_phase1'))
from _hubspot_helpers import (   # type: ignore  (sibling script import)
    ensure_property,
)

INSPECTION_ANSWER = "inspection_answer"


def main():
    print("=" * 70)
    print("Phase 3c, Step 1: Add inspector-override fields to inspection_answer")
    print("=" * 70)

    ensure_property(
        INSPECTION_ANSWER,
        "custom_labor_rate",
        "Custom Labor Rate ($)",
        type="number",
        field_type="number",
        group_name="rate_card_line",
        description=(
            "Inspector-entered hourly labor rate override. When set, replaces "
            "the region's default labor rate for this line. Used primarily on "
            "Bid Items but available on any line."
        ),
    )

    ensure_property(
        INSPECTION_ANSWER,
        "custom_adjusted_material_cost",
        "Custom Adjusted Material Cost ($)",
        type="number",
        field_type="number",
        group_name="rate_card_line",
        description=(
            "Inspector-entered adjusted material cost override (already includes "
            "region cost adjustment + tax). When set, replaces the catalog "
            "material cost * region adjustments for this line."
        ),
    )

    ensure_property(
        INSPECTION_ANSWER,
        "custom_vendor_cost",
        "Custom Vendor Cost ($)",
        type="number",
        field_type="number",
        group_name="rate_card_line",
        description=(
            "Inspector-entered FINAL vendor cost override. When set, replaces "
            "the computed labor_total + material_total. Client cost = override "
            "x 1.20; tenant cost = client x tenant%."
        ),
    )

    print("\n[done] Override fields are ready on inspection_answer.")
    print("Reload existing Rate Card inspections to verify pre-population works.")


if __name__ == '__main__':
    main()
