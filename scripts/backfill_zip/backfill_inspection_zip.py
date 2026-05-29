"""
Backfill zip codes into existing inspections' property_address_snapshot.

Older inspections were created with an address snapshot derived from the
property's freeform `name`, which often omitted the zip (e.g.
"5503 Thomas Dr, Douglasville, Georgia"). New inspections (v0.19.50+) compose
the snapshot from structured fields and always include the zip.

This script walks every inspection, looks up its linked property's zip, and
appends ", <zip>" to the snapshot when:
  - the snapshot is non-empty, AND
  - the property has a zip, AND
  - that zip isn't already present in the snapshot.

SAFETY:
  * DRY RUN by default. Add --apply to write changes.
  * Only appends a zip; never rewrites the rest of the address.
  * Idempotent: re-running skips snapshots that already contain the zip.

Usage:
    python backfill_inspection_zip.py            # dry run
    python backfill_inspection_zip.py --apply     # write changes
"""

from __future__ import annotations
import os
import sys

sys.path.insert(
    0,
    os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'rate_card_phase1'),
)
from _hubspot_helpers import (  # type: ignore
    hs_get, hs_post, hs_patch, get_object_type_id, wait_a_moment,
)


def resolve_type_id(env_var: str, *names: str) -> str:
    env = os.environ.get(env_var)
    if env and env.strip() and not env.strip().startswith('<'):
        return env.strip()
    for n in names:
        try:
            return get_object_type_id(n)
        except Exception:
            continue
    raise RuntimeError(f'Could not resolve object type for {env_var} / {names}')


def fetch_all_inspections(type_id: str) -> list[dict]:
    out: list[dict] = []
    after = None
    while True:
        body = {
            'filterGroups': [],
            'properties': ['property_address_snapshot', 'property_id_ref', 'inspection_name'],
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


# Cache property zip lookups so we don't re-fetch the same property twice.
_zip_cache: dict[str, str] = {}


def get_property_zip(property_type_id: str, property_id: str) -> str:
    if not property_id:
        return ''
    if property_id in _zip_cache:
        return _zip_cache[property_id]
    zip_val = ''
    try:
        resp = hs_get(
            f'/crm/v3/objects/{property_type_id}/{property_id}'
            f'?properties=zip&properties=zip_code'
        )
        p = resp.get('properties', {})
        zip_val = (p.get('zip_code') or p.get('zip') or '').strip()
    except Exception as e:
        print(f'  (warning) could not fetch property {property_id}: {str(e)[:80]}')
    _zip_cache[property_id] = zip_val
    return zip_val


def main():
    apply = '--apply' in sys.argv
    mode = 'APPLY (changes will be made)' if apply else 'DRY RUN (no changes)'
    print('=' * 72)
    print('Backfill zip into inspection address snapshots')
    print(f'Mode: {mode}')
    print('=' * 72)

    inspection_type = resolve_type_id('HUBSPOT_INSPECTION_TYPE_ID', 'inspection', 'Inspection')
    property_type = resolve_type_id('HUBSPOT_PROPERTY_TYPE_ID', 'property', 'Property')
    print(f'Inspection type id: {inspection_type}')
    print(f'Property type id:   {property_type}\n')

    inspections = fetch_all_inspections(inspection_type)
    print(f'Scanned {len(inspections)} inspections.\n')

    to_update: list[dict] = []
    skipped_no_snapshot = 0
    skipped_no_zip = 0
    skipped_has_zip = 0

    for ins in inspections:
        p = ins.get('properties', {})
        snapshot = (p.get('property_address_snapshot') or '').strip()
        prop_id = (p.get('property_id_ref') or '').strip()

        if not snapshot:
            skipped_no_snapshot += 1
            continue

        zip_val = get_property_zip(property_type, prop_id)
        if not zip_val:
            skipped_no_zip += 1
            continue

        # Already present anywhere in the snapshot?
        if zip_val in snapshot:
            skipped_has_zip += 1
            continue

        new_snapshot = f'{snapshot}, {zip_val}'
        to_update.append({
            'id': ins.get('id'),
            'name': p.get('inspection_name', ''),
            'before': snapshot,
            'after': new_snapshot,
        })

    print(f'{"-" * 72}')
    print(f'TO UPDATE: {len(to_update)} inspections')
    print(f'{"-" * 72}')
    for r in to_update:
        print(f'  {r["before"]}')
        print(f'    -> {r["after"]}')

    print(f'\nSkipped: {skipped_has_zip} already have zip, '
          f'{skipped_no_zip} property has no zip, '
          f'{skipped_no_snapshot} no snapshot.')

    if not apply:
        print('\nDRY RUN complete. No changes made. Re-run with --apply to write.')
        return

    print('\nApplying...\n')
    n = 0
    for r in to_update:
        hs_patch(
            f'/crm/v3/objects/{inspection_type}/{r["id"]}',
            {'properties': {'property_address_snapshot': r['after']}},
        )
        n += 1
        print(f'  updated: {r["after"]}')
        wait_a_moment(0.12)

    print(f'\n{"=" * 72}')
    print(f'Done. Updated {n} inspections.')
    print('=' * 72)


if __name__ == '__main__':
    main()
