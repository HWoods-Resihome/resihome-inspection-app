"""
Create the AI Knowledge Base storage property on the Agent object.

The live in-camera AI's field-trained guidance is stored as a JSON array on ONE
long-text property of the admin's Agent record (no new custom object). Inspectors
add entries by voice ("Teach AI" in the camera); admins curate them at
/ai-knowledge. The web app reads/writes this via lib/hubspot.ts.

Property (idempotent — re-run safely), on the Agent object (2-13064238):
    ai_knowledge_base_json   textarea   JSON array of { id, text, addedByEmail,
                                        addedByName, createdAt, updatedAt }

The script also resolves the admin's (AI_KNOWLEDGE_ADMIN_EMAIL, default
hwoods@resihome.com) Agent record id and prints it. The app resolves this at
runtime, but you can pin it via the AI_KNOWLEDGE_AGENT_RECORD_ID env var if the
owner→agent match is ever unreliable.

Usage:
    python add_knowledge_property.py
"""

from __future__ import annotations
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'rate_card_phase1'))
from _hubspot_helpers import (  # type: ignore
    ensure_property, ensure_property_group, hs_get, search_records, wait_a_moment,
)

# Agent custom object. Override via HUBSPOT_AGENT_TYPE_ID if your portal differs.
AGENT = os.environ.get("HUBSPOT_AGENT_TYPE_ID", "2-13064238")
GROUP = "ai_knowledge"
PROP = "ai_knowledge_base_json"
ADMIN_EMAIL = os.environ.get("AI_KNOWLEDGE_ADMIN_EMAIL", "hwoods@resihome.com")
OWNER_MATCH_PROP = os.environ.get("HUBSPOT_AGENT_OWNER_MATCH_PROP", "hubspot_owner_id")


def main():
    print("=" * 70)
    print("Create the AI Knowledge Base property on the Agent object")
    print("=" * 70)

    ensure_property_group(AGENT, GROUP, "AI")
    ensure_property(
        AGENT, PROP, "AI Knowledge Base (JSON)",
        type="string", field_type="textarea", group_name=GROUP,
        description="JSON array of field-trained AI knowledge entries that feed the live in-camera call-out model. Managed by the app (Teach AI / the admin /ai-knowledge screen) — do not hand-edit.",
    )

    # Resolve the admin's Agent record id so the app's owner→agent match is verified.
    print(f"\nResolving the Agent record for admin {ADMIN_EMAIL} ...")
    owner_id = None
    try:
        resp = hs_get(f"/crm/v3/owners/?email={ADMIN_EMAIL}&limit=1")
        results = resp.get("results", [])
        if results:
            owner_id = str(results[0].get("id"))
    except Exception as e:  # noqa: BLE001
        print(f"  [warn] owner lookup failed: {e}")

    if not owner_id:
        print(f"  [warn] No HubSpot owner found for {ADMIN_EMAIL}. The app can still")
        print("         work if you set AI_KNOWLEDGE_AGENT_RECORD_ID to a valid Agent id.")
    else:
        print(f"  owner id = {owner_id}")
        try:
            recs = search_records(AGENT, OWNER_MATCH_PROP, owner_id, ["name"])
            if recs:
                rec_id = recs[0].get("id")
                name = (recs[0].get("properties") or {}).get("name", "")
                print(f"  ✓ Agent record found: id={rec_id} ({name})")
                print(f"\n  The app resolves this automatically. To pin it, set:")
                print(f"      AI_KNOWLEDGE_AGENT_RECORD_ID={rec_id}")
            else:
                print(f"  [warn] No Agent record where {OWNER_MATCH_PROP}={owner_id}.")
                print("         Ensure the admin owns an Agent record, or set")
                print("         AI_KNOWLEDGE_AGENT_RECORD_ID to the Agent id to use.")
        except Exception as e:  # noqa: BLE001
            print(f"  [warn] agent search failed: {e}")

    print("\n[done] AI Knowledge Base property is ready on the Agent object.")


if __name__ == '__main__':
    main()
