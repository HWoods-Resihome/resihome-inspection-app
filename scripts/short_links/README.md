# Short Links — HubSpot property setup + backfill

Adds clean, signed share links (`/d/<id>/<type>/<sig>` → 302 to the real
HubSpot file) onto the inspection record, and backfills every existing
inspection (open **and** closed).

The links are stored in NEW properties next to the existing `pdf_*_url`
properties — the `pdf_*_url` values stay as the resolver's real-file source and
must NOT be overwritten.

## Properties added
| Property | Holds |
|---|---|
| `link_master` | short link → Master Rate Card PDF |
| `link_chargeback` | short link → Tenant Chargeback PDF |
| `link_xlsx` | short link → Tenant Chargeback Import xlsx |
| `link_vendors_json` | JSON `{ vendorName: shortLink }` for per-vendor PDFs |

## Run order
```bash
# 1) create the properties (idempotent)
python step1_add_link_properties.py

# 2) preview the backfill (no writes)
SESSION_SECRET=<prod value> python step2_backfill_short_links.py --dry-run

# 3) run it for real
SESSION_SECRET=<prod value> python step2_backfill_short_links.py https://resiwalk.com
```

## ⚠️ SESSION_SECRET must match production
The link signature is `HMAC_SHA256(SESSION_SECRET, "<id>:<type>:<vendorSlug>")`,
truncated to 10 hex chars — identical to the web app (`lib/shortLinks.ts`). If
the script signs with a different secret than production, the generated links
will **fail verification** at `/d/...`. Run the backfill with the same
`SESSION_SECRET` that's set on Vercel (and the same public base URL,
default `https://resiwalk.com`).

Tokens: same as the other scripts — `HUBSPOT_SANDBOX_TOKEN` / `HUBSPOT_TOKEN` /
`HUBSPOT_PRIVATE_APP_TOKEN` from env or `.env.local`. Point at the **prod**
portal token to backfill prod.
