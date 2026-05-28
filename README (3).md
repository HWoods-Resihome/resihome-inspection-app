"""
Phase 1, Step 3: Extend Inspection and Inspection Answer objects.

Adds:
  On inspection_answer (custom object):
    - rate_card_line_item_code      (FK to rate_card_line_item.line_item_code)
    - category_snapshot             (e.g., "Plumbing")
    - subcategory_snapshot          (e.g., "Vanity")
    - region_snapshot               (e.g., "GA: Atlanta")
    - labor_hours_snapshot
    - labor_hourly_rate_snapshot    (from region matrix, NOT catalog)
    - material_rate_snapshot
    - material_qty_snapshot
    - material_cost_snapshot        (pre-adjustment)
    - material_cost_adjustment_snapshot
    - material_tax_adjustment_snapshot
    - is_labor_only_snapshot
    - is_bid_item_snapshot
    - quantity_decimal              (already exists, see below)
    - tenant_bill_back_percent
    - labor_total
    - material_total
    - vendor_cost
    - client_cost
    - tenant_cost
    - is_custom_priced              (true if inspector overrode the catalog price)

  On inspection (custom object):
    Aggregates:
      - total_line_items
      - total_vendor_cost
      - total_client_cost
      - total_tenant_cost
      - total_line_quantity
    PDFs:
      - tenant_chargeback_pdf_url
      - vendor_pdfs_json
      - pdf_bundle_zip_url
      (pdf_attachment_url already exists; reused for master PDF)
    Region:
      - region_snapshot              (captured at inspection start from property)

  Picklist additions to existing properties:
    - inspection.template_type      += "pm_scope_rate_card"
    - inspection.status             += "Pending Approval"
    - inspection_answer.answer_type += "rate_card_line"

Idempotent: safe to re-run.
"""

from _hubspot_helpers import (
    ensure_property,
    ensure_property_group,
    ensure_picklist_value,
)


INSPECTION = "inspection"
INSPECTION_ANSWER = "inspection_answer"


def main():
    print("=" * 70)
    print("Phase 1, Step 3: Extend inspection + inspection_answer")
    print("=" * 70)

    # ----- Inspection answer extensions ---------------------------------
    print("\nProperty groups on inspection_answer:")
    ensure_property_group(INSPECTION_ANSWER, "rate_card_line", "Rate Card Line")
    ensure_property_group(INSPECTION_ANSWER, "rate_card_snapshots", "Rate Card Snapshots")
    ensure_property_group(INSPECTION_ANSWER, "rate_card_totals", "Rate Card Totals")

    print("\nRate card line metadata on inspection_answer:")
    ensure_property(INSPECTION_ANSWER, "rate_card_line_item_code", "Line Item Code",
                    type="string", field_type="text", group_name="rate_card_line",
                    description="Foreign key to rate_card_line_item.line_item_code.")

    ensure_property(INSPECTION_ANSWER, "category_snapshot", "Category",
                    type="string", field_type="text", group_name="rate_card_snapshots",
                    description="Snapshot of category at line creation time.")

    ensure_property(INSPECTION_ANSWER, "subcategory_snapshot", "Subcategory",
                    type="string", field_type="text", group_name="rate_card_snapshots",
                    description="Snapshot of subcategory at line creation time.")

    ensure_property(INSPECTION_ANSWER, "region_snapshot", "Region",
                    type="string", field_type="text", group_name="rate_card_snapshots",
                    description="Snapshot of the property's region at line creation time (e.g., 'GA: Atlanta').")

    ensure_property(INSPECTION_ANSWER, "labor_hours_snapshot", "Labor Hours (Snapshot)",
                    type="number", field_type="number", group_name="rate_card_snapshots",
                    description="Catalog labor_hours value at the time the line was added.")

    ensure_property(INSPECTION_ANSWER, "labor_hourly_rate_snapshot", "Labor Hourly Rate (Snapshot)",
                    type="number", field_type="number", group_name="rate_card_snapshots",
                    description="Hourly rate from region_rate matrix at line creation, used in the calculation.")

    ensure_property(INSPECTION_ANSWER, "material_rate_snapshot", "Material Rate (Snapshot)",
                    type="number", field_type="number", group_name="rate_card_snapshots",
                    description="Catalog material_rate value at line creation.")

    ensure_property(INSPECTION_ANSWER, "material_qty_snapshot", "Material Qty (Snapshot)",
                    type="number", field_type="number", group_name="rate_card_snapshots",
                    description="Catalog material_qty value at line creation.")

    ensure_property(INSPECTION_ANSWER, "material_cost_snapshot", "Material Cost Base (Snapshot)",
                    type="number", field_type="number", group_name="rate_card_snapshots",
                    description="Catalog material_cost (pre-adjustment) at line creation.")

    ensure_property(INSPECTION_ANSWER, "material_cost_adjustment_snapshot", "Material Cost Adjustment (Snapshot)",
                    type="number", field_type="number", group_name="rate_card_snapshots",
                    description="Region matrix material_cost_adjustment at line creation.")

    ensure_property(INSPECTION_ANSWER, "material_tax_adjustment_snapshot", "Material Tax Adjustment (Snapshot)",
                    type="number", field_type="number", group_name="rate_card_snapshots",
                    description="Region matrix material_tax_adjustment at line creation.")

    ensure_property(INSPECTION_ANSWER, "is_labor_only_snapshot", "Is Labor Only (Snapshot)",
                    type="enumeration", field_type="booleancheckbox", group_name="rate_card_snapshots",
                    description="Catalog is_labor_only flag at line creation.",
                    options=[
                        {"label": "Yes", "value": "true", "displayOrder": 0},
                        {"label": "No", "value": "false", "displayOrder": 1},
                    ])

    ensure_property(INSPECTION_ANSWER, "is_bid_item_snapshot", "Is Bid Item (Snapshot)",
                    type="enumeration", field_type="booleancheckbox", group_name="rate_card_snapshots",
                    description="Catalog is_bid_item flag at line creation.",
                    options=[
                        {"label": "Yes", "value": "true", "displayOrder": 0},
                        {"label": "No", "value": "false", "displayOrder": 1},
                    ])

    ensure_property(INSPECTION_ANSWER, "is_custom_priced", "Is Custom Priced",
                    type="enumeration", field_type="booleancheckbox", group_name="rate_card_line",
                    description="True if inspector overrode catalog price (e.g., for a bid item or custom adjustment).",
                    options=[
                        {"label": "Yes", "value": "true", "displayOrder": 0},
                        {"label": "No", "value": "false", "displayOrder": 1},
                    ])

    ensure_property(INSPECTION_ANSWER, "quantity_decimal", "Quantity (Decimal)",
                    type="number", field_type="number", group_name="rate_card_line",
                    description="Quantity entered by inspector. Decimals supported (e.g., 1.5 hours, 1325 SF).")

    ensure_property(INSPECTION_ANSWER, "tenant_bill_back_percent", "Tenant Bill-Back %",
                    type="enumeration", field_type="select", group_name="rate_card_line",
                    description="Percentage of client cost charged back to the tenant.",
                    options=_tenant_pct_options())

    print("\nRate card line totals on inspection_answer:")
    ensure_property(INSPECTION_ANSWER, "labor_total", "Labor Total",
                    type="number", field_type="number", group_name="rate_card_totals",
                    description="Computed: labor_hours * labor_hourly_rate * quantity.")

    ensure_property(INSPECTION_ANSWER, "material_total", "Material Total",
                    type="number", field_type="number", group_name="rate_card_totals",
                    description="Computed: 0 if labor_only, else material_rate * MAX(1, material_qty * qty) * adjusted_material_cost.")

    ensure_property(INSPECTION_ANSWER, "vendor_cost", "Vendor Cost",
                    type="number", field_type="number", group_name="rate_card_totals",
                    description="labor_total + material_total. What ResiHome pays the vendor.")

    ensure_property(INSPECTION_ANSWER, "client_cost", "Client Cost",
                    type="number", field_type="number", group_name="rate_card_totals",
                    description="vendor_cost * 1.20. What is charged to the client (with 20% markup).")

    ensure_property(INSPECTION_ANSWER, "tenant_cost", "Tenant Cost",
                    type="number", field_type="number", group_name="rate_card_totals",
                    description="client_cost * (tenant_bill_back_percent / 100). What is charged back to the tenant.")

    # Picklist addition: rate_card_line on answer_type
    print("\nPicklist additions on inspection_answer:")
    ensure_picklist_value(INSPECTION_ANSWER, "answer_type", "rate_card_line", "Rate Card Line")

    # ----- Inspection extensions -----------------------------------------
    print("\nProperty groups on inspection:")
    ensure_property_group(INSPECTION, "rate_card_aggregates", "Rate Card Aggregates")
    ensure_property_group(INSPECTION, "rate_card_pdfs", "Rate Card PDFs")

    print("\nRate card aggregates on inspection:")
    ensure_property(INSPECTION, "total_line_items", "Total Line Items",
                    type="number", field_type="number", group_name="rate_card_aggregates",
                    description="Count of rate card lines on this inspection.")

    ensure_property(INSPECTION, "total_vendor_cost", "Total Vendor Cost",
                    type="number", field_type="number", group_name="rate_card_aggregates",
                    description="Sum of vendor_cost across all lines on this inspection.")

    ensure_property(INSPECTION, "total_client_cost", "Total Client Cost",
                    type="number", field_type="number", group_name="rate_card_aggregates",
                    description="Sum of client_cost across all lines.")

    ensure_property(INSPECTION, "total_tenant_cost", "Total Tenant Cost",
                    type="number", field_type="number", group_name="rate_card_aggregates",
                    description="Sum of tenant_cost across all lines.")

    ensure_property(INSPECTION, "total_line_quantity", "Total Line Quantity",
                    type="number", field_type="number", group_name="rate_card_aggregates",
                    description="Sum of quantity across all lines (useful for sanity checks).")

    print("\nRate card PDFs on inspection:")
    ensure_property(INSPECTION, "tenant_chargeback_pdf_url", "Tenant Chargeback PDF URL",
                    type="string", field_type="text", group_name="rate_card_pdfs",
                    description="URL to the tenant chargeback PDF (only lines with tenant_bill_back > 0%).")

    ensure_property(INSPECTION, "vendor_pdfs_json", "Vendor PDFs (JSON)",
                    type="string", field_type="textarea", group_name="rate_card_pdfs",
                    description="JSON object mapping vendor name -> PDF URL. One PDF per assigned vendor.")

    ensure_property(INSPECTION, "pdf_bundle_zip_url", "PDF Bundle ZIP URL",
                    type="string", field_type="text", group_name="rate_card_pdfs",
                    description="URL to a ZIP file containing all PDFs (master, tenant, vendor-specific). Used for email attachment.")

    print("\nRegion snapshot on inspection:")
    ensure_property(INSPECTION, "region_snapshot", "Region (Snapshot)",
                    type="string", field_type="text", group_name="rate_card_aggregates",
                    description="Snapshot of the property's region at inspection start. Used for all line rate lookups.")

    # Picklist additions to existing inspection properties
    print("\nPicklist additions on inspection:")
    ensure_picklist_value(INSPECTION, "template_type", "pm_scope_rate_card", "(PM) Scope Rate Card")
    ensure_picklist_value(INSPECTION, "status", "pending_approval", "Pending Approval")

    print("\n[done] Step 3 complete.")


def _tenant_pct_options() -> list[dict]:
    """0%, 5%, 10%, ..., 95%, 100% (21 options). Stored as integer string values."""
    opts = []
    for i, pct in enumerate(range(0, 101, 5)):
        opts.append({
            "label": f"{pct}%",
            "value": str(pct),
            "displayOrder": i,
        })
    return opts


if __name__ == "__main__":
    main()
