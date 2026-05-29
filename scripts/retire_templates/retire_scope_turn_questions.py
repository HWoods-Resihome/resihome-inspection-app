"""
Retire the (PM) Scope Inspection and (PM) Turn Inspection templates from the
Inspection Question object.

Background:
  With the Rate Card rollout, the original `pm_scope_inspection` and
  `pm_turn_inspection` templates are being removed. This script walks every
  Inspection Question record and acts based on its `applies_to_templates`
  (a pipe-delimited list of template keys):

    - If a question applies ONLY to pm_scope_inspection and/or
      pm_turn_inspection (and no other template) -> ARCHIVE the record.
    - If it applies to one of those PLUS at least one other template
      (e.g. leasing_agent_1099_property_inspection) -> KEEP the record,
      but strip pm_scope_inspection and pm_turn_inspection out of
      applies_to_templates.
    - If it applies to neither -> leave it completely alone.

SAFETY:
  * DRY RUN by default. Prints exactly what it WOULD do and changes nothing.
    Add the --apply flag to actually perform the changes.
  * Archives (soft-delete) rather than hard-deletes. Archived records are
    recoverable from HubSpot for 90 days.
  * Idempotent: re-running after --apply is a no-op (the targeted templates
    are already gone from every record).

Usage:
    python retire_scope_turn_questions.py            # dry run (safe)
    python retire_scope_turn_questions.py --apply     # perform changes
"""

from __future__ import annotations
import os
import sys

sys.path.insert(
    0,
    os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'rate_card_phase1'),
)
from _hubspot_helpers import (  # type: ignore
    hs_post, hs_patch, hs_delete, get_object_type_id, wait_a_moment,
)

QUESTION_OBJECT = 'inspection_question'

# The two templates being retired.
RETIRE = {'pm_scope_inspection', 'pm_turn_inspection'}


def resolve_question_type_id() -> str:
    """Resolve the Inspection Question objectTypeId.

    Prefer the same env var the app uses (HUBSPOT_INSPECTION_QUESTION_TYPE_ID),
    then fall back to schema lookup by a few likely names. This avoids a hard
    failure if the schema's `name` differs from what we guessed.
    """
    env = os.environ.get('HUBSPOT_INSPECTION_QUESTION_TYPE_ID')
    if env and env.strip() and not env.strip().startswith('<'):
        return env.strip()
    for candidate in ('inspection_question', 'Inspection Question', 'inspection_questions'):
        try:
            return get_object_type_id(candidate)
        except Exception:
            continue
    raise RuntimeError(
        'Could not resolve the Inspection Question object. Set '
        'HUBSPOT_INSPECTION_QUESTION_TYPE_ID or check the schema name.'
    )


def parse_templates(raw: str) -> list[str]:
    """Split the pipe-delimited applies_to_templates into a clean list."""
    return [t.strip() for t in (raw or '').split('|') if t.strip()]


def fetch_all_questions(type_id: str) -> list[dict]:
    """Page through every (non-archived) Inspection Question record."""
    out: list[dict] = []
    after = None
    while True:
        body = {
            'filterGroups': [],
            'properties': ['question_id_external', 'question_text', 'section', 'applies_to_templates'],
            'limit': 100,
        }
        if after:
            body['after'] = after
        resp = hs_post(f'/crm/v3/objects/{type_id}/search?archived=false', body)
        out.extend(resp.get('results', []))
        after = (resp.get('paging') or {}).get('next', {}).get('after')
        if not after:
            break
    return out


def main():
    apply = '--apply' in sys.argv
    mode = 'APPLY (changes will be made)' if apply else 'DRY RUN (no changes)'

    print('=' * 72)
    print('Retire Scope + Turn templates from Inspection Questions')
    print(f'Mode: {mode}')
    print('=' * 72)

    type_id = resolve_question_type_id()
    print(f'Inspection Question type id: {type_id}\n')

    questions = fetch_all_questions(type_id)
    print(f'Scanned {len(questions)} question records.\n')

    to_archive: list[dict] = []   # applies only to retired templates
    to_update: list[dict] = []    # keep, but strip retired templates
    untouched = 0

    for q in questions:
        p = q.get('properties', {})
        applies = parse_templates(p.get('applies_to_templates', ''))
        applies_set = set(applies)

        retired_hits = applies_set & RETIRE
        if not retired_hits:
            untouched += 1
            continue

        remaining = [t for t in applies if t not in RETIRE]
        record = {
            'id': q.get('id'),
            'qid': p.get('question_id_external', ''),
            'text': (p.get('question_text', '') or '')[:60],
            'section': p.get('section', ''),
            'before': applies,
            'after': remaining,
        }
        if len(remaining) == 0:
            to_archive.append(record)
        else:
            to_update.append(record)

    # ---- Report ----
    print(f'{"-" * 72}')
    print(f'ARCHIVE (applies only to Scope/Turn): {len(to_archive)} records')
    print(f'{"-" * 72}')
    for r in to_archive:
        print(f'  [{r["qid"]}] {r["section"]} | {r["text"]}')
        print(f'      applies_to_templates: {r["before"]}  ->  (archive)')

    print(f'\n{"-" * 72}')
    print(f'UPDATE (keep, strip Scope/Turn only): {len(to_update)} records')
    print(f'{"-" * 72}')
    for r in to_update:
        print(f'  [{r["qid"]}] {r["section"]} | {r["text"]}')
        print(f'      {r["before"]}  ->  {r["after"]}')

    print(f'\n{"-" * 72}')
    print(f'UNTOUCHED (no Scope/Turn): {untouched} records')
    print(f'{"-" * 72}')

    if not apply:
        print('\nDRY RUN complete. No changes were made.')
        print('Re-run with --apply to perform the archive + update operations above.')
        return

    # ---- Apply ----
    print('\nApplying changes...\n')

    updated = 0
    for r in to_update:
        new_value = '|'.join(r['after'])
        hs_patch(
            f'/crm/v3/objects/{type_id}/{r["id"]}',
            {'properties': {'applies_to_templates': new_value}},
        )
        updated += 1
        print(f'  updated [{r["qid"]}] -> {new_value}')
        wait_a_moment(0.15)

    archived = 0
    for r in to_archive:
        # DELETE on the object endpoint performs an archive (soft delete) in
        # HubSpot — recoverable for 90 days, not a permanent purge.
        hs_delete(f'/crm/v3/objects/{type_id}/{r["id"]}')
        archived += 1
        print(f'  archived [{r["qid"]}] ({r["section"]})')
        wait_a_moment(0.15)

    print(f'\n{"=" * 72}')
    print(f'Done. Updated {updated}, archived {archived}, untouched {untouched}.')
    print('Archived records are recoverable from HubSpot for 90 days.')
    print('=' * 72)


if __name__ == '__main__':
    main()
