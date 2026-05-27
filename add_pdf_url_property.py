"""
One-off patch: add `pdf_attachment_url` property to the Inspection object.

This is for the field app to write the generated PDF URL back to the Inspection
record so it appears as a clickable link in the HubSpot UI.

Usage (Windows PowerShell):
  $env:HUBSPOT_SANDBOX_TOKEN="pat-na1-..."
  python add_pdf_url_property.py

Idempotent: if the property already exists, exits cleanly without making changes.
"""
import os
import sys
import json
import logging
import requests

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
log = logging.getLogger(__name__)

INSPECTION_TYPE_ID = "2-63142762"
API_BASE = "https://api.hubapi.com"


def get_token():
    t = os.environ.get('HUBSPOT_SANDBOX_TOKEN')
    if not t:
        log.error("HUBSPOT_SANDBOX_TOKEN env var is not set")
        sys.exit(1)
    return t


def main():
    token = get_token()
    headers = {
        'Authorization': f'Bearer {token}',
        'Content-Type': 'application/json',
    }

    # Check if property already exists
    log.info(f"Checking if pdf_attachment_url already exists on {INSPECTION_TYPE_ID}...")
    r = requests.get(
        f"{API_BASE}/crm/v3/properties/{INSPECTION_TYPE_ID}/pdf_attachment_url",
        headers=headers,
    )
    if r.status_code == 200:
        log.info("[SKIP] pdf_attachment_url already exists. No changes made.")
        return

    if r.status_code != 404:
        log.error(f"Unexpected status {r.status_code} checking property: {r.text[:300]}")
        sys.exit(2)

    # Create the property
    log.info("Creating pdf_attachment_url property...")
    payload = {
        "name": "pdf_attachment_url",
        "label": "PDF Attachment URL",
        "type": "string",
        "fieldType": "text",
        "description": "URL to the auto-generated inspection PDF stored in HubSpot Files.",
        "groupName": "inspection_information",
        "displayOrder": 25,
    }
    r = requests.post(
        f"{API_BASE}/crm/v3/properties/{INSPECTION_TYPE_ID}",
        headers=headers,
        data=json.dumps(payload),
    )
    if r.status_code in (200, 201):
        log.info("[OK] pdf_attachment_url property created.")
    else:
        # Maybe the group name is different; try without groupName
        log.warning(f"Create failed with {r.status_code}: {r.text[:300]}")
        log.info("Retrying without groupName...")
        del payload['groupName']
        r = requests.post(
            f"{API_BASE}/crm/v3/properties/{INSPECTION_TYPE_ID}",
            headers=headers,
            data=json.dumps(payload),
        )
        if r.status_code in (200, 201):
            log.info("[OK] pdf_attachment_url property created (without group).")
        else:
            log.error(f"[FAIL] Could not create property: {r.status_code} {r.text[:500]}")
            sys.exit(3)


if __name__ == '__main__':
    main()
