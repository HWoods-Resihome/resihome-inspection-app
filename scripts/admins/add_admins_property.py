"""
Create the App Admins storage property on the Agent object.

The dynamic app-admin allowlist is stored as a JSON array on ONE long-text
property of the same admin Agent record that holds the AI Knowledge base. Admins
are managed in-app at /admin/admins; the web app reads/writes this via
lib/hubspot.ts (readAppAdmins / writeAppAdmins).

The app also TRIES to create this property automatically on first write, but that
needs the private-app token to have schema-write scope. Run this script to
guarantee it exists (idempotent — safe to re-run).

Property, on the Agent object (2-13064238):
    app_admins_json   textarea   JSON array of { email, addedByEmail, addedAt }

Usage:
    python add_admins_property.py
"""

from __future__ import annotations
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'rate_card_phase1'))
from _hubspot_helpers import (  # type: ignore
    ensure_property, ensure_property_group,
)

AGENT = os.environ.get("HUBSPOT_AGENT_TYPE_ID", "2-13064238")
GROUP = "ai_knowledge"   # reuse the group created by the AI-knowledge setup
PROP = "app_admins_json"


def main():
    print("=" * 70)
    print("Create the App Admins property on the Agent object")
    print("=" * 70)

    ensure_property_group(AGENT, GROUP, "AI")
    ensure_property(
        AGENT, PROP, "App Admins (JSON)",
        type="string", field_type="textarea", group_name=GROUP,
        description="JSON array of ResiWalk app admins { email, addedByEmail, addedAt }. Managed by the app (/admin/admins) — do not hand-edit.",
    )
    print("\nDone. The /admin/admins screen can now add/remove admins.")


if __name__ == "__main__":
    main()
