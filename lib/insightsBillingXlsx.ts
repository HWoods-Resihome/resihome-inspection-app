/**
 * Build a billing-report .xlsx (real Excel, via exceljs) from billing rows.
 * Header row bold + frozen; money columns formatted; auto-ish widths. Returns
 * the file as a Buffer for download or email attachment.
 */
import ExcelJS from 'exceljs';
import { rowToCells, billingColumns, type BillingRow } from '@/lib/insightsBilling';

export async function buildBillingXlsx(object: 'inspections' | 'services', rows: BillingRow[], sheetName = 'Billing'): Promise<Buffer> {
  const headers = billingColumns(object) as readonly string[];
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  const sheet = wb.addWorksheet(sheetName.slice(0, 31));
  sheet.addRow(headers as string[]);
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of rows) sheet.addRow(rowToCells(r));
  // Money format on the "… Amount" columns (1-indexed), wherever they sit.
  headers.forEach((h, i) => { if (/amount/i.test(String(h))) sheet.getColumn(i + 1).numFmt = '"$"#,##0.00'; });
  // Reasonable widths from header + sampled cell lengths.
  headers.forEach((h, i) => {
    const col = sheet.getColumn(i + 1);
    let w = String(h).length;
    rows.slice(0, 200).forEach((r) => { const v = rowToCells(r)[i]; w = Math.max(w, String(v ?? '').length); });
    col.width = Math.min(48, Math.max(10, w + 2));
  });
  const ab = await wb.xlsx.writeBuffer();
  return Buffer.from(ab);
}

/** A filename like "inspection-billing-2026-07-20.xlsx". */
export function billingFilename(object: 'inspections' | 'services', day = new Date().toISOString().slice(0, 10)): string {
  return `${object === 'services' ? 'service' : 'inspection'}-billing-${day}.xlsx`;
}
