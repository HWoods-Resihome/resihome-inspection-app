"""
Short Links, Step 2: backfill link_* on every inspection (open AND closed).

For each inspection that has stored PDF/xlsx URLs, compute the short signed
share links and write them into link_master / link_chargeback / link_xlsx /
link_vendors_json. Idempotent — safe to re-run.

The link signature MUST match the web app's lib/shortLinks.ts exactly:
    sig = HMAC_SHA256(SESSION_SECRET, f"{id}:{type}:{vendorSlug}").hexdigest()[:10]
    link (non-vendor) = {BASE}/d/{id}/{type}/{sig}
    link (vendor)     = {BASE}/d/{id}/v/{vendorSlug}/{sig}
So this script needs the SAME SESSION_SECRET that production uses, and the same
public base URL.

Env / config:
    SESSION_SECRET        - REQUIRED. Must equal the production value (or the
                            generated links won't verify). Read from env or .env.local.
    SHORT_LINK_BASE_URL   - public app origin for the links (default https://resiwalk.com).
                            May also be passed as argv[1].
    HUBSPOT_*             - token, same as the other scripts (see _hubspot_helpers).

Usage:
    SESSION_SECRET=... python step2_backfill_short_links.py [https://resiwalk.com]
    python step2_backfill_short_links.py --dry-run        # preview, no writes
"""

from __future__ import annotations
import sys
import os
import re
import json
import hmac
import hashlib

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'rate_card_phase1'))
from _hubspot_helpers import (  # type: ignore
    get_object_type_id, fetch_all_records, hs_patch, wait_a_moment,
)

INSPECTION = "inspection"
DEFAULT_BASE = "https://resiwalk.com"

PDF_PROPS = ["pdf_master_url", "pdf_chargeback_url", "pdf_chargeback_xlsx_url", "pdf_vendor_urls_json", "pdf_attachment_url"]
TYPE_TO_PROP = {
    "master": "pdf_master_url",
    "chargeback": "pdf_chargeback_url",
    "xlsx": "pdf_chargeback_xlsx_url",
}


def read_session_secret() -> str:
    """Read SESSION_SECRET from env, falling back to .env.local (walking up)."""
    v = os.environ.get("SESSION_SECRET")
    if v and v.strip():
        return v.strip().strip('"').strip("'")
    here = os.path.dirname(os.path.abspath(__file__))
    cur = here
    for _ in range(6):
        env_path = os.path.join(cur, ".env.local")
        if os.path.exists(env_path):
            with open(env_path, encoding="utf-8-sig") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("SESSION_SECRET") and "=" in line:
                        val = line.split("=", 1)[1].strip().strip('"').strip("'")
                        if val:
                            print(f"  [secret] loaded SESSION_SECRET from {env_path}")
                            return val
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    print("ERROR: SESSION_SECRET not found in env or .env.local.", file=sys.stderr)
    print("It MUST match the production value or the links won't verify.", file=sys.stderr)
    sys.exit(1)


def slugify_vendor(vendor: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (vendor or "").lower())
    s = re.sub(r"^-+|-+$", "", s)
    return s or "vendor"


def sig_for(secret: str, record_id: str, type_: str, vendor_slug: str = "") -> str:
    msg = f"{record_id}:{type_}:{vendor_slug}".encode("utf-8")
    return hmac.new(secret.encode("utf-8"), msg, hashlib.sha256).hexdigest()[:10]


def build_short_link(secret: str, base: str, record_id: str, type_: str, vendor_name: str | None = None) -> str:
    base = base.rstrip("/")
    if type_ == "vendor":
        slug = slugify_vendor(vendor_name or "")
        return f"{base}/d/{record_id}/v/{slug}/{sig_for(secret, record_id, 'vendor', slug)}"
    return f"{base}/d/{record_id}/{type_}/{sig_for(secret, record_id, type_)}"


def main():
    args = [a for a in sys.argv[1:]]
    dry_run = "--dry-run" in args
    args = [a for a in args if a != "--dry-run"]
    base = (args[0] if args else os.environ.get("SHORT_LINK_BASE_URL") or DEFAULT_BASE).rstrip("/")
    secret = read_session_secret()

    print("=" * 70)
    print("Short Links, Step 2: backfill link_* on all inspections")
    print(f"  base URL : {base}")
    print(f"  dry-run  : {dry_run}")
    print("=" * 70)

    type_id = get_object_type_id(INSPECTION)
    records = fetch_all_records(INSPECTION, PDF_PROPS)
    print(f"  fetched {len(records)} inspection records")

    updated = 0
    skipped = 0
    for rec in records:
        rid = rec.get("id")
        props = rec.get("properties") or {}
        master = (props.get("pdf_master_url") or "").strip()
        chargeback = (props.get("pdf_chargeback_url") or "").strip()
        xlsx = (props.get("pdf_chargeback_xlsx_url") or "").strip()
        report = (props.get("pdf_attachment_url") or "").strip()
        vendors_raw = (props.get("pdf_vendor_urls_json") or "").strip()

        vendor_map = {}
        if vendors_raw:
            try:
                parsed = json.loads(vendors_raw)
                if isinstance(parsed, dict):
                    vendor_map = parsed
            except Exception:
                pass

        # Nothing finalized on this record → skip.
        if not master and not chargeback and not xlsx and not report and not vendor_map:
            skipped += 1
            continue

        patch = {
            "link_master": build_short_link(secret, base, rid, "master") if master else "",
            "link_chargeback": build_short_link(secret, base, rid, "chargeback") if chargeback else "",
            "link_xlsx": build_short_link(secret, base, rid, "xlsx") if xlsx else "",
            "link_report": build_short_link(secret, base, rid, "report") if report else "",
            "link_vendors_json": json.dumps({
                vendor: build_short_link(secret, base, rid, "vendor", vendor)
                for vendor in vendor_map.keys()
            }),
        }

        if dry_run:
            print(f"  [dry] {rid}: {patch['link_master'] or '(no master)'}")
            updated += 1
            continue

        try:
            hs_patch(f"/crm/v3/objects/{type_id}/{rid}", {"properties": patch})
            updated += 1
            if updated % 25 == 0:
                print(f"  ...updated {updated}")
            wait_a_moment(0.15)
        except Exception as e:
            print(f"  [error] {rid}: {e}", file=sys.stderr)

    print("\n[done]")
    print(f"  updated : {updated}")
    print(f"  skipped : {skipped} (no finalized PDFs)")


if __name__ == '__main__':
    main()
