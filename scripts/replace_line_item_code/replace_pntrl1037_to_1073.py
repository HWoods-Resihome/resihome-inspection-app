"""
One-time data migration: replace the old paint line-item code PNTRL1037 with
PNTRL1073 on every historical inspection_answer rate-card line.

What it does
------------
  • Finds all inspection_answer records where rate_card_line_item_code == PNTRL1037.
  • Swaps the code to PNTRL1073.
  • Realigns answer_value (the displayed description) to the NEW item's catalog
    description ONLY when it currently equals the OLD item's catalog description —
    it never clobbers an inspector's custom description override.
  • (On --apply) deactivates the old catalog item (is_active=false) so PNTRL1037
    can no longer be picked going forward.

Line totals are computed from the code at render time (finalize/PDF), so no
recompute is needed — the next PDF generation reflects PNTRL1073's pricing.

Idempotent: re-running finds nothing left to change.

Usage
-----
    python replace_pntrl1037_to_1073.py            # DRY RUN — prints what would change
    python replace_pntrl1037_to_1073.py --apply    # writes the changes

Env: HUBSPOT_TOKEN (or HUBSPOT_SANDBOX_TOKEN / .env.local), same as the phase1 scripts.
Point the token at whichever portal (sandbox vs prod) you intend to migrate.
"""
from __future__ import annotations
import os
import sys

# Reuse the shared phase1 HubSpot helpers.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "rate_card_phase1"))
from _hubspot_helpers import (  # noqa: E402
    get_object_type_id, get_property, hs_post, hs_patch,
    fetch_all_records, search_records, wait_a_moment,
)

OLD_CODE = "PNTRL1037"
NEW_CODE = "PNTRL1073"
INSPECTION_ANSWER = "inspection_answer"
CATALOG = "rate_card_line_item"
DESC_FIELDS = ["line_item_code", "labor_short_description", "labor_subtext", "labor_full_description"]


def catalog_record(code: str) -> dict | None:
    recs = search_records(CATALOG, "line_item_code", code, DESC_FIELDS + ["is_active"])
    return recs[0] if recs else None


def old_descriptions(rec: dict | None) -> set[str]:
    """Every catalog description string a stored answer_value could equal."""
    out: set[str] = set()
    if not rec:
        return out
    p = rec.get("properties", {})
    for k in ("labor_short_description", "labor_subtext", "labor_full_description"):
        v = (p.get(k) or "").strip()
        if v:
            out.add(v)
    return out


def preferred_description(rec: dict | None) -> str:
    if not rec:
        return ""
    p = rec.get("properties", {})
    return (p.get("labor_subtext") or "").strip() \
        or (p.get("labor_full_description") or "").strip() \
        or (p.get("labor_short_description") or "").strip()


def main():
    apply = "--apply" in sys.argv
    print("=" * 70)
    print(f"Replace {OLD_CODE} -> {NEW_CODE} on inspection_answer  ({'APPLY' if apply else 'DRY RUN'})")
    print("=" * 70)

    old_rec = catalog_record(OLD_CODE)
    new_rec = catalog_record(NEW_CODE)
    if not new_rec:
        print(f"WARNING: catalog has no {NEW_CODE}. Codes will still be swapped, but "
              f"answer_value won't be realigned and the picker may show a blank item.")
    old_descs = old_descriptions(old_rec)
    new_pref = preferred_description(new_rec)
    print(f"  old catalog descriptions to realign: {sorted(old_descs) or '(none / catalog item missing)'}")
    print(f"  new preferred description:           {new_pref!r}")

    type_id = get_object_type_id(INSPECTION_ANSWER)
    matches = fetch_all_records(
        INSPECTION_ANSWER,
        ["rate_card_line_item_code", "answer_value", "answer_summary"],
        extra_filter={"filters": [{"propertyName": "rate_card_line_item_code", "operator": "EQ", "value": OLD_CODE}]},
    )
    print(f"\nFound {len(matches)} answer record(s) with {OLD_CODE}.")

    inputs = []
    for r in matches:
        rid = r["id"]
        cur_val = (r.get("properties", {}).get("answer_value") or "").strip()
        props = {"rate_card_line_item_code": NEW_CODE}
        realigned = False
        if new_pref and cur_val in old_descs:
            props["answer_value"] = new_pref
            realigned = True
        inputs.append({"id": rid, "properties": props})
        print(f"  - {rid}: code -> {NEW_CODE}{' , answer_value realigned' if realigned else ''}")

    if not apply:
        print(f"\nDRY RUN — would update {len(inputs)} answer record(s) "
              f"and deactivate catalog item {OLD_CODE}. Re-run with --apply to write.")
        return

    # 1) Update the answers in batches of 100.
    for i in range(0, len(inputs), 100):
        chunk = inputs[i:i + 100]
        hs_post(f"/crm/v3/objects/{type_id}/batch/update", {"inputs": chunk})
        wait_a_moment(0.4)
        print(f"  ... updated {i + len(chunk)} of {len(inputs)}")

    # 2) Deactivate the old catalog code so it can't be selected again.
    if old_rec and (old_rec.get("properties", {}).get("is_active") not in ("false", False)):
        if get_property(CATALOG, "is_active"):
            cat_type = get_object_type_id(CATALOG)
            hs_patch(f"/crm/v3/objects/{cat_type}/{old_rec['id']}", {"properties": {"is_active": "false"}})
            print(f"  deactivated catalog item {OLD_CODE} (is_active=false).")

    print(f"\n[done] Replaced {OLD_CODE} -> {NEW_CODE} on {len(inputs)} record(s).")


if __name__ == "__main__":
    main()
