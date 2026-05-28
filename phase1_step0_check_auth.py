"""
Phase 4.5: Add `section_list_json` to inspection so each inspection can store
its own customized section list (renames, deletions, additions, reordering).

The property stores a JSON array of section descriptors:
    [
      { "id": "yard_exterior", "label": "Yard / Exterior", "location": "" },
      { "id": "bedroom_1", "label": "Master Suite", "location": "Bedroom 1" },
      ...
    ]

Where:
  - `id` is a stable key used by the UI for React keys + section operations
  - `label` is the current (possibly renamed) display label
  - `location` is the IMMUTABLE original location string — this is what gets
    written onto saved inspection_answer records. Never rename this even when
    `label` changes, or saved answers become orphaned.

When the property is empty/null, the form falls back to deriving sections
from bedrooms/bathrooms (legacy behavior, identical to pre-4.5).

Run:
    python phase4_5_step1_add_section_list_json.py
"""

from __future__ import annotations
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'rate_card_phase1'))
from _hubspot_helpers import ensure_property, ensure_property_group  # type: ignore

INSPECTION = "inspection"


def main():
    print("=" * 70)
    print("Phase 4.5: section_list_json on inspection")
    print("=" * 70)

    ensure_property_group(INSPECTION, "section_customization", "Section Customization")

    ensure_property(
        INSPECTION,
        "section_list_json",
        "Section List (JSON)",
        type="string",
        field_type="textarea",
        group_name="section_customization",
        description=(
            "JSON array of section descriptors customized by the inspector. "
            "Each item: {id, label, location}. Empty/null = use auto-derived "
            "defaults from bedrooms/bathrooms. The `location` field is "
            "immutable per descriptor and used to join saved answers."
        ),
    )

    print("\n[done] section_list_json is ready on inspection.")


if __name__ == '__main__':
    main()
