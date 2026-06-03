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
from _hubspot_helpers import (  # type: ignore
    ensure_property, ensure_property_group, get_property, hs_post, hs_delete,
    get_object_type_id, wait_a_moment,
)

INSPECTION = "inspection"
GROUP = "rate_card"


def ensure_datetime_property(name: str, label: str, description: str) -> None:
    """Ensure `name` is a datetime property. HubSpot can't change a property's
    type in place, so if it exists as a different type (e.g. the old text field)
    we delete + recreate it as datetime. We write ISO timestamps; HubSpot stores
    them as datetime and returns epoch-ms via the API."""
    type_id = get_object_type_id(INSPECTION)
    existing = get_property(INSPECTION, name)
    if existing:
        if existing.get("type") == "datetime":
            print(f"  [skip] {INSPECTION}.{name} already datetime.")
            return
        print(f"  [recreate] {INSPECTION}.{name}: {existing.get('type')} -> datetime (delete + create)")
        hs_delete(f"/crm/v3/properties/{type_id}/{name}")
        wait_a_moment(0.3)
    else:
        print(f"  [create] {INSPECTION}.{name} (datetime)")
    hs_post(f"/crm/v3/properties/{type_id}", {
        "name": name, "label": label, "type": "datetime", "fieldType": "date",
        "groupName": GROUP, "description": description,
    })
    wait_a_moment(0.2)


def main():
    print("=" * 70)
    print("Add submit/approve stamps + resolution timing map to inspection")
    print("=" * 70)

    # The target property group may not exist in every portal (prod) — create it.
    ensure_property_group(INSPECTION, GROUP, "Rate Card")

    ensure_property(
        INSPECTION, "submitted_by_email", "Submitted By (email)",
        type="string", field_type="text", group_name=GROUP,
        description="Email of the user who submitted the Rate Card for approval.",
    )
    ensure_datetime_property(
        "submitted_at", "Submitted At",
        "Timestamp when the Rate Card was submitted for approval.",
    )
    ensure_property(
        INSPECTION, "approved_by_name", "Approved By (name)",
        type="string", field_type="text", group_name=GROUP,
        description="Full name of the approver who finalized the Rate Card.",
    )
    ensure_datetime_property(
        "approved_at", "Approved At",
        "Timestamp when the Rate Card was approved (finalized).",
    )
    ensure_property(
        INSPECTION, "resolution_timing_json", "Internal Resolution Timing (JSON)",
        type="string", field_type="textarea", group_name=GROUP,
        description="JSON map { lineExternalId: 'now' | 'later' } of per-line Internal Resolution completion timing. 'later' lines are exempt from the after-photo requirement at finalize.",
    )
    ensure_property(
        INSPECTION, "hbmm_ticket_id", "HBMM Maintenance Ticket ID",
        type="string", field_type="text", group_name=GROUP,
        description="The HoneyBadger/Maintenance ticket id created at finalize. Used for visibility + background document-upload retries.",
    )

    print("\n[done] submit/approve stamps + resolution_timing_json are ready on inspection.")


if __name__ == '__main__':
    main()
