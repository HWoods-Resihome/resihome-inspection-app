"""
Add the Rate Card submit/approve stamp properties + the Internal Resolution
timing map to the inspection object.

Properties (idempotent — re-run safely):
    submitted_by_email     - who submitted for approval (may already exist)
    submitted_at           - when submitted (ISO; may already exist)
    approved_by_name       - approver's full name (set at finalize)
    approved_at            - when approved (ISO; set at finalize)
    resolution_timing_json - JSON { lineExternalId: 'now' | 'later' } so the
                             approver (any device) + the finalize after-photo
                             gate honor "Complete Later"

Usage:
    python add_stamp_properties.py
"""

from __future__ import annotations
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'rate_card_phase1'))
from _hubspot_helpers import ensure_property  # type: ignore

INSPECTION = "inspection"
GROUP = "rate_card"


def main():
    print("=" * 70)
    print("Add submit/approve stamps + resolution timing map to inspection")
    print("=" * 70)

    ensure_property(
        INSPECTION, "submitted_by_email", "Submitted By (email)",
        type="string", field_type="text", group_name=GROUP,
        description="Email of the user who submitted the Rate Card for approval.",
    )
    ensure_property(
        INSPECTION, "submitted_at", "Submitted At",
        type="string", field_type="text", group_name=GROUP,
        description="ISO timestamp when the Rate Card was submitted for approval.",
    )
    ensure_property(
        INSPECTION, "approved_by_name", "Approved By (name)",
        type="string", field_type="text", group_name=GROUP,
        description="Full name of the approver who finalized the Rate Card.",
    )
    ensure_property(
        INSPECTION, "approved_at", "Approved At",
        type="string", field_type="text", group_name=GROUP,
        description="ISO timestamp when the Rate Card was approved (finalized).",
    )
    ensure_property(
        INSPECTION, "resolution_timing_json", "Internal Resolution Timing (JSON)",
        type="string", field_type="textarea", group_name=GROUP,
        description="JSON map { lineExternalId: 'now' | 'later' } of per-line Internal Resolution completion timing. 'later' lines are exempt from the after-photo requirement at finalize.",
    )

    print("\n[done] submit/approve stamps + resolution_timing_json are ready on inspection.")


if __name__ == '__main__':
    main()
