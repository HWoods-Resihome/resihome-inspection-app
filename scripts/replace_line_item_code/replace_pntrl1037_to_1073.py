"""
One-time data migration: replace the old paint line-item code PNTRL1037 with
PNTRL1073 on every historical inspection_answer rate-card line.

SELF-CONTAINED — no other project files are needed. Just Python 3.8+ and a
HubSpot private-app token.

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
    # 1) set your token (use the SANDBOX token first, then prod when ready)
    export HUBSPOT_TOKEN=pat-xxxxxxxx           # macOS/Linux
    #   setx HUBSPOT_TOKEN "pat-xxxxxxxx"        # Windows (new shell after)

    # 2) dry run — prints exactly what WOULD change, writes nothing
    python replace_pntrl1037_to_1073.py

    # 3) apply — writes the changes
    python replace_pntrl1037_to_1073.py --apply

It also reads HUBSPOT_SANDBOX_TOKEN / HUBSPOT_PRIVATE_APP_TOKEN, and falls back
to a .env.local file (walking up from this script) — same convention as the
other scripts in this repo.
"""
from __future__ import annotations
import json
import os
import sys
import time
import urllib.request
import urllib.error

# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------
OLD_CODE = "PNTRL1037"
NEW_CODE = "PNTRL1073"
INSPECTION_ANSWER = "inspection_answer"
CATALOG = "rate_card_line_item"
API_BASE = "https://api.hubapi.com"
DESC_FIELDS = ["line_item_code", "labor_short_description", "labor_subtext", "labor_full_description"]


# --------------------------------------------------------------------------
# Token + low-level HTTP
# --------------------------------------------------------------------------
def get_token() -> str:
    for var in ("HUBSPOT_SANDBOX_TOKEN", "HUBSPOT_TOKEN", "HUBSPOT_PRIVATE_APP_TOKEN"):
        v = os.environ.get(var)
        if v and v.strip() and not v.strip().startswith("<"):
            return v.strip().strip('"').strip("'")
    # Fallback: .env.local walking up from this file.
    here = os.path.dirname(os.path.abspath(__file__))
    cur = here
    for _ in range(6):
        env_path = os.path.join(cur, ".env.local")
        if os.path.exists(env_path):
            with open(env_path, encoding="utf-8-sig") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, val = line.split("=", 1)
                    if k.strip() in ("HUBSPOT_SANDBOX_TOKEN", "HUBSPOT_TOKEN", "HUBSPOT_PRIVATE_APP_TOKEN"):
                        val = val.strip().strip('"').strip("'")
                        if val and not val.startswith("<"):
                            print(f"  [token] loaded from {env_path}")
                            return val
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    print("ERROR: HubSpot token not found. Set HUBSPOT_TOKEN (or HUBSPOT_SANDBOX_TOKEN).", file=sys.stderr)
    sys.exit(1)


_TOKEN = None


def _request(method: str, path: str, body: dict | None = None) -> dict:
    global _TOKEN
    if _TOKEN is None:
        _TOKEN = get_token()
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(API_BASE + path, data=data, method=method)
    req.add_header("Authorization", f"Bearer {_TOKEN}")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    # Retry transient errors politely.
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8") if e.fp else ""
            if e.code in (429, 502, 503, 504) and attempt < 4:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise RuntimeError(f"HTTP {e.code} {method} {path}: {raw}") from e
    raise RuntimeError(f"giving up on {method} {path}")


def hs_get(path: str) -> dict:
    return _request("GET", path)


def hs_post(path: str, body: dict) -> dict:
    return _request("POST", path, body)


def hs_patch(path: str, body: dict) -> dict:
    return _request("PATCH", path, body)


# --------------------------------------------------------------------------
# Object-type + record helpers
# --------------------------------------------------------------------------
_TYPE_IDS: dict[str, str] = {}


def get_object_type_id(name: str) -> str:
    if name in _TYPE_IDS:
        return _TYPE_IDS[name]
    needle = name.lower()
    schemas = hs_get("/crm/v3/schemas").get("results", [])
    for s in schemas:
        labels = s.get("labels") or {}
        fqn = (s.get("fullyQualifiedName") or "").lower()
        if ((s.get("name") or "").lower() == needle
                or (labels.get("singular") or "").lower() == needle
                or (labels.get("plural") or "").lower() == needle
                or fqn.endswith("_" + needle) or fqn == needle):
            tid = s.get("objectTypeId") or s["id"]
            _TYPE_IDS[name] = tid
            return tid
    raise RuntimeError(f"Custom object schema '{name}' not found in this portal.")


def search_eq(object_type: str, prop: str, value: str, properties: list[str]) -> list[dict]:
    """Page through every record where prop == value."""
    type_id = get_object_type_id(object_type)
    out, after = [], None
    while True:
        body = {
            "filterGroups": [{"filters": [{"propertyName": prop, "operator": "EQ", "value": value}]}],
            "properties": properties,
            "limit": 100,
        }
        if after:
            body["after"] = after
        resp = hs_post(f"/crm/v3/objects/{type_id}/search", body)
        out.extend(resp.get("results", []))
        after = (resp.get("paging") or {}).get("next", {}).get("after")
        if not after:
            break
        time.sleep(0.2)
    return out


def get_property(object_type: str, prop: str) -> dict | None:
    type_id = get_object_type_id(object_type)
    try:
        return hs_get(f"/crm/v3/properties/{type_id}/{prop}")
    except RuntimeError as e:
        if "404" in str(e):
            return None
        raise


# --------------------------------------------------------------------------
# Catalog description helpers (to realign answer_value safely)
# --------------------------------------------------------------------------
def catalog_record(code: str) -> dict | None:
    recs = search_eq(CATALOG, "line_item_code", code, DESC_FIELDS + ["is_active"])
    return recs[0] if recs else None


def old_descriptions(rec: dict | None) -> set[str]:
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


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
def main():
    apply = "--apply" in sys.argv
    print("=" * 70)
    print(f"Replace {OLD_CODE} -> {NEW_CODE} on inspection_answer  ({'APPLY' if apply else 'DRY RUN'})")
    print("=" * 70)

    old_rec = catalog_record(OLD_CODE)
    new_rec = catalog_record(NEW_CODE)
    if not new_rec:
        print(f"WARNING: catalog has no {NEW_CODE}. Codes will still swap, but answer_value "
              f"won't be realigned and the picker may show a blank item.")
    old_descs = old_descriptions(old_rec)
    new_pref = preferred_description(new_rec)
    print(f"  old catalog descriptions to realign: {sorted(old_descs) or '(none / catalog item missing)'}")
    print(f"  new preferred description:           {new_pref!r}")

    type_id = get_object_type_id(INSPECTION_ANSWER)
    matches = search_eq(INSPECTION_ANSWER, "rate_card_line_item_code", OLD_CODE,
                        ["rate_card_line_item_code", "answer_value", "answer_summary"])
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
        time.sleep(0.4)
        print(f"  ... updated {i + len(chunk)} of {len(inputs)}")

    # 2) Deactivate the old catalog code so it can't be selected again.
    if old_rec and str(old_rec.get("properties", {}).get("is_active")).lower() != "false":
        if get_property(CATALOG, "is_active"):
            cat_type = get_object_type_id(CATALOG)
            hs_patch(f"/crm/v3/objects/{cat_type}/{old_rec['id']}", {"properties": {"is_active": "false"}})
            print(f"  deactivated catalog item {OLD_CODE} (is_active=false).")

    print(f"\n[done] Replaced {OLD_CODE} -> {NEW_CODE} on {len(inputs)} record(s).")


if __name__ == "__main__":
    main()
