"""
Short Links, Step 1: add the clean share-link properties to the inspection object.

The finalize flow now also stores short, signed share links (resolve to the
real HubSpot file via /d/<id>/<type>/<sig>) so the HubSpot record itself shows
clean URLs instead of the giant raw file URLs. These are written ALONGSIDE the
existing pdf_*_url properties (which stay as the resolver's real-file source).

Properties created (idempotent):
    link_master        - short link to the Master Rate Card PDF
    link_chargeback    - short link to the Tenant Chargeback PDF
    link_xlsx          - short link to the Tenant Chargeback Import (xlsx)
    link_vendors_json  - JSON map { vendorName: shortLink } for per-vendor PDFs

Usage:
    python step1_add_link_properties.py
"""

from __future__ import annotations
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'rate_card_phase1'))
from _hubspot_helpers import ensure_property  # type: ignore

INSPECTION = "inspection"
GROUP = "pdf_outputs"


def main():
    print("=" * 70)
    print("Short Links, Step 1: add link_* properties to inspection")
    print("=" * 70)

    ensure_property(
        INSPECTION, "link_master", "Link — Master Rate Card (short)",
        type="string", field_type="text", group_name=GROUP,
        description="Short signed share link to the Master Rate Card PDF (resolves via /d/...). Set by finalize / backfill.",
    )
    ensure_property(
        INSPECTION, "link_chargeback", "Link — Tenant Chargeback PDF (short)",
        type="string", field_type="text", group_name=GROUP,
        description="Short signed share link to the Tenant Chargeback PDF. Blank when there are no chargeback lines.",
    )
    ensure_property(
        INSPECTION, "link_xlsx", "Link — Tenant Chargeback Import xlsx (short)",
        type="string", field_type="text", group_name=GROUP,
        description="Short signed share link to the Tenant Chargeback Import xlsx. Blank when there are no chargeback lines.",
    )
    ensure_property(
        INSPECTION, "link_vendors_json", "Link — Per-Vendor PDFs (short, JSON)",
        type="string", field_type="textarea", group_name=GROUP,
        description="JSON map of vendor name -> short signed share link for each per-vendor scope PDF.",
    )
    ensure_property(
        INSPECTION, "link_report", "Link — Report PDF (short)",
        type="string", field_type="text", group_name=GROUP,
        description="Short signed share link to the single report PDF used by non-Rate-Card templates (question templates + QC reinspect); resolves the pdf_attachment_url file.",
    )

    print("\n[done] link_master / link_chargeback / link_xlsx / link_vendors_json / link_report are ready on inspection.")


if __name__ == '__main__':
    main()
