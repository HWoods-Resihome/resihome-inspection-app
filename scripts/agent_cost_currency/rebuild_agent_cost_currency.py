"""
Rebuild the Agent object's `inspection_vendor_cost` and `inspection_client_cost`
as CURRENCY fields (number + showCurrencySymbol) instead of plain number, then
backfill the existing values.

HubSpot can't flip a property's display in place reliably, so this script:
    1. SNAPSHOTS every Agent record's current vendor/client cost values and
       writes a timestamped JSON backup next to this script (safety net).
    2. DELETES the two properties.
    3. RECREATES them as number/currency (showCurrencySymbol=True), preserving
       the original label / group / description where possible.
    4. BACKFILLS the snapshotted values back onto each Agent record.

Idempotent-ish: if a property is ALREADY currency, it is left untouched (no
delete, no needless backfill for that field). Re-running after a clean run is a
no-op.

Agent object type id defaults to 2-13064238 (override HUBSPOT_AGENT_TYPE_ID).

Usage:
    python rebuild_agent_cost_currency.py            # do it
    python rebuild_agent_cost_currency.py --dry-run  # show what would happen
"""

from __future__ import annotations
import sys
import os
import json
import datetime

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'rate_card_phase1'))
from _hubspot_helpers import (  # type: ignore
    get_property, hs_post, hs_delete, fetch_all_records, wait_a_moment,
)

AGENT = os.environ.get("HUBSPOT_AGENT_TYPE_ID", "2-13064238")
FIELDS = ["inspection_vendor_cost", "inspection_client_cost"]
DEFAULT_LABELS = {
    "inspection_vendor_cost": "Inspection Vendor Cost",
    "inspection_client_cost": "Inspection Client Cost",
}
DRY_RUN = "--dry-run" in sys.argv


def is_currency(prop: dict) -> bool:
    return prop.get("type") == "number" and bool(prop.get("showCurrencySymbol"))


def snapshot() -> list[dict]:
    """All Agent records with their current vendor/client cost values."""
    print("Snapshotting current values from all Agent records...")
    recs = fetch_all_records(AGENT, FIELDS)
    out = []
    for r in recs:
        props = r.get("properties") or {}
        out.append({
            "id": r.get("id"),
            "inspection_vendor_cost": props.get("inspection_vendor_cost"),
            "inspection_client_cost": props.get("inspection_client_cost"),
        })
    print(f"  captured {len(out)} Agent records.")
    return out


def write_backup(snap: list[dict]) -> str:
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), f"snapshot_{ts}.json")
    with open(path, "w") as f:
        json.dump(snap, f, indent=2)
    print(f"  backup written -> {path}")
    return path


def recreate_as_currency(name: str) -> bool:
    """Delete + recreate `name` as number/currency, preserving label/group/desc.
    Returns True if it was rebuilt, False if it was already currency (skipped)."""
    existing = get_property(AGENT, name)
    if existing and is_currency(existing):
        print(f"  [skip] {AGENT}.{name} already number/currency.")
        return False

    label = (existing or {}).get("label") or DEFAULT_LABELS.get(name, name)
    group = (existing or {}).get("groupName") or "agentinformation"
    desc = (existing or {}).get("description") or ""

    if existing:
        print(f"  [recreate] {AGENT}.{name}: {existing.get('type')}"
              f"{'/currency' if existing.get('showCurrencySymbol') else ''} -> number/currency")
        if not DRY_RUN:
            hs_delete(f"/crm/v3/properties/{AGENT}/{name}")
            wait_a_moment(0.4)
    else:
        print(f"  [create] {AGENT}.{name} (number/currency) — did not exist")

    body = {
        "name": name, "label": label, "type": "number", "fieldType": "number",
        "groupName": group, "description": desc, "showCurrencySymbol": True,
    }
    if not DRY_RUN:
        hs_post(f"/crm/v3/properties/{AGENT}", body)
        wait_a_moment(0.3)
    return True


def backfill(snap: list[dict], fields: list[str]) -> None:
    """Write the snapshotted values back, in batches of 100. Skips blanks."""
    inputs = []
    for row in snap:
        props = {}
        for fld in fields:
            v = row.get(fld)
            if v is not None and str(v).strip() != "":
                props[fld] = str(v)
        if props:
            inputs.append({"id": row["id"], "properties": props})

    if not inputs:
        print("  nothing to backfill (no non-empty values).")
        return
    print(f"  backfilling {len(inputs)} records for {fields} ...")
    if DRY_RUN:
        print("  [dry-run] skipping writes.")
        return
    for i in range(0, len(inputs), 100):
        chunk = inputs[i:i + 100]
        hs_post(f"/crm/v3/objects/{AGENT}/batch/update", {"inputs": chunk})
        wait_a_moment(0.4)
        print(f"  ... updated {i + len(chunk)} of {len(inputs)}")


def main():
    print("=" * 70)
    print(f"Rebuild Agent cost fields as CURRENCY  (object {AGENT})")
    if DRY_RUN:
        print("*** DRY RUN — no changes will be made ***")
    print("=" * 70)

    # 1. Snapshot + backup BEFORE touching anything.
    snap = snapshot()
    if snap and not DRY_RUN:
        write_backup(snap)

    # 2/3. Rebuild only the fields that aren't already currency.
    rebuilt = []
    for name in FIELDS:
        if recreate_as_currency(name):
            rebuilt.append(name)

    # 4. Backfill the fields we actually rebuilt (deleting wiped their values).
    if rebuilt:
        print(f"\nBackfilling rebuilt fields: {rebuilt}")
        backfill(snap, rebuilt)
    else:
        print("\nNo fields needed rebuilding — both already currency. Done.")

    print("\n[done] Agent vendor/client cost are number/currency and backfilled.")


if __name__ == "__main__":
    main()
