"""
Fix: ensure the `quantity` property exists on the INSPECTION_ANSWER object.

Background
----------
The app writes a `quantity` property onto inspection_answer records (it was the
old `score` field, renamed to `quantity`). The UI only exposes it on Scope, but
the SUBMIT path also stamps `quantity = 1` onto *triggered* answers for non-Scope
templates (e.g. the 1099 Leasing Agent inspection). That means a 1099 submit can
send `quantity` to HubSpot even though the field is hidden in the 1099 UI.

If the `quantity` property was never actually created on the answer object (the
rename touched the app code + the field LABEL, but the underlying property may
still be named `score`, or may not exist at all), then HubSpot's
`batch/create` rejects the whole batch with:

    400 ... Cannot set PropertyValueCoordinates{...} for property "quantity"
    because the property does not exist ...

Autosave can mask this: an answer that never had `quantity` set is created
without the property, so it succeeds. The failure only appears on Submit, where
triggered answers get `quantity = 1`.

What this script does
---------------------
1. DIAGNOSE (always): reports whether the answer object has `quantity`, and
   whether a legacy `score` property still exists.
2. FIX (only with --apply): if `quantity` is missing, create it as a plain
   number property in the appropriate group. Idempotent — safe to re-run.

This script does NOT migrate old `score` values into `quantity`; it only makes
sure new writes succeed. (Historical `score` data, if any, is left untouched.)

Usage
-----
    # Diagnose only (no changes):
    python fix_answer_quantity_property.py

    # Diagnose AND create `quantity` if missing:
    python fix_answer_quantity_property.py --apply
"""

from __future__ import annotations
import os
import sys

sys.path.insert(
    0,
    os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'rate_card_phase1'),
)
from _hubspot_helpers import ensure_property, get_property  # type: ignore

INSPECTION_ANSWER = 'inspection_answer'


def main() -> int:
    apply = '--apply' in sys.argv

    print('=' * 72)
    print('Fix: inspection_answer.quantity property')
    print('=' * 72)
    print(f'Mode: {"APPLY (will create if missing)" if apply else "DIAGNOSE ONLY (no changes)"}')
    print()

    # ---- Diagnose ----------------------------------------------------------
    quantity = get_property(INSPECTION_ANSWER, 'quantity')
    score = get_property(INSPECTION_ANSWER, 'score')

    print('Current state on the inspection_answer object:')
    if quantity is not None:
        print(f'  [ok]      `quantity` EXISTS '
              f'(type={quantity.get("type")}, fieldType={quantity.get("fieldType")}, '
              f'label="{quantity.get("label")}")')
    else:
        print('  [MISSING] `quantity` does NOT exist  <-- this is the cause of the 400 on submit')

    if score is not None:
        print(f'  [info]    legacy `score` still exists '
              f'(type={score.get("type")}, label="{score.get("label")}")')
    else:
        print('  [info]    no legacy `score` property (fine)')
    print()

    # ---- Fix ---------------------------------------------------------------
    if quantity is not None:
        print('Nothing to do — `quantity` already exists. New submits should succeed.')
        if score is not None:
            print('Note: `score` lingers but is harmless. The app no longer writes to it.')
        return 0

    if not apply:
        print('DIAGNOSIS: `quantity` is missing. Re-run with --apply to create it:')
        print('    python fix_answer_quantity_property.py --apply')
        return 1

    print('Creating `quantity` on inspection_answer ...')
    ensure_property(
        INSPECTION_ANSWER,
        'quantity',
        'Quantity',
        type='number',
        field_type='number',
        # 'rate_card_line' group already exists on the answer object (phase 1).
        # Quantity is a Scope-side concept, so this is a sensible home; HubSpot
        # only uses the group for UI grouping, not for writes.
        group_name='rate_card_line',
        description=(
            'Quantity for a triggered/scope answer. Hidden on non-Scope templates '
            '(auto-set to 1 for triggered answers at submit). Formerly named "score".'
        ),
    )
    print('  [done] `quantity` is ready. Submitting a 1099 inspection should now work.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
