"""
Create the SFTP watch-queue storage property on the Agent object.

The background SFTP monitor (/api/cron/sftp-watch) keeps a small JSON array of
in-flight Tenant Chargeback uploads it's watching for a processed/errored result.
It lives on the SAME admin Agent record as the AI knowledge base (a singleton
store), in this long-text property. The app reads/writes it via lib/hubspot.ts.

Property (idempotent — re-run safely), on the Agent object (2-13064238):
    sftp_watch_queue_json   textarea   JSON array of pending SFTP watches

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
GROUP = "ai_knowledge"  # reuse the same group as the AI knowledge base store
PROP = "sftp_watch_queue_json"


def main():
    print("=" * 70)
    print("Create the SFTP watch-queue property on the Agent object")
    print("=" * 70)

    ensure_property_group(AGENT, GROUP, "AI")
    ensure_property(
        AGENT, PROP, "SFTP Watch Queue (JSON)",
        type="string", field_type="textarea", group_name=GROUP,
        description="JSON array of in-flight Tenant Chargeback SFTP uploads the background monitor is watching for a processed/errored result. Managed by the app — do not hand-edit.",
    )

    print("\n[done] SFTP watch-queue property is ready on the Agent object.")
    print("Remember to set the CRON_SECRET env var so /api/cron/sftp-watch is authorized,")
    print("and (optionally) SFTP_ERRORS_DIR / SFTP_PROCESSED_DIR if the folder names differ")
    print("from <SFTP_REMOTE_DIR>/Errors and <SFTP_REMOTE_DIR>/Processed.")


if __name__ == "__main__":
    main()
