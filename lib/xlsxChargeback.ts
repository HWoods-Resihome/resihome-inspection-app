// Tenant Chargeback xlsx generator.
//
// Produces an Excel file matching the format of `Import__2605_Calais_Ct.xlsx`
// — used as the bulk import file for tenant chargebacks in [downstream system].
//
// Sheet name and column order MUST match the template EXACTLY. The downstream
// importer is column-name sensitive (and possibly column-position sensitive).
//
// One row per Tenant Chargeback line (lines where tenant_bill_back_percent > 0
// AND tenantCost > 0). All other columns are constant or pulled from the
// inspection's property record.

import ExcelJS from 'exceljs';
import type { PdfBuildContext, PdfLineRow } from './pdfShared';

// Hardcoded values per Hayden — these are constants for ResiHome's chargeback
// import. Change here if the GL account ever changes.
const GL_ACCOUNT_NUMBER = '4016';
const GL_ACCOUNT_DESCRIPTION = '4016: Move Out Charges - Individual Owners';
const CHARGE_TYPE = 'Charge';
const SHEET_NAME = 'TempExportSheet';

// Column order MUST match the import template exactly (15 columns).
const HEADERS = [
  'Entity ID',
  'Primary Tenant First and Last Name',
  'Property Address',
  'City',
  'State',
  'Zip Code',
  'Type',
  'Due Date',
  'Amount',
  'GL Account Number',
  'GL Account Description',
  'Description',
  'HBPM User',
  'Tenant Note',
  'Tenant Note Type',
];

/** Property-level facts pulled from HubSpot and threaded through the build
 *  context just for the xlsx generator. */
export interface TenantChargebackXlsxInput {
  entityId: string;
  primaryTenantName: string;
  /** Street-only address — example file shows "2605 Calais Ct" with no
   *  city/state appended. */
  addressStreet: string;
  city: string;
  /** 2-letter state code. Left blank if the property doesn't have one. */
  stateCode: string;
  zipCode: string;
  /** Used for the Due Date column. Defaults to today; passing a fixed value
   *  here makes the file reproducible across regenerations. */
  dueDate: Date;
}

/**
 * Build the description string per Hayden's spec:
 *   "Move-Out Charges: {ROOM} - {CATEGORY} - {Short Labor Desc} - Tenant Charged {%}%"
 *
 * Matches the example file's pattern (which also had a double-space after the
 * room name — preserved here for byte-level compatibility with the importer).
 */
function buildDescription(line: PdfLineRow): string {
  const room = line.section || '';
  const category = line.category || '';
  const shortDesc = line.laborShortDescription || '';
  const pct = Math.round(line.tenantBillBackPercent || 0);
  return `Move-Out Charges: ${room}  - ${category} - ${shortDesc} - Tenant Charged ${pct}%`;
}

/**
 * Generate the chargeback xlsx as a Node Buffer. Returns null when there are
 * no chargeback lines (consistent with the PDF chargeback's null-return).
 */
export async function renderChargebackXlsx(
  ctx: PdfBuildContext,
  input: TenantChargebackXlsxInput
): Promise<Buffer | null> {
  // Flatten and filter to chargeback-eligible lines (tenant % > 0 AND $ > 0)
  const lines: PdfLineRow[] = [];
  for (const section of ctx.sections) {
    for (const line of section.lines) {
      if (line.tenantBillBackPercent > 0 && line.tenantCost > 0) {
        lines.push(line);
      }
    }
  }
  if (lines.length === 0) return null;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'ResiHome Inspection App';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet(SHEET_NAME);

  // Header row
  sheet.addRow(HEADERS);

  // Set column widths so the file is human-readable when opened
  // (purely cosmetic; the importer doesn't care about widths).
  sheet.columns = [
    { width: 14 },  // Entity ID
    { width: 30 },  // Primary Tenant
    { width: 24 },  // Property Address
    { width: 14 },  // City
    { width: 8 },   // State
    { width: 10 },  // Zip Code
    { width: 10 },  // Type
    { width: 12 },  // Due Date
    { width: 12 },  // Amount
    { width: 10 },  // GL #
    { width: 38 },  // GL Description
    { width: 80 },  // Description
    { width: 14 },  // HBPM User
    { width: 20 },  // Tenant Note
    { width: 16 },  // Tenant Note Type
  ];

  // Data rows
  for (const line of lines) {
    sheet.addRow([
      input.entityId,
      input.primaryTenantName,
      input.addressStreet,
      input.city,
      input.stateCode,
      // Zip Code is a NUMBER in the template example (35085, not "35085").
      // Convert if it parses cleanly; else leave the raw string so leading
      // zeros aren't dropped on east-coast zips like "07030".
      /^\d+$/.test(input.zipCode) && input.zipCode.length === 5
        ? Number(input.zipCode)
        : input.zipCode,
      CHARGE_TYPE,
      input.dueDate,
      // Round to 2 decimals — money column. Importer expects a number.
      Math.round(line.tenantCost * 100) / 100,
      Number(GL_ACCOUNT_NUMBER),
      GL_ACCOUNT_DESCRIPTION,
      buildDescription(line),
      null, // HBPM User
      null, // Tenant Note
      null, // Tenant Note Type
    ]);
  }

  // Date column format: M/D/YYYY per Hayden's spec
  sheet.getColumn(8).numFmt = 'm/d/yyyy';
  // Amount column: number with 2 decimals
  sheet.getColumn(9).numFmt = '0.00';

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
