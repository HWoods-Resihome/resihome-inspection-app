"""
Phase 5, Step 1: Add fields for the (PM) Turn Re-Inspect QC inspection type.

This new inspection validates that a vendor completed the work dispatched on a
Scope Rate Card inspection. It:
  - references a source Scope Rate Card inspection
  - snapshots that inspection's line items (with a Pass/Fail per line)
  - captures new "After" photos per section
  - records an overall Pass/Fail verdict + pass/fail counts

New fields:
  On the INSPECTION object:
    source_rate_card_id   (text)  -- record id of the validated Rate Card inspection
    source_rate_card_name (text)  -- human label of that inspection (for display)
    qc_verdict            (text)  -- 'pass' | 'fail' (overall)
    qc_pass_count         (number)
    qc_fail_count         (number)

  On the ANSWER object:
    pass_fail             (text)  -- 'pass' | 'fail' per rate_card_line answer
    photo_phase           (text)  -- 'after' for QC after-photos (vs blank/original)

This script is idempotent.

Usage:
    python phase5_step1_add_qc_fields.py
"""

from __future__ import annotations
import os
import sys

sys.path.insert(
    0,
    os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'rate_card_phase1'),
)
from _hubspot_helpers import ensure_property, ensure_property_group, ensure_picklist_value  # type: ignore

INSPECTION = 'inspection'
ANSWER = 'inspection_answer'


def main():
    print('=' * 72)
    print('Phase 5, Step 1: Add (PM) Turn Re-Inspect QC fields')
    print('=' * 72)

    # The template_type field on the inspection is an enumeration. The new QC
    # inspection type needs to be an allowed option or creation 400s.
    try:
        ensure_picklist_value(
            INSPECTION, 'template_type', 'pm_turn_reinspect_qc', '(PM) Turn Re-Inspect QC'
        )
    except Exception as e:
        print(f'  (warning) could not add template_type option: {str(e)[:120]}')

    # Property group for the QC fields on the inspection (best-effort).
    try:
        ensure_property_group(INSPECTION, 'qc_reinspect', 'QC Re-Inspect')
    except Exception as e:
        print(f'  (note) group ensure skipped: {str(e)[:80]}')

    # ---- Inspection object ----
    ensure_property(
        INSPECTION, 'source_rate_card_id', 'Source Rate Card Inspection ID',
        type='string', field_type='text', group_name='qc_reinspect',
        description='Record ID of the Scope Rate Card inspection this QC validates.',
    )
    ensure_property(
        INSPECTION, 'source_rate_card_name', 'Source Rate Card Inspection Name',
        type='string', field_type='text', group_name='qc_reinspect',
        description='Display name of the validated Scope Rate Card inspection.',
    )
    ensure_property(
        INSPECTION, 'qc_verdict', 'QC Verdict',
        type='string', field_type='text', group_name='qc_reinspect',
        description="Overall QC result: 'pass' or 'fail'.",
    )
    ensure_property(
        INSPECTION, 'qc_pass_count', 'QC Pass Count',
        type='number', field_type='number', group_name='qc_reinspect',
        description='Number of line items marked Pass.',
    )
    ensure_property(
        INSPECTION, 'qc_fail_count', 'QC Fail Count',
        type='number', field_type='number', group_name='qc_reinspect',
        description='Number of line items marked Fail.',
    )

    # ---- Answer object ----
    # ensure_property defaults group_name to 'rate_card', which does NOT exist
    # on the answer object — so we must create a group here and pass it
    # explicitly. We add a dedicated 'qc_reinspect' group for these.
    try:
        ensure_property_group(ANSWER, 'qc_reinspect', 'QC Re-Inspect')
    except Exception as e:
        print(f'  (note) answer group ensure skipped: {str(e)[:80]}')

    ensure_property(
        ANSWER, 'pass_fail', 'Pass / Fail',
        type='string', field_type='text', group_name='qc_reinspect',
        description="QC line result: 'pass' or 'fail'. Set on rate_card_line answers in a QC inspection.",
    )
    ensure_property(
        ANSWER, 'photo_phase', 'Photo Phase',
        type='string', field_type='text', group_name='qc_reinspect',
        description="'after' for QC After-Photos; blank for original/section photos.",
    )

    print('\n[done] QC Turn Re-Inspect fields are ready.')


if __name__ == '__main__':
    main()
