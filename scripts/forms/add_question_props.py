"""
Add form-builder support properties to the inspection_question object.

The form builder (/admin/forms) lets admins turn questions ON/OFF without
deleting them. That needs an `is_enabled` boolean on the question object. The web
app also TRIES to tolerate its absence (missing ⇒ enabled), but to actually
toggle questions off you must create it (idempotent — safe to re-run).

Property, on the inspection_question object (HUBSPOT_INSPECTION_QUESTION_TYPE_ID):
    is_enabled   bool   default true — disabled questions are hidden from inspectors

Usage:
    python add_question_props.py
"""

from __future__ import annotations
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'rate_card_phase1'))
from _hubspot_helpers import (  # type: ignore
    ensure_property, ensure_property_group,
)

QUESTION = os.environ.get("HUBSPOT_INSPECTION_QUESTION_TYPE_ID", "2-63142763")
GROUP = "inspection_question_info"


def main():
    print("=" * 70)
    print("Add form-builder properties to the inspection_question object")
    print("=" * 70)

    ensure_property_group(QUESTION, GROUP, "Question Info")
    ensure_property(
        QUESTION, "is_enabled", "Enabled",
        type="bool", field_type="booleancheckbox", group_name=GROUP,
        description="When false, the question is hidden from inspectors (soft off via the form builder). Missing/true = enabled.",
    )
    print("\nDone. The form builder can now toggle questions on/off.")


if __name__ == "__main__":
    main()
