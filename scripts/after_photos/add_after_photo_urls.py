"""
Add the `after_photo_urls` property to the inspection_answer object.

This backs the "After Photos" requirement on Internal Resolution rate-card
lines: when a line is assigned to Internal Resolution (work ResiHome resolves
in-house), the inspector must attach after-photos (proof the work was done)
before the scope can be finalized. Those photos are stored — comma-separated
HubSpot file URLs — in this field, separate from the line's regular photo_urls.

The app is written to be DORMANT until this property exists:
  - the answer fetch only requests after_photo_urls once the property exists
    (HubSpot batch-read 400s on an unknown property),
  - the line save only writes it when a line actually has after-photos,
  - the finalize requirement + the client finalize-block are both gated on the
    property existing.
So this migration is what ACTIVATES the feature. Run it before (or with) the
deploy. Idempotent — re-running just confirms the property exists.

Usage:
    python add_after_photo_urls.py
"""

from __future__ import annotations
import sys
import os

# Reuse Phase 1 helpers (sibling script import).
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'rate_card_phase1'))
from _hubspot_helpers import (   # type: ignore
    ensure_property,
)

INSPECTION_ANSWER = "inspection_answer"


def main():
    print("=" * 70)
    print("Add `after_photo_urls` to inspection_answer (Internal Resolution proof)")
    print("=" * 70)

    ensure_property(
        INSPECTION_ANSWER,
        "after_photo_urls",
        "After Photo URLs",
        type="string",
        field_type="text",
        group_name="rate_card_line",
        description=(
            "Comma-separated HubSpot file URLs of the AFTER photos for an "
            "Internal Resolution rate-card line (proof the in-house work was "
            "completed). Separate from photo_urls. Required on every Internal "
            "Resolution line before the scope can be finalized."
        ),
    )

    print("\n[done] after_photo_urls is ready on inspection_answer.")
    print("The After Photos feature is now active for Internal Resolution lines.")


if __name__ == '__main__':
    main()
