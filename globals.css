"""
Shared HubSpot helpers for Phase 1 scripts.

All Phase 1 scripts import from this module to avoid duplication.

Usage from any phase1 script:
    from _hubspot_helpers import (
        get_token, hs_get, hs_post, hs_patch,
        get_or_create_object_schema, ensure_property,
        ensure_picklist_value, get_object_type_id,
        wait_a_moment,
    )

Idempotency rule of thumb: every "create" function in this module first checks
whether the thing exists. If yes, no-op (or update). If no, create. This makes
it safe to re-run the Phase 1 scripts after partial failures.
"""

from __future__ import annotations
import json
import os
import sys
import time
from typing import Any, Optional
import urllib.request
import urllib.parse
import urllib.error


HUBSPOT_API_BASE = "https://api.hubapi.com"

# Module-level guard so we only print the auth diagnostic once
_DIAG_PRINTED = False


def get_token() -> str:
    """Read the HubSpot private app token. Matches the main app's convention."""
    # Env first. Try all the common var names.
    for var in ("HUBSPOT_SANDBOX_TOKEN", "HUBSPOT_TOKEN", "HUBSPOT_PRIVATE_APP_TOKEN"):
        v = os.environ.get(var)
        if v and v.strip() and not v.strip().startswith("<"):
            return _scrub_token(v)

    # Then .env.local, walking up from this file's directory.
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = []
    cur = here
    for _ in range(6):
        candidates.append(os.path.join(cur, ".env.local"))
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent

    for env_path in candidates:
        if not os.path.exists(env_path):
            continue
        # Read with utf-8-sig to strip a BOM if Windows added one
        with open(env_path, encoding="utf-8-sig") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k in ("HUBSPOT_SANDBOX_TOKEN", "HUBSPOT_TOKEN", "HUBSPOT_PRIVATE_APP_TOKEN"):
                    if v and not v.startswith("<"):
                        print(f"  [token] loaded from {env_path} ({k})")
                        return _scrub_token(v)

    print("ERROR: HubSpot token not found.", file=sys.stderr)
    print("Looked for env vars: HUBSPOT_SANDBOX_TOKEN, HUBSPOT_TOKEN, HUBSPOT_PRIVATE_APP_TOKEN", file=sys.stderr)
    print("And .env.local at these paths (none had a usable token):", file=sys.stderr)
    for p in candidates:
        print(f"  {p} {'(exists)' if os.path.exists(p) else '(missing)'}", file=sys.stderr)
    print("\nFix: set HUBSPOT_SANDBOX_TOKEN in your environment, OR place .env.local at the app root", file=sys.stderr)
    print("(C:\\Users\\hwoods\\Documents\\inspection_app\\.env.local) with HUBSPOT_SANDBOX_TOKEN=pat-...", file=sys.stderr)
    sys.exit(1)


def _scrub_token(raw: str) -> str:
    """Strip whitespace, BOM, zero-width characters, and stray quotes from a token.
    Defensive: tokens copied from web pages or Windows Notepad sometimes carry junk.
    """
    if raw is None:
        return ""
    # Remove BOM, zero-width space, and similar invisibles
    bad = ("\ufeff", "\u200b", "\u200c", "\u200d", "\u00a0", "\r", "\n", "\t")
    out = raw
    for ch in bad:
        out = out.replace(ch, "")
    return out.strip().strip('"').strip("'").strip()


def _request(method: str, path: str, body: Optional[dict] = None) -> dict:
    """Low-level HubSpot HTTP. Returns parsed JSON or raises on error."""
    global _DIAG_PRINTED
    token = get_token()
    url = HUBSPOT_API_BASE + path

    # First call: show diagnostic info so auth issues are debuggable.
    if not _DIAG_PRINTED:
        _DIAG_PRINTED = True
        masked = f"{token[:10]}...{token[-4:]}" if len(token) >= 14 else "(too short)"
        print(f"  [auth] token length={len(token)} prefix={token[:4]!r} masked={masked}")
        if not token.startswith("pat-"):
            print(f"  [auth] WARNING: token does not start with 'pat-' — this is unusual for a HubSpot private app token", file=sys.stderr)

    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")

    req = urllib.request.Request(url, data=data, method=method)
    # Use add_header rather than the headers dict — more reliable across Python versions
    # for ensuring the header survives any redirect/retry logic.
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8") if e.fp else ""
        raise RuntimeError(f"HTTP {e.code} {method} {path}: {raw}") from e


def hs_get(path: str) -> dict:
    return _request("GET", path)


def hs_post(path: str, body: dict) -> dict:
    return _request("POST", path, body)


def hs_patch(path: str, body: dict) -> dict:
    return _request("PATCH", path, body)


def hs_delete(path: str) -> dict:
    return _request("DELETE", path)


def wait_a_moment(seconds: float = 0.3):
    """HubSpot's API has soft rate limits. Polite pauses between writes."""
    time.sleep(seconds)


# ---------------------------------------------------------------------------
# Object schema helpers
# ---------------------------------------------------------------------------

def list_custom_object_schemas() -> list[dict]:
    """Return all custom object schemas in the portal."""
    resp = hs_get("/crm/v3/schemas")
    return resp.get("results", [])


def find_object_schema_by_name(name: str) -> Optional[dict]:
    """Find a custom object schema by its name (case-insensitive, label or fully-qualified)."""
    schemas = list_custom_object_schemas()
    needle = name.lower()
    for s in schemas:
        if (s.get("name") or "").lower() == needle:
            return s
        labels = s.get("labels") or {}
        if (labels.get("singular") or "").lower() == needle:
            return s
        if (labels.get("plural") or "").lower() == needle:
            return s
        # fullyQualifiedName looks like "p_<portal>_<name>" or "<portal>_<name>"
        fqn = (s.get("fullyQualifiedName") or "").lower()
        if fqn.endswith("_" + needle) or fqn == needle:
            return s
    return None


def get_object_type_id(name: str) -> str:
    """Return the objectTypeId for a custom object (e.g., '2-12345678').
    Built-in types use their friendly names too; we accept those.
    """
    builtins = {
        "contact": "0-1",
        "company": "0-2",
        "deal": "0-3",
        "ticket": "0-5",
    }
    if name.lower() in builtins:
        return builtins[name.lower()]
    schema = find_object_schema_by_name(name)
    if not schema:
        raise RuntimeError(f"Custom object schema '{name}' not found in this portal.")
    return schema.get("objectTypeId") or schema["id"]


def create_custom_object_schema(definition: dict) -> dict:
    """Create a new custom object schema. Idempotent: returns existing if a schema with the same name already exists."""
    name = definition.get("name")
    existing = find_object_schema_by_name(name) if name else None
    if existing:
        print(f"  [skip] Object schema '{name}' already exists (objectTypeId={existing.get('objectTypeId')}).")
        return existing
    print(f"  [create] Creating object schema '{name}'...")
    resp = hs_post("/crm/v3/schemas", definition)
    wait_a_moment(0.5)
    return resp


def update_schema_display_and_search(
    name_or_type_id: str,
    secondary_display_properties: Optional[list[str]] = None,
    searchable_properties: Optional[list[str]] = None,
) -> dict:
    """
    Update an existing schema's secondary display properties and/or searchable properties.
    Useful when those refs need properties that didn't exist at creation time.

    Idempotent: PATCH replaces the lists, so re-running is safe.
    """
    if "-" in name_or_type_id:
        type_id = name_or_type_id
    else:
        type_id = get_object_type_id(name_or_type_id)
    body: dict[str, Any] = {}
    if secondary_display_properties is not None:
        body["secondaryDisplayProperties"] = secondary_display_properties
    if searchable_properties is not None:
        body["searchableProperties"] = searchable_properties
    if not body:
        return {}
    print(f"  [patch schema] {name_or_type_id}: {list(body.keys())}")
    resp = hs_patch(f"/crm/v3/schemas/{type_id}", body)
    wait_a_moment(0.3)
    return resp


# ---------------------------------------------------------------------------
# Property helpers
# ---------------------------------------------------------------------------

def list_properties(object_type: str) -> list[dict]:
    """List all properties on an object type. object_type can be name or objectTypeId."""
    type_id = object_type if "-" in object_type or object_type.startswith("0-") else get_object_type_id(object_type)
    resp = hs_get(f"/crm/v3/properties/{type_id}")
    return resp.get("results", [])


def get_property(object_type: str, property_name: str) -> Optional[dict]:
    """Return a property by name, or None if it doesn't exist."""
    type_id = object_type if "-" in object_type or object_type.startswith("0-") else get_object_type_id(object_type)
    try:
        return hs_get(f"/crm/v3/properties/{type_id}/{property_name}")
    except RuntimeError as e:
        if "404" in str(e):
            return None
        raise


def ensure_property(
    object_type: str,
    name: str,
    label: str,
    type: str = "string",
    field_type: str = "text",
    group_name: str = "rate_card",
    description: str = "",
    options: Optional[list[dict]] = None,
    display_order: int = -1,
) -> dict:
    """
    Create or update a property. Idempotent.

    type: 'string', 'number', 'date', 'datetime', 'enumeration', 'bool'
    field_type: 'text', 'textarea', 'number', 'select', 'radio', 'checkbox', 'booleancheckbox', 'date'
    options: for enumeration only, e.g. [{'label': 'Foo', 'value': 'foo'}]
    """
    type_id = object_type if "-" in object_type or object_type.startswith("0-") else get_object_type_id(object_type)
    body: dict[str, Any] = {
        "name": name,
        "label": label,
        "type": type,
        "fieldType": field_type,
        "groupName": group_name,
        "description": description,
    }
    if options is not None:
        body["options"] = options
    if display_order >= 0:
        body["displayOrder"] = display_order

    existing = get_property(object_type, name)
    if existing:
        # Compare a few fields to decide if we need a patch.
        patch_needed = {}
        if existing.get("label") != label:
            patch_needed["label"] = label
        if existing.get("description") != description and description:
            patch_needed["description"] = description
        # For picklists, sync options if changed.
        if options is not None:
            existing_opts = existing.get("options") or []
            existing_vals = {(o.get("value"), o.get("label")) for o in existing_opts}
            new_vals = {(o.get("value"), o.get("label")) for o in options}
            if existing_vals != new_vals:
                patch_needed["options"] = options
        if patch_needed:
            print(f"  [patch] {object_type}.{name}: {list(patch_needed.keys())}")
            hs_patch(f"/crm/v3/properties/{type_id}/{name}", patch_needed)
            wait_a_moment(0.2)
        else:
            print(f"  [skip] {object_type}.{name} already exists and matches.")
        return existing
    print(f"  [create] {object_type}.{name} ({type}/{field_type})")
    resp = hs_post(f"/crm/v3/properties/{type_id}", body)
    wait_a_moment(0.2)
    return resp


def ensure_property_group(object_type: str, name: str, label: str) -> dict:
    """Create a property group if it doesn't exist."""
    type_id = object_type if "-" in object_type or object_type.startswith("0-") else get_object_type_id(object_type)
    try:
        existing = hs_get(f"/crm/v3/properties/{type_id}/groups/{name}")
        return existing
    except RuntimeError as e:
        if "404" not in str(e):
            raise
    print(f"  [create group] {object_type}.{name}")
    resp = hs_post(f"/crm/v3/properties/{type_id}/groups", {"name": name, "label": label})
    wait_a_moment(0.2)
    return resp


# ---------------------------------------------------------------------------
# Picklist option helpers (for adding values to an existing enumeration prop)
# ---------------------------------------------------------------------------

def ensure_picklist_value(object_type: str, property_name: str, value: str, label: str) -> bool:
    """
    Make sure the picklist property has the given option. Returns True if it was added,
    False if it already existed.
    """
    prop = get_property(object_type, property_name)
    if not prop:
        raise RuntimeError(f"Property {object_type}.{property_name} not found; cannot add option.")
    if prop.get("type") != "enumeration":
        raise RuntimeError(f"Property {object_type}.{property_name} is not an enumeration (type={prop.get('type')}).")
    options = prop.get("options") or []
    if any(o.get("value") == value for o in options):
        print(f"  [skip] {object_type}.{property_name} already has option '{value}'.")
        return False
    options.append({"label": label, "value": value, "displayOrder": len(options), "hidden": False})
    type_id = object_type if "-" in object_type or object_type.startswith("0-") else get_object_type_id(object_type)
    print(f"  [add option] {object_type}.{property_name} += '{value}'")
    hs_patch(f"/crm/v3/properties/{type_id}/{property_name}", {"options": options})
    wait_a_moment(0.2)
    return True


# ---------------------------------------------------------------------------
# Association helpers
# ---------------------------------------------------------------------------

def list_association_labels(from_type: str, to_type: str) -> list[dict]:
    """Return all association labels from one object type to another."""
    from_id = from_type if "-" in from_type else get_object_type_id(from_type)
    to_id = to_type if "-" in to_type else get_object_type_id(to_type)
    resp = hs_get(f"/crm/v4/associations/{from_id}/{to_id}/labels")
    return resp.get("results", [])


def ensure_association(from_type: str, to_type: str, label: str, name: str) -> dict:
    """Create an association schema between two custom objects. Idempotent."""
    from_id = from_type if "-" in from_type else get_object_type_id(from_type)
    to_id = to_type if "-" in to_type else get_object_type_id(to_type)
    existing = list_association_labels(from_id, to_id)
    for e in existing:
        if (e.get("label") or "").lower() == label.lower() or (e.get("name") or "").lower() == name.lower():
            print(f"  [skip] Association {from_type} -> {to_type} '{label}' already exists (typeId={e.get('typeId')}).")
            return e
    print(f"  [create] Association {from_type} -> {to_type} '{label}'")
    resp = hs_post(f"/crm/v4/associations/{from_id}/{to_id}/labels", {
        "label": label,
        "name": name,
    })
    wait_a_moment(0.3)
    return resp.get("results", [{}])[0] if isinstance(resp.get("results"), list) else resp


# ---------------------------------------------------------------------------
# Record CRUD with idempotent batch upsert by external id
# ---------------------------------------------------------------------------

def search_records(object_type: str, prop_name: str, value: str, properties: list[str]) -> list[dict]:
    """Search records of object_type where prop_name == value. Returns up to 100."""
    type_id = object_type if "-" in object_type else get_object_type_id(object_type)
    body = {
        "filterGroups": [{"filters": [{"propertyName": prop_name, "operator": "EQ", "value": value}]}],
        "properties": properties,
        "limit": 100,
    }
    resp = hs_post(f"/crm/v3/objects/{type_id}/search", body)
    return resp.get("results", [])


def batch_upsert_by_unique_property(
    object_type: str,
    records: list[dict],
    id_property: str,
    batch_size: int = 100,
) -> tuple[int, int]:
    """
    Upsert records using a custom unique property as the natural key.

    Each record must have its id_property value in its 'properties' dict.
    Returns (created, updated) count.
    """
    type_id = object_type if "-" in object_type else get_object_type_id(object_type)
    created_total = 0
    updated_total = 0

    for i in range(0, len(records), batch_size):
        chunk = records[i:i + batch_size]
        body = {
            "inputs": [
                {
                    "idProperty": id_property,
                    "id": str(r["properties"][id_property]),
                    "properties": r["properties"],
                }
                for r in chunk
            ],
        }
        try:
            resp = hs_post(f"/crm/v3/objects/{type_id}/batch/upsert", body)
            results = resp.get("results", [])
            for r in results:
                # createdAt == updatedAt (within a few ms) means freshly created
                ca = r.get("createdAt")
                ua = r.get("updatedAt")
                if ca and ua and ca == ua:
                    created_total += 1
                else:
                    updated_total += 1
        except RuntimeError as e:
            print(f"  [error] Batch {i}-{i+len(chunk)} failed: {e}")
            raise
        wait_a_moment(0.4)
        print(f"  ... upserted {i + len(chunk)} of {len(records)}")

    return created_total, updated_total


def fetch_all_records(object_type: str, properties: list[str], extra_filter: Optional[dict] = None) -> list[dict]:
    """Page through all records of a type. Use sparingly."""
    type_id = object_type if "-" in object_type else get_object_type_id(object_type)
    out = []
    after = None
    while True:
        body = {
            "filterGroups": [extra_filter] if extra_filter else [],
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
        wait_a_moment(0.2)
    return out
