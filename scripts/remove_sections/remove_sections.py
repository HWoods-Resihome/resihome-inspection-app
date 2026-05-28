"""
Archive HubSpot Question records in the 6 sections being removed from the app:

  - Foundation
  - Roof / Gutters
  - Office
  - Attic
  - Utilities
  - Crawlspace

Archiving (not deleting) preserves the records — they're hidden from active use but
historical inspections that reference them still work. HubSpot's app-side fetch
already excludes archived records, so this immediately removes them from the form.

This script:
  1. Reads ALL active Question records
  2. Identifies any whose `section` matches one of the 6 (case-insensitive)
  3. Prints a dry-run summary
  4. On --confirm, archives the matching records via the batch archive endpoint

Usage:
    python remove_sections.py            # dry-run only, prints what would be archived
    python remove_sections.py --confirm  # actually archives

Idempotent: re-running just shows nothing left to archive.

To restore: HubSpot UI → Custom Objects → Inspection Questions → Filter by archived
records → un-archive individually.
"""

from __future__ import annotations
import sys
import os

# Reuse the helpers from the rate_card_phase1 scripts
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'rate_card_phase1'))
from _hubspot_helpers import hs_get, hs_post, get_object_type_id, wait_a_moment


# Sections to remove. Match is case-insensitive on the trimmed section value.
SECTIONS_TO_REMOVE = [
    'Foundation',
    'Roof / Gutters',
    'Office',
    'Attic',
    'Utilities',
    'Crawlspace',
]

# Some variants we should also catch in case section names are inconsistent in data
SECTION_ALIASES = {
    'foundation': 'Foundation',
    'roof/gutters': 'Roof / Gutters',
    'roof / gutters': 'Roof / Gutters',
    'roof gutters': 'Roof / Gutters',
    'office': 'Office',
    'attic': 'Attic',
    'utilities': 'Utilities',
    'crawlspace': 'Crawlspace',
    'crawl space': 'Crawlspace',
}


def _norm(s: str) -> str:
    return (s or '').strip().lower()


def _resolve_question_type_id() -> str:
    """Find the Inspection Question objectTypeId by scanning all schemas.
    Falls back if the env var isn't set.
    """
    schemas = hs_get('/crm/v3/schemas').get('results', [])
    # Try common name variations
    candidates = ['inspection_question', 'inspectionquestion', 'question', 'inspection_questions']
    for s in schemas:
        n = (s.get('name') or '').lower()
        if n in candidates or 'question' in n:
            return s.get('objectTypeId') or s.get('id')
    raise RuntimeError(
        'Could not find an Inspection Question schema by name. '
        'Set HUBSPOT_INSPECTION_QUESTION_TYPE_ID in your environment.'
    )


def main():
    confirm = '--confirm' in sys.argv

    print('=' * 70)
    print('Archive Questions in removed sections')
    print('=' * 70)
    print(f'Mode: {"CONFIRM (will archive)" if confirm else "DRY RUN (no changes)"}')
    print(f'Sections to remove: {", ".join(SECTIONS_TO_REMOVE)}')
    print()

    type_id = (
        os.environ.get('HUBSPOT_INSPECTION_QUESTION_TYPE_ID')
        or _resolve_question_type_id()
    )
    print(f'inspection_question objectTypeId={type_id}')

    # Page through ALL active questions
    print('\nReading active questions...')
    all_questions = []
    after = None
    while True:
        body = {
            'filterGroups': [],
            'properties': ['question_id_external', 'question_text', 'section', 'section_order', 'applies_to_templates'],
            'limit': 100,
        }
        if after:
            body['after'] = after
        resp = hs_post(f'/crm/v3/objects/{type_id}/search?archived=false', body)
        for r in resp.get('results', []):
            all_questions.append(r)
        after = resp.get('paging', {}).get('next', {}).get('after')
        if not after:
            break
        wait_a_moment(0.2)

    print(f'  Found {len(all_questions)} active questions total.')

    # Filter to those in the 6 sections
    to_archive = []
    section_counts = {}
    for q in all_questions:
        p = q.get('properties') or {}
        section = p.get('section', '')
        norm = _norm(section)
        canonical = SECTION_ALIASES.get(norm)
        if canonical:
            to_archive.append({
                'id': q['id'],
                'section': section,
                'canonical': canonical,
                'question_text': p.get('question_text', ''),
                'applies_to_templates': p.get('applies_to_templates', ''),
            })
            section_counts[canonical] = section_counts.get(canonical, 0) + 1

    print(f'\nMatched {len(to_archive)} questions across the 6 sections:')
    for sec in SECTIONS_TO_REMOVE:
        c = section_counts.get(sec, 0)
        marker = '  ' if c > 0 else '⚠ '
        print(f'  {marker}{sec:.<28} {c} questions')
    not_found = [sec for sec in SECTIONS_TO_REMOVE if section_counts.get(sec, 0) == 0]
    if not_found:
        print(f'\n  WARNING: no questions found for sections: {", ".join(not_found)}')
        print('  This may be a section-name mismatch. Run with no args first to inspect actual names.')

    # Print a preview of the first 10 matched
    if to_archive:
        print('\nPreview (first 10 matches):')
        for q in to_archive[:10]:
            qtext = q['question_text'][:60].replace('\n', ' ')
            print(f'  - [{q["canonical"]:.<20}] {qtext}{"..." if len(q["question_text"]) > 60 else ""}')

    if not confirm:
        print('\n[DRY RUN] No changes made.')
        print(f'  Run with --confirm to archive {len(to_archive)} question(s).')
        return

    if not to_archive:
        print('\nNothing to archive. Exiting.')
        return

    # Actually archive — use batch/archive endpoint
    print(f'\nArchiving {len(to_archive)} questions...')
    for i in range(0, len(to_archive), 100):
        chunk = to_archive[i:i + 100]
        body = {'inputs': [{'id': q['id']} for q in chunk]}
        hs_post(f'/crm/v3/objects/{type_id}/batch/archive', body)
        print(f'  archived {i + len(chunk)} / {len(to_archive)}')
        wait_a_moment(0.4)

    print('\n[done] Sections removed.')
    print('Refresh the inspection app — those sections will no longer appear in any template.')


if __name__ == '__main__':
    main()
