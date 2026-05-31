#!/usr/bin/env python3
"""
clone_to_prod.py — recreate the HubSpot custom-object SCHEMA (objects +
properties + associations) and the QUESTION records from one portal into
another. Built for the sandbox -> production cutover so production gets EVERY
field that exists today (base + every field added over the project), with no
manual field entry.

WHY A LIVE CLONE (vs. hand-written field lists): it reads whatever actually
exists in the source portal right now, so it can't drift from the real schema.

SAFE BY DEFAULT:
  * `export`  is READ-ONLY against the source portal.
  * `import`  is DRY-RUN unless you pass --live, and REQUIRES --portal <id>
              matching the connected token's portal, so you can't accidentally
              write to the wrong account.

USAGE (PowerShell shown; token is read from env, never the command line):

  # 1) Export from SANDBOX (read-only)
  $env:HUBSPOT_TOKEN = "<sandbox token>"
  python clone_to_prod.py export

  # 2) Review the JSON written under scripts/prod_migration/export/

  # 3) Dry-run import into PRODUCTION (no writes; prints the plan)
  $env:HUBSPOT_TOKEN = "<production token>"
  python clone_to_prod.py import --portal 22536354

  # 4) Real import (creates objects, properties, associations)
  python clone_to_prod.py import --portal 22536354 --live

  # 5) Migrate the QUESTION records (dry-run, then --live)
  python clone_to_prod.py import-questions --portal 22536354
  python clone_to_prod.py import-questions --portal 22536354 --live

After step 4, the script prints each object's NEW production objectTypeId —
copy those into the Vercel env vars (see docs/PRODUCTION-CUTOVER.md).

Only Python 3 stdlib is used (urllib) — no pip installs required.
"""
from __future__ import annotations
import json
import os
import sys
import time
import urllib.request
import urllib.error

API = "https://api.hubapi.com"
HERE = os.path.dirname(os.path.abspath(__file__))
EXPORT_DIR = os.path.join(HERE, "export")
SCHEMAS_FILE = os.path.join(EXPORT_DIR, "schemas.json")
QUESTIONS_FILE = os.path.join(EXPORT_DIR, "questions.json")

# Property fields that are safe to send to the create/POST APIs. Everything
# else returned by GET (hubspotDefined, modificationMetadata, calculated, …) is
# read-only and would be rejected, so we strip it.
PROP_KEEP = ("name", "label", "type", "fieldType", "groupName", "description", "hasUniqueValue", "displayOrder")
OPT_KEEP = ("label", "value", "displayOrder", "hidden", "description")

# ── Scope: ONLY the custom objects this inspection app created. Everything else
# in the portal (hoas, listing, agents, properties, …) is left untouched. ──
OURS = ["inspection", "inspection_question", "inspection_answer", "rate_card_line_item", "region_rate"]

# The existing real-estate "Property" object the app READS but did NOT create.
# We don't recreate it — we only (a) print its production id for
# HUBSPOT_PROPERTY_TYPE_ID and (b) ensure the app's required fields exist on it
# (so e.g. last_tenant_time_in_home_months is added without recreating 394 props).
REF_OBJECT_CANDIDATES = ["properties", "property"]
REF_FIELDS = [
    "last_tenant_time_in_home_months", "square_footage", "state_code",
    "entity_id", "last_primary_tenant", "region", "zip", "zip_code", "address", "city",
]


def token() -> str:
    for var in ("HUBSPOT_TOKEN", "HUBSPOT_SANDBOX_TOKEN", "HUBSPOT_PRIVATE_APP_TOKEN"):
        v = os.environ.get(var)
        if v and v.strip() and not v.strip().startswith("<"):
            return v.strip()
    sys.exit("ERROR: set HUBSPOT_TOKEN to the portal's private-app token first.")


def hs(method: str, path: str, body=None):
    url = path if path.startswith("http") else API + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {token()}",
        "Content-Type": "application/json",
    })
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req) as r:
                raw = r.read().decode()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")
            if e.code == 429 and attempt < 4:
                time.sleep(0.5 * (attempt + 1)); continue
            raise SystemExit(f"HubSpot {method} {path} -> {e.code}: {detail[:600]}")
        except urllib.error.URLError as e:
            if attempt < 4: time.sleep(0.5 * (attempt + 1)); continue
            raise SystemExit(f"Network error reaching HubSpot: {e}")


def connected_portal() -> str:
    info = hs("GET", "/account-info/v3/details")
    return str(info.get("portalId"))


def all_schemas():
    return (hs("GET", "/crm/v3/schemas") or {}).get("results", [])


# ---------------------------------------------------------------- export -----
def cmd_export():
    pid = connected_portal()
    print(f"Connected to portal {pid}. Exporting ONLY the inspection app's objects (read-only)…")
    os.makedirs(EXPORT_DIR, exist_ok=True)
    out = []
    name_by_type = {}
    ref_object = None
    schemas = all_schemas()
    for s in schemas:
        name_by_type[s.get("objectTypeId")] = s.get("name")  # full map (for association naming)
    for s in schemas:
        name = s.get("name")
        type_id = s.get("objectTypeId")
        # Capture the reference Property object's required fields only (not the whole object).
        if name in REF_OBJECT_CANDIDATES and ref_object is None:
            by = {p["name"]: p for p in s.get("properties", [])}
            fields = []
            for fn in REF_FIELDS:
                p = by.get(fn)
                if not p:
                    continue
                cp = {k: p[k] for k in PROP_KEEP if k in p and p[k] is not None}
                if p.get("options"):
                    cp["options"] = [{k: o[k] for k in OPT_KEEP if k in o and o[k] is not None} for o in p["options"]]
                fields.append(cp)
            ref_object = {"name": name, "fields": fields}
            print(f"  ⌁ reference object {name}: ensuring {len(fields)}/{len(REF_FIELDS)} app fields (not recreating it)")
            continue
        if name not in OURS:
            continue  # someone else's object — skip entirely
        props = []
        for p in s.get("properties", []):
            if p.get("hubspotDefined"):
                continue
            cp = {k: p[k] for k in PROP_KEEP if k in p and p[k] is not None}
            if p.get("options"):
                cp["options"] = [{k: o[k] for k in OPT_KEEP if k in o and o[k] is not None} for o in p["options"]]
            props.append(cp)
        # Keep only associations BETWEEN our own objects (drop links to contacts,
        # listings, hoas, etc. that don't apply to the inspection app).
        assoc = [a for a in s.get("associations", [])
                 if name_by_type.get(a.get("fromObjectTypeId")) in OURS and name_by_type.get(a.get("toObjectTypeId")) in OURS]
        out.append({
            "name": name,
            "objectTypeId_source": type_id,
            "labels": s.get("labels"),
            "primaryDisplayProperty": s.get("primaryDisplayProperty"),
            "secondaryDisplayProperties": s.get("secondaryDisplayProperties", []),
            "requiredProperties": s.get("requiredProperties", []),
            "searchableProperties": s.get("searchableProperties", []),
            "properties": props,
            "associations": assoc,
        })
        print(f"  • {name}: {len(props)} custom properties, {len(assoc)} app associations")
    if not out:
        print("WARNING: none of the expected objects were found. Check OURS names match this portal.")
    with open(SCHEMAS_FILE, "w", encoding="utf-8") as f:
        json.dump({"sourcePortal": pid, "name_by_type": name_by_type, "objects": out, "ref_object": ref_object}, f, indent=2)
    print(f"\nWrote {SCHEMAS_FILE}")
    print("Review it, then run the import against production.")


# ---------------------------------------------------------------- import -----
def require_prod(portal_arg: str):
    if not portal_arg:
        sys.exit("ERROR: pass --portal <expected production portal id> as a safety check.")
    actual = connected_portal()
    if actual != str(portal_arg):
        sys.exit(f"ABORT: token is connected to portal {actual}, but --portal said {portal_arg}. "
                 f"Set HUBSPOT_TOKEN to the production token, or fix --portal.")
    return actual


def existing_prop_names(type_id: str):
    res = (hs("GET", f"/crm/v3/properties/{type_id}") or {}).get("results", [])
    return {p["name"] for p in res}


def cmd_import(portal_arg: str, live: bool):
    pid = require_prod(portal_arg)
    mode = "LIVE" if live else "DRY-RUN (no writes)"
    print(f"Import into portal {pid} — {mode}\n")
    data = json.load(open(SCHEMAS_FILE, encoding="utf-8"))
    prod = {s["name"]: s["objectTypeId"] for s in all_schemas()}
    new_ids = {}

    for obj in data["objects"]:
        name = obj["name"]
        if name in prod:
            print(f"OBJECT {name}: exists ({prod[name]}) — ensuring properties")
            type_id = prod[name]
        else:
            payload = {
                "name": name,
                "labels": obj["labels"],
                "primaryDisplayProperty": obj["primaryDisplayProperty"],
                "secondaryDisplayProperties": obj.get("secondaryDisplayProperties", []),
                "requiredProperties": obj.get("requiredProperties", []),
                "searchableProperties": obj.get("searchableProperties", []),
                "properties": obj["properties"],
            }
            if not live:
                print(f"OBJECT {name}: WOULD CREATE with {len(obj['properties'])} properties")
                new_ids[name] = "(dry-run)"; continue
            created = hs("POST", "/crm/v3/schemas", payload)
            type_id = created.get("objectTypeId")
            prod[name] = type_id
            print(f"OBJECT {name}: CREATED -> {type_id}")
        new_ids[name] = type_id

        # Ensure every property exists (covers pre-existing objects missing fields).
        if live and type_id and type_id != "(dry-run)":
            have = existing_prop_names(type_id)
            for p in obj["properties"]:
                if p["name"] in have:
                    continue
                hs("POST", f"/crm/v3/properties/{type_id}", p)
                print(f"    + property {p['name']}")

    # Associations (after all objects exist) — only BETWEEN our own objects.
    name_by_type = data.get("name_by_type", {})
    for obj in data["objects"]:
        for a in obj.get("associations", []):
            from_name = name_by_type.get(a.get("fromObjectTypeId"))
            to_name = name_by_type.get(a.get("toObjectTypeId"))
            if from_name not in OURS or to_name not in OURS:
                continue
            from_id = prod.get(from_name); to_id = prod.get(to_name)
            if not from_id or not to_id or from_id == "(dry-run)":
                print(f"ASSOC {from_name}->{to_name}: skipped (object not created yet / dry-run)"); continue
            if not live:
                print(f"ASSOC {from_name}->{to_name}: WOULD CREATE"); continue
            try:
                hs("POST", f"/crm/v3/schemas/{from_id}/associations", {"fromObjectTypeId": from_id, "toObjectTypeId": to_id})
                print(f"ASSOC {from_name}->{to_name}: created")
            except SystemExit as e:
                print(f"ASSOC {from_name}->{to_name}: {e} (may already exist — ok)")

    # Ensure the app's fields exist on the EXISTING Property object (don't recreate it).
    ref = data.get("ref_object")
    ref_type = None; ref_name = None
    if ref:
        for cand in REF_OBJECT_CANDIDATES:
            if cand in prod:
                ref_type, ref_name = prod[cand], cand; break
        if not ref_type:
            print(f"\nNOTE: Property object {REF_OBJECT_CANDIDATES} not found in this portal — set HUBSPOT_PROPERTY_TYPE_ID manually.")
        else:
            print(f"\nREFERENCE object {ref_name}: {ref_type} (existing — only ensuring app fields)")
            if live:
                have = existing_prop_names(ref_type)
                for p in ref["fields"]:
                    if p["name"] in have:
                        continue
                    hs("POST", f"/crm/v3/properties/{ref_type}", p)
                    print(f"    + property {p['name']} on {ref_name}")
            else:
                print(f"    would ensure: {', '.join(p['name'] for p in ref['fields'])} (creates only the missing ones)")

    print("\n=== Production objectTypeIds (set these in Vercel) ===")
    env_map = {
        "inspection": "HUBSPOT_INSPECTION_TYPE_ID",
        "inspection_question": "HUBSPOT_INSPECTION_QUESTION_TYPE_ID",
        "inspection_answer": "HUBSPOT_INSPECTION_ANSWER_TYPE_ID",
        "rate_card_line_item": "HUBSPOT_RATE_CARD_LINE_ITEM_TYPE_ID",
        "region_rate": "HUBSPOT_REGION_RATE_TYPE_ID",
    }
    for name, tid in new_ids.items():
        print(f"  {env_map.get(name, name)} = {tid}")
    if ref_type:
        print(f"  HUBSPOT_PROPERTY_TYPE_ID = {ref_type}")
    if not live:
        print("\nDRY-RUN only. Re-run with --live to apply.")


# ------------------------------------------------------ question records -----
def cmd_export_questions():
    """Pulled in automatically by export(); kept separate for re-runs."""
    pid = connected_portal()
    qtype = next((s["objectTypeId"] for s in all_schemas() if s["name"] == "inspection_question"), None)
    if not qtype:
        sys.exit("Could not find an 'inspection_question' object in this portal.")
    props = [p["name"] for p in (hs("GET", f"/crm/v3/properties/{qtype}") or {}).get("results", []) if not p.get("hubspotDefined")]
    rows, after = [], None
    while True:
        q = f"/crm/v3/objects/{qtype}?limit=100&properties={','.join(props)}" + (f"&after={after}" if after else "")
        page = hs("GET", q) or {}
        rows.extend({"properties": r["properties"]} for r in page.get("results", []))
        after = (page.get("paging") or {}).get("next", {}).get("after")
        if not after:
            break
    os.makedirs(EXPORT_DIR, exist_ok=True)
    json.dump({"sourcePortal": pid, "count": len(rows), "records": rows}, open(QUESTIONS_FILE, "w", encoding="utf-8"), indent=2)
    print(f"Exported {len(rows)} inspection_question records -> {QUESTIONS_FILE}")


def cmd_import_questions(portal_arg: str, live: bool):
    pid = require_prod(portal_arg)
    data = json.load(open(QUESTIONS_FILE, encoding="utf-8"))
    qtype = next((s["objectTypeId"] for s in all_schemas() if s["name"] == "inspection_question"), None)
    if not qtype:
        sys.exit("No 'inspection_question' object in production — run the schema import first.")
    # De-dupe by question_id_external so re-runs don't duplicate.
    existing = set()
    after = None
    while True:
        page = hs("GET", f"/crm/v3/objects/{qtype}?limit=100&properties=question_id_external" + (f"&after={after}" if after else "")) or {}
        for r in page.get("results", []):
            ext = r["properties"].get("question_id_external")
            if ext: existing.add(ext)
        after = (page.get("paging") or {}).get("next", {}).get("after")
        if not after: break
    todo = [r for r in data["records"] if r["properties"].get("question_id_external") not in existing]
    print(f"{len(data['records'])} source questions, {len(existing)} already in prod, {len(todo)} to create — {'LIVE' if live else 'DRY-RUN'}")
    if not live:
        return
    for i in range(0, len(todo), 100):
        chunk = todo[i:i+100]
        hs("POST", f"/crm/v3/objects/{qtype}/batch/create", {"inputs": [{"properties": r["properties"]} for r in chunk]})
        print(f"  created {min(i+100, len(todo))}/{len(todo)}")
    print("Done.")


def main():
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    cmd = args[0]
    portal = args[args.index("--portal") + 1] if "--portal" in args else ""
    live = "--live" in args
    if cmd == "export":
        cmd_export(); cmd_export_questions()
    elif cmd == "import":
        cmd_import(portal, live)
    elif cmd == "import-questions":
        cmd_import_questions(portal, live)
    else:
        sys.exit(f"Unknown command '{cmd}'. Use: export | import | import-questions")


if __name__ == "__main__":
    main()
