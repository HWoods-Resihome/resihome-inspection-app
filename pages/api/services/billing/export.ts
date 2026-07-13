/**
 * GET /api/services/billing/export?format=csv|xlsx&from=YYYY-MM-DD&to=YYYY-MM-DD
 * Internal-only. Streams the billable completed lines (see lib/services/billing)
 * for the pay period as a CSV or Excel workbook, grouped by vendor with subtotals.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isInternalEmail } from '@/lib/userAccess';
import { buildBillingReport, BILLING_COLUMNS, billingLineToRow } from '@/lib/services/billing';

const csvCell = (v: string | number): string => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  const ok = (await servicesEnabled(email).catch(() => false)) && isInternalEmail(email);
  if (!ok) return res.status(403).json({ error: 'Internal only' });

  const format = String(req.query.format || 'csv').toLowerCase() === 'xlsx' ? 'xlsx' : 'csv';
  const from = String(req.query.from || '').slice(0, 10);
  const to = String(req.query.to || '').slice(0, 10);

  const report = await buildBillingReport(from, to).catch(() => null);
  if (!report) return res.status(503).json({ error: 'Services billing is not configured yet.' });

  const period = `${from || 'all'}_to_${to || 'all'}`;
  const fname = `resiwalk-billing_${period}`;

  if (format === 'csv') {
    const lines: string[] = [];
    lines.push(BILLING_COLUMNS.map(csvCell).join(','));
    for (const g of report.groups) {
      for (const l of g.lines) lines.push(billingLineToRow(l).map(csvCell).join(','));
      lines.push([`${g.vendor} — Subtotal`, '', '', '', '', '', '', '', g.vendorTotal, g.clientTotal, '', ''].map(csvCell).join(','));
    }
    lines.push(['GRAND TOTAL', '', '', '', '', '', '', '', report.vendorTotal, report.clientTotal, '', ''].map(csvCell).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}.csv"`);
    return res.status(200).send('﻿' + lines.join('\r\n'));
  }

  // xlsx — one sheet, vendor groups with a bold subtotal row and a grand total.
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ResiWalk - Services';
  const sheet = wb.addWorksheet('Billing');
  sheet.addRow([...BILLING_COLUMNS]);
  sheet.getRow(1).font = { bold: true };
  const moneyCols = [9, 10];   // Vendor Cost, Client Cost (1-indexed)
  for (const g of report.groups) {
    for (const l of g.lines) sheet.addRow(billingLineToRow(l));
    const sub = sheet.addRow([`${g.vendor} — Subtotal`, '', '', '', '', '', '', '', g.vendorTotal, g.clientTotal, '', '']);
    sub.font = { bold: true };
    sub.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F3F3' } }; });
  }
  const grand = sheet.addRow(['GRAND TOTAL', '', '', '', '', '', '', '', report.vendorTotal, report.clientTotal, '', '']);
  grand.font = { bold: true };
  grand.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE1EC' } }; });
  sheet.columns.forEach((col, i) => { col.width = [12, 22, 14, 16, 10, 20, 26, 22, 12, 12, 10, 12][i] || 14; });
  for (const c of moneyCols) sheet.getColumn(c).numFmt = '#,##0.00';

  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}.xlsx"`);
  return res.status(200).send(buf);
}
