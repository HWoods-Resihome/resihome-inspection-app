"""
Add the custom-templates storage property to the Agent object.

Admin-created inspection templates (form builder → "+ New template") are stored
as a JSON array on the same admin Agent record as the AI knowledge base. The app
auto-creates this property on first write IF the token has schema-write scope;
run this to guarantee it (idempotent — safe to re-run).

Property, on the Agent object (2-13064238):
    app_templates_json   textarea   JSON array of { id, label, createdByEmail, createdAt }

Usage:
    python add_template_props.py
"""

from __future__ import annotations
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'rate_card_phase1'))
from _hubspot_helpers import (  # type: ignore
    ensure_property, ensure_property_group,
)

AGENT = os.environ.get("HUBSPOT_AGENT_TYPE_ID", "2-13064238")
GROUP = "ai_knowledge"
PROP = "app_templates_json"


def main():
    print("=" * 70)
    print("Create the App Templates property on the Agent object")
    print("=" * 70)
    ensure_property_group(AGENT, GROUP, "AI")
    ensure_property(
        AGENT, PROP, "App Templates (JSON)",
        type="string", field_type="textarea", group_name=GROUP,
        description="JSON array of admin-created inspection templates { id, label, createdByEmail, createdAt }. Managed by the form builder — do not hand-edit.",
    )
    print("\nDone. The form builder can now create custom templates.")


if __name__ == "__main__":
    main()
