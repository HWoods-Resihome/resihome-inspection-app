"""
Create the billing fields on the inspection object so the billing-sync process
(copy from Property + Agent at schedule, backfill existing) can write them.

Properties (idempotent — re-run safely):
    entity_id             text      <- property.entity_id
    full_address          text      <- property.full_address
    broker_code           text      <- agent.broker_code (matched by HubSpot owner)
    first_completed_date  datetime  stamped once, the first time it completes
    vendor_invoice_amount number/$  <- agent.inspection_vendor_cost (blank if none)
    client_invoice_amount number/$  <- agent.inspection_client_cost (defaults to 60)

(hubspot_owner_id is a built-in property — no need to create it; the process sets
it from the inspector's email so the agent can be matched by owner.)

Usage:
    python add_billing_properties.py
"""

from __future__ import annotations
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'rate_card_phase1'))
from _hubspot_helpers import (  # type: ignore
    ensure_property, ensure_property_group, get_property, hs_post, get_object_type_id, wait_a_moment,
)

INSPECTION = "inspection"
GROUP = "billing"


def ensure_currency_property(name: str, label: str, description: str) -> None:
    """Number property displayed as currency (showCurrencySymbol)."""
    if get_property(INSPECTION, name):
        print(f"  [skip] {INSPECTION}.{name} already exists.")
        return
    type_id = get_object_type_id(INSPECTION)
    body = {
        "name": name, "label": label, "type": "number", "fieldType": "number",
        "groupName": GROUP, "description": description, "showCurrencySymbol": True,
    }
    print(f"  [create] {INSPECTION}.{name} (number/currency)")
    hs_post(f"/crm/v3/properties/{type_id}", body)
    wait_a_moment(0.2)


def main():
    print("=" * 70)
    print("Create billing fields on the inspection object")
    print("=" * 70)

    ensure_property_group(INSPECTION, GROUP, "Billing")

    ensure_property(INSPECTION, "entity_id", "Entity ID",
                    type="string", field_type="text", group_name=GROUP,
                    description="Property entity_id, copied onto the inspection at schedule for billing.")
    ensure_property(INSPECTION, "full_address", "Full Address",
                    type="string", field_type="text", group_name=GROUP,
                    description="Property full_address, copied onto the inspection at schedule for billing.")
    ensure_property(INSPECTION, "broker_code", "Broker Code",
                    type="string", field_type="text", group_name=GROUP,
                    description="Agent broker_code, matched to the inspection's inspector by HubSpot owner.")
    ensure_property(INSPECTION, "first_completed_date", "First Completed Date",
                    type="datetime", field_type="date", group_name=GROUP,
                    description="Timestamp of the FIRST time the inspection was completed; not overwritten on re-finalize.")
    ensure_currency_property("vendor_invoice_amount", "Vendor Invoice Amount",
                             "Agent inspection_vendor_cost (blank when the agent has none).")
    ensure_currency_property("client_invoice_amount", "Client Invoice Amount",
                             "Agent inspection_client_cost (defaults to 60 when the agent has none).")

    print("\n[done] billing fields are ready on inspection.")


if __name__ == '__main__':
    main()
