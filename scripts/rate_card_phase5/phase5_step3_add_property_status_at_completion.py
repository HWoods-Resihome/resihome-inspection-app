"""
Phase 5, Step 3: Add a "Property Status at Completion" field on the INSPECTION
object.

This freezes the PROPERTY's lifecycle status (Turnkey / Vacant / Unmarketed / …)
as it was when the inspection finalized or submitted-to-completed, so a completed
report preserves the historical status even if the property's status changes
later. The app stamps it automatically at completion (question-form submit, scope
finalize, QC finalize) and leaves it blank while the inspection is still
scheduled / in progress / pending approval (status stays dynamic then).

A single-line text field (mirrors the free-text values on the Property object's
status), so it's filterable/reportable in HubSpot.

New field:
  On the INSPECTION object:
    property_status_at_completion  (string / text)

This script is idempotent (safe to re-run).

Usage:
    python phase5_step3_add_property_status_at_completion.py
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
    print('Phase 5, Step 3: Add Property Status at Completion field')
    print('=' * 72)

    # Reuse the neutral, template-agnostic group created in step 2.
    try:
        ensure_property_group(INSPECTION, 'inspection_results', 'Inspection Results')
    except Exception as e:
        print(f'  (note) group ensure skipped: {str(e)[:80]}')

    ensure_property(
        INSPECTION, 'property_status_at_completion', 'Property Status at Completion',
        type='string', field_type='text', group_name='inspection_results',
        description=(
            "The property's lifecycle status (Turnkey / Vacant / Unmarketed / …) "
            "frozen at the moment this inspection was completed. Set automatically "
            "at finalize/submit; blank while scheduled / in progress / pending "
            "approval. Preserves the historical status for reporting."
        ),
    )

    print('\n[done] Property Status at Completion field is ready.')


if __name__ == '__main__':
    main()
