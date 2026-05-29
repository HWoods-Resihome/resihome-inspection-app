"""
Phase 5, Step 2: Add a general Pass/Fail "Inspection Result" field on the
INSPECTION object.

This is a STANDARDIZED, TEMPLATE-AGNOSTIC field meant to be reused across any
inspection type that has an overall pass/fail outcome (Turn Re-Inspect QC today;
QC New Construction RRQC and other future templates later). It is an
enumeration (dropdown: Pass | Fail) so it is filterable in HubSpot views and
usable in reports.

Distinct from `qc_verdict` (legacy QC-specific text). The app writes the
overall result here whenever a pass/fail inspection is submitted.

New field:
  On the INSPECTION object:
    inspection_result   (enumeration: Pass | Fail)  -- overall result, any template

Lives in its own neutral property group ('inspection_results') rather than the
QC group, so it reads cleanly for non-QC templates too.

This script is idempotent (safe to re-run).

Usage:
    python phase5_step2_add_inspection_result.py
"""

from __future__ import annotations
import os
import sys

sys.path.insert(
    0,
    os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'rate_card_phase1'),
)
from _hubspot_helpers import ensure_property, ensure_property_group  # type: ignore

INSPECTION = 'inspection'


def main():
    print('=' * 72)
    print('Phase 5, Step 2: Add Inspection Result (Pass/Fail) field')
    print('=' * 72)

    # Neutral, template-agnostic group so the field reads well for ANY
    # inspection type, not just QC.
    try:
        ensure_property_group(INSPECTION, 'inspection_results', 'Inspection Results')
    except Exception as e:
        print(f'  (note) group ensure skipped: {str(e)[:80]}')

    ensure_property(
        INSPECTION, 'inspection_result', 'Inspection Result',
        type='enumeration', field_type='select', group_name='inspection_results',
        description=(
            "Overall Pass/Fail result for the inspection. Reusable across any "
            "template with a pass/fail outcome. Set automatically when such an "
            "inspection is submitted."
        ),
        options=[
            {'label': 'Pass', 'value': 'pass', 'displayOrder': 0},
            {'label': 'Fail', 'value': 'fail', 'displayOrder': 1},
        ],
    )

    print('\n[done] Inspection Result (Pass/Fail) field is ready.')


if __name__ == '__main__':
    main()
