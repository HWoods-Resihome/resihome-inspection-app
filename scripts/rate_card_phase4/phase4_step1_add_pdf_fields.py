"""
Phase 4, Step 1: Add PDF storage fields to the inspection object.

The Finalize & Generate PDFs flow produces 4 documents:
    - Master report (everything in one doc)
    - Tenant Chargeback (only lines with tenant_bill_back_percent > 0)
    - Per-Vendor reports (one per vendor with assigned lines)
    - ZIP bundle (all of the above)

We need somewhere to store the resulting HubSpot Files URLs so the user can
re-download the PDFs later from HubSpot (and so we can ship them via email
in a future phase).

Storage approach: one property per logical document, plus a JSON blob for the
variable-count per-vendor URLs.

    - pdf_master_url           (text)      Single URL
    - pdf_chargeback_url       (text)      Single URL, blank if no chargeback lines
    - pdf_vendor_urls_json     (textarea)  JSON: {"Vendor 1": "url", "Internal Resolution": "url", ...}
    - pdf_zip_url              (text)      Single URL to the bundled .zip
    - pdf_generated_at         (datetime)  When finalize was run

This script is idempotent. Re-run to confirm properties exist.

Usage:
    python phase4_step1_add_pdf_fields.py
"""

from __future__ import annotations
import sys
import os

# Reuse Phase 1 helpers
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'rate_card_phase1'))
from _hubspot_helpers import (   # type: ignore  (sibling script import)
    ensure_property,
    ensure_property_group,
)

INSPECTION = "inspection"


def main():
    print("=" * 70)
    print("Phase 4, Step 1: Add PDF storage fields to inspection")
    print("=" * 70)

    # Group all PDF-related fields together in HubSpot's property browser
    ensure_property_group(INSPECTION, "pdf_outputs", "PDF Outputs")

    ensure_property(
        INSPECTION,
        "pdf_master_url",
        "PDF — Master Report URL",
        type="string",
        field_type="text",
        group_name="pdf_outputs",
        description=(
            "URL of the consolidated Master PDF generated when the inspection "
            "was finalized. Includes all line items grouped by section plus a "
            "photo appendix."
        ),
    )

    ensure_property(
        INSPECTION,
        "pdf_chargeback_url",
        "PDF — Tenant Chargeback URL",
        type="string",
        field_type="text",
        group_name="pdf_outputs",
        description=(
            "URL of the Tenant Chargeback PDF. Contains only line items with "
            "tenant_bill_back_percent > 0. Blank if no chargeback lines existed "
            "at finalize time."
        ),
    )

    ensure_property(
        INSPECTION,
        "pdf_vendor_urls_json",
        "PDF — Per-Vendor URLs (JSON)",
        type="string",
        field_type="textarea",
        group_name="pdf_outputs",
        description=(
            'JSON object mapping vendor name -> HubSpot Files URL for that '
            "vendor's PDF. Example: "
            '{"Vendor 1": "https://...", "Internal Resolution": "https://..."}'
            ". Only includes vendors that had >= 1 line at finalize time."
        ),
    )

    ensure_property(
        INSPECTION,
        "pdf_zip_url",
        "PDF — ZIP Bundle URL",
        type="string",
        field_type="text",
        group_name="pdf_outputs",
        description=(
            "URL of the .zip file containing all generated PDFs plus a "
            "manifest.txt listing what's inside."
        ),
    )

    ensure_property(
        INSPECTION,
        "pdf_generated_at",
        "PDF — Generated At",
        type="datetime",
        field_type="date",
        group_name="pdf_outputs",
        description=(
            "Timestamp when finalize was last run. Populated alongside the "
            "PDF URLs above. If blank, the inspection has not been finalized."
        ),
    )

    print("\n[done] PDF storage fields are ready on inspection.")
    print("\nNext step: deploy the Phase 4 code to Vercel and run a test finalize.")


if __name__ == '__main__':
    main()
