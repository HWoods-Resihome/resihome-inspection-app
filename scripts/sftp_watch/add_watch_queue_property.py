"""
Create the SFTP-monitor properties (run once; idempotent).

Two stores:
  1. Agent object (2-13064238) — the watch QUEUE the cron polls:
       sftp_watch_queue_json   textarea   JSON array of in-flight SFTP watches
     (lives on the SAME admin Agent record as the AI knowledge base singleton).

  2. Inspection object — the per-inspection OUTCOME, so you can see in HubSpot
     whether each Tenant Chargeback import processed or errored:
       sftp_import_result      enumeration  pending | processed | errored | no_error
       sftp_import_detail      text         error file name(s) / note
       sftp_import_checked_at  datetime     when the monitor last updated it

Usage:
    python add_watch_queue_property.py
"""

from __future__ import annotations
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'rate_card_phase1'))
from _hubspot_helpers import (  # type: ignore
    ensure_property, ensure_property_group,
)

AGENT = os.environ.get("HUBSPOT_AGENT_TYPE_ID", "2-13064238")
AGENT_GROUP = "ai_knowledge"  # reuse the AI knowledge base store's group
QUEUE_PROP = "sftp_watch_queue_json"

INSPECTION = "inspection"
INSP_GROUP = "sftp"


def main():
    print("=" * 70)
    print("Create the SFTP-monitor properties (queue + per-inspection result)")
    print("=" * 70)

    # 1. Watch queue on the Agent object.
    ensure_property_group(AGENT, AGENT_GROUP, "AI")
    ensure_property(
        AGENT, QUEUE_PROP, "SFTP Watch Queue (JSON)",
        type="string", field_type="textarea", group_name=AGENT_GROUP,
        description="JSON array of in-flight Tenant Chargeback SFTP uploads the background monitor is watching for a processed/errored result. Managed by the app — do not hand-edit.",
    )

    # 2. Per-inspection outcome.
    ensure_property_group(INSPECTION, INSP_GROUP, "SFTP Import")
    ensure_property(
        INSPECTION, "sftp_import_result", "SFTP Import Result",
        type="enumeration", field_type="select", group_name=INSP_GROUP,
        options=[
            {"label": "Pending (watching)", "value": "pending"},
            {"label": "Processed", "value": "processed"},
            {"label": "Errored", "value": "errored"},
            {"label": "No error (assumed OK)", "value": "no_error"},
        ],
        description="Outcome of the Tenant Chargeback SFTP import, tracked by the background monitor.",
    )
    ensure_property(
        INSPECTION, "sftp_import_detail", "SFTP Import Detail",
        type="string", field_type="text", group_name=INSP_GROUP,
        description="Error file name(s) or a note from the SFTP import monitor.",
    )
    ensure_property(
        INSPECTION, "sftp_import_checked_at", "SFTP Import Checked At",
        type="datetime", field_type="date", group_name=INSP_GROUP,
        description="When the background monitor last updated the SFTP import result (epoch-ms written by the app).",
    )

    print("\n[done] SFTP-monitor properties are ready (Agent queue + Inspection result).")
    print("Remember to set the CRON_SECRET env var so /api/cron/sftp-watch is authorized,")
    print("and (optionally) SFTP_ERRORS_DIR / SFTP_PROCESSED_DIR if the folder names differ")
    print("from <SFTP_REMOTE_DIR>/Errors and <SFTP_REMOTE_DIR>/Processed.")


if __name__ == "__main__":
    main()
