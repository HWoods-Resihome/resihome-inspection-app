// Email composition for finalized Rate Card inspections.
//
// Pure data assembly — no I/O, no Gmail API calls. Returns a payload that
// downstream code (gmail.ts) can send. Keeping this separate makes it easy
// to test the subject/body design without OAuth wiring, and lets us preview
// the payload in the finalize response even when Gmail isn't connected yet.

import type { PdfBuildContext } from './pdfShared';

/** Recipients + content for the inspection-completed notification. */
export interface InspectionEmailPayload {
  to: string[];
  cc: string[];
  subject: string;
  htmlBody: string;
  textBody: string;
  /** Files to attach as base64 MIME parts when the email is actually sent.
   *  Each entry references a HubSpot Files URL — the sender is responsible
   *  for fetching the bytes and encoding them. */
  attachments: Array<{ filename: string; url: string; mimeType: string }>;
}

/** Address & state info pulled off the property record + inspection. */
export interface PropertyContact {
  addressStreet: string;
  city: string;
  stateCode: string;
  zipCode: string;
}

/** URLs the user might want to follow from the email. */
export interface InspectionLinks {
  /** App-side URL, e.g. https://inspections.resihome.com/inspection/{recordId} */
  appUrl: string;
  /** HubSpot record URL, e.g. https://app.hubspot.com/contacts/{portalId}/record/{typeId}/{recordId} */
  hubspotUrl: string;
}

/** Per-vendor cost breakdown for the email body. */
interface VendorTotal {
  vendor: string;
  vendorCost: number;
  lineCount: number;
}

/** Files to attach. PDF/xlsx URLs come from the finalize endpoint output. */
export interface InspectionAttachments {
  masterPdf: { name: string; url: string } | null;
  chargebackPdf: { name: string; url: string } | null;
  chargebackXlsx: { name: string; url: string } | null;
  vendorPdfs: Array<{ vendor: string; name: string; url: string }>;
}

// ----- Recipient helpers -----

/** The fixed "soda" mailbox — receives every inspection finalize email. */
const SODA_EMAIL = 'soda@resihome.com';

/**
 * Build the regional team mailbox from a 2-letter state code, e.g.
 * "GA" -> "teamGA@resihome.com". Returns null when state is missing so
 * the caller knows to fall back to soda-only.
 */
export function buildTeamEmail(stateCode: string | null | undefined): string | null {
  const code = (stateCode || '').trim().toUpperCase();
  if (!code || code.length !== 2 || !/^[A-Z]{2}$/.test(code)) return null;
  return `team${code}@resihome.com`;
}

// ----- Subject helpers -----

/** Format money the way the subject line wants it: "$2,818.13" */
function fmtMoney(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Build the subject line per Hayden's spec:
 *   "Tenant Damages: $[Client Total] - [street], [city], [ST] [zip]"
 * E.g. "Tenant Damages: $2,818.13 - 5503 Thomas Dr, Douglasville, GA 30135"
 *
 * Falls back gracefully when address parts are missing.
 */
export function buildSubject(clientTotal: number, prop: PropertyContact): string {
  const addressParts: string[] = [];
  if (prop.addressStreet) addressParts.push(prop.addressStreet);
  // "City, ST Zip" — second clause is its own segment
  const cityStateZip: string[] = [];
  if (prop.city) cityStateZip.push(prop.city);
  if (prop.stateCode) cityStateZip.push(prop.stateCode);
  // zip joins onto the state without a comma: "GA 30135"
  const tail = cityStateZip.join(', ') + (prop.zipCode ? ` ${prop.zipCode}` : '');
  if (tail.trim()) addressParts.push(tail.trim());
  const addr = addressParts.join(', ');
  return `Tenant Damages: ${fmtMoney(clientTotal)}${addr ? ` - ${addr}` : ''}`;
}

// ----- Body helpers -----

/**
 * Sum up vendor costs grouped by `assigned_to` vendor. The set of vendors here
 * matches the set used for per-vendor PDFs in finalize.ts. Sorted by vendor
 * cost descending so the biggest spend lands at the top — easier to scan.
 */
export function buildVendorBreakdown(ctx: PdfBuildContext): VendorTotal[] {
  const totals = new Map<string, { vendorCost: number; lineCount: number }>();
  for (const section of ctx.sections) {
    for (const line of section.lines) {
      const v = line.vendor || 'Unassigned';
      const t = totals.get(v) || { vendorCost: 0, lineCount: 0 };
      t.vendorCost += line.vendorCost;
      t.lineCount += 1;
      totals.set(v, t);
    }
  }
  return Array.from(totals.entries())
    .map(([vendor, t]) => ({ vendor, vendorCost: t.vendorCost, lineCount: t.lineCount }))
    .sort((a, b) => b.vendorCost - a.vendorCost);
}

/**
 * HTML email body. Uses simple table-based markup with inline styles for
 * maximum email-client compatibility (Gmail, Outlook, Apple Mail). No
 * external CSS, no <style> blocks (Outlook strips them).
 *
 * Brand colors hardcoded inline rather than imported from pdfShared (which
 * uses React-PDF types).
 */
function buildHtmlBody(args: {
  prop: PropertyContact;
  ctx: PdfBuildContext;
  vendorBreakdown: VendorTotal[];
  links: InspectionLinks;
  files: Array<{ filename: string; url: string }>;
  tenantImport?: TenantImportStatus | null;
}): string {
  const { prop, ctx, vendorBreakdown, links, files, tenantImport } = args;
  // Tenant Charge Import (SFTP) status badge. Only rendered when we actually
  // tried to push the xlsx (tenantImport present) AND the SFTP is configured —
  // when unconfigured we stay silent rather than show a scary "Unsuccessful".
  const tenantImportHtml = tenantImport && tenantImport.configured
    ? `<!-- Tenant Charge Import (SFTP) -->
        <tr>
          <td style="padding:16px 24px 0 24px;">
            <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;font-weight:bold;">Tenant Charge Import</div>
            ${tenantImport.ok
              ? `<div style="font-size:14px;font-weight:bold;color:#047857;">✅ Tenant charge import successful</div>`
              : `<div style="font-size:14px;font-weight:bold;color:#b91c1c;">❌ Tenant charge import unsuccessful</div>${tenantImport.error ? `<div style="font-size:11px;color:#9ca3af;margin-top:4px;">${escapeHtml(tenantImport.error)}</div>` : ''}`}
          </td>
        </tr>`
    : '';
  const addressLine = [
    prop.addressStreet,
    [prop.city, prop.stateCode].filter(Boolean).join(', ') + (prop.zipCode ? ` ${prop.zipCode}` : ''),
  ].filter((s) => s.trim()).join(', ');

  // Pink #ff0060 brand, teal #73e3df accent
  const vendorRows = vendorBreakdown.map((v, i) => `
    <tr>
      <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;${i === 0 ? 'border-top:1px solid #e5e7eb;' : ''}">${escapeHtml(v.vendor)}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;${i === 0 ? 'border-top:1px solid #e5e7eb;' : ''}text-align:center;color:#6b7280;font-size:13px;">${v.lineCount} item${v.lineCount === 1 ? '' : 's'}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;${i === 0 ? 'border-top:1px solid #e5e7eb;' : ''}text-align:right;font-weight:bold;">${fmtMoney(v.vendorCost)}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f9fafb;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f9fafb;padding:24px 0;">
    <tr><td align="center">
      <table cellpadding="0" cellspacing="0" border="0" width="600" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">

        <!-- Pink header bar -->
        <tr>
          <td style="background:#ff0060;padding:18px 24px;color:#ffffff;">
            <div style="font-size:18px;font-weight:bold;">Move Out Scope Completed</div>
            <div style="font-size:13px;opacity:0.9;margin-top:2px;">${escapeHtml(ctx.templateLabel)} &mdash; ${escapeHtml(addressLine)}</div>
          </td>
        </tr>

        <!-- Property meta -->
        <tr>
          <td style="padding:18px 24px 8px 24px;font-size:14px;color:#1a1a1a;">
            <table cellpadding="0" cellspacing="0" border="0" width="100%">
              <tr>
                <td style="padding:2px 0;width:130px;color:#6b7280;">Property</td>
                <td style="padding:2px 0;"><strong>${escapeHtml(addressLine)}</strong></td>
              </tr>
              <tr>
                <td style="padding:2px 0;color:#6b7280;">Inspector</td>
                <td style="padding:2px 0;">${escapeHtml(ctx.inspectorName)}</td>
              </tr>
              <tr>
                <td style="padding:2px 0;color:#6b7280;">Bed / Bath</td>
                <td style="padding:2px 0;">${ctx.bedrooms} bed / ${ctx.bathrooms} bath${ctx.squareFootage ? ` &middot; ${ctx.squareFootage.toLocaleString()} sqft` : ''}</td>
              </tr>
              ${ctx.region ? `<tr>
                <td style="padding:2px 0;color:#6b7280;">Region</td>
                <td style="padding:2px 0;">${escapeHtml(ctx.region)}</td>
              </tr>` : ''}
            </table>
          </td>
        </tr>

        <!-- Totals -->
        <tr>
          <td style="padding:8px 24px 8px 24px;">
            <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f9fafb;border-radius:6px;">
              <tr>
                <td style="padding:14px 12px;text-align:center;">
                  <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Scope Lines</div>
                  <div style="font-size:18px;font-weight:bold;margin-top:4px;">${ctx.grandTotals.lineCount}</div>
                </td>
                <td style="padding:14px 12px;text-align:center;border-left:1px solid #e5e7eb;">
                  <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Vendor</div>
                  <div style="font-size:18px;font-weight:bold;margin-top:4px;">${fmtMoney(ctx.grandTotals.vendor)}</div>
                </td>
                <td style="padding:14px 12px;text-align:center;border-left:1px solid #e5e7eb;">
                  <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Client</div>
                  <div style="font-size:20px;font-weight:bold;color:#ff0060;margin-top:4px;">${fmtMoney(ctx.grandTotals.client)}</div>
                </td>
                <td style="padding:14px 12px;text-align:center;border-left:1px solid #e5e7eb;">
                  <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Tenant</div>
                  <div style="font-size:18px;font-weight:bold;margin-top:4px;">${fmtMoney(ctx.grandTotals.tenant)}</div>
                </td>
                <td style="padding:14px 12px;text-align:center;border-left:1px solid #e5e7eb;">
                  <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Net Turn</div>
                  <div style="font-size:18px;font-weight:bold;color:#0f766e;margin-top:4px;">${fmtMoney(ctx.grandTotals.client - ctx.grandTotals.tenant)}</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Vendor breakdown -->
        <tr>
          <td style="padding:16px 24px 8px 24px;">
            <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;font-weight:bold;">Vendor Breakdown</div>
            <table cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:14px;">
              ${vendorRows}
              <tr>
                <td style="padding:8px 12px;font-weight:bold;background:#f9fafb;">Total Scope Items</td>
                <td style="padding:8px 12px;text-align:center;background:#f9fafb;font-weight:bold;">${ctx.grandTotals.lineCount} item${ctx.grandTotals.lineCount === 1 ? '' : 's'}</td>
                <td style="padding:8px 12px;text-align:right;font-weight:bold;background:#f9fafb;">${fmtMoney(ctx.grandTotals.vendor)}</td>
              </tr>
            </table>
          </td>
        </tr>

        ${files.length > 0 ? `<!-- Files (direct downloads) -->
        <tr>
          <td style="padding:16px 24px 0 24px;">
            <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;font-weight:bold;">Files</div>
            ${files.map((f) => `<div style="margin-bottom:6px;"><a href="${escapeAttr(f.url)}" style="color:#ff0060;text-decoration:underline;font-weight:bold;">${escapeHtml(f.filename)}</a></div>`).join('')}
            <div style="font-size:11px;color:#9ca3af;margin-top:4px;">Attached below where size allows — large files may be link-only, so download here if an attachment is missing.</div>
          </td>
        </tr>` : ''}

        ${tenantImportHtml}

        <!-- Links -->
        <tr>
          <td style="padding:16px 24px;">
            <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;font-weight:bold;">Links</div>
            <div style="margin-bottom:6px;">
              <a href="${escapeAttr(links.hubspotUrl)}" style="color:#ff0060;text-decoration:underline;font-weight:bold;">View Inspection in HubSpot</a>
            </div>
            <div>
              <a href="${escapeAttr(links.appUrl)}" style="color:#ff0060;text-decoration:underline;font-weight:bold;">View Inspection in App</a>
            </div>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:14px 24px;background:#f9fafb;text-align:center;font-size:11px;color:#6b7280;border-top:1px solid #e5e7eb;">
            Sent from the ResiHome Inspection App
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/** Plain-text fallback for clients that strip HTML. Same content, simpler. */
function buildTextBody(args: {
  prop: PropertyContact;
  ctx: PdfBuildContext;
  vendorBreakdown: VendorTotal[];
  links: InspectionLinks;
  files: Array<{ filename: string; url: string }>;
  tenantImport?: TenantImportStatus | null;
}): string {
  const { prop, ctx, vendorBreakdown, links, files, tenantImport } = args;
  const addressLine = [
    prop.addressStreet,
    [prop.city, prop.stateCode].filter(Boolean).join(', ') + (prop.zipCode ? ` ${prop.zipCode}` : ''),
  ].filter((s) => s.trim()).join(', ');
  const lines: string[] = [];
  lines.push('Move Out Scope Completed');
  lines.push(`${ctx.templateLabel} - ${addressLine}`);
  lines.push('');
  lines.push('Property: ' + addressLine);
  lines.push('Inspector: ' + ctx.inspectorName);
  lines.push(`Bed/Bath: ${ctx.bedrooms} / ${ctx.bathrooms}` + (ctx.squareFootage ? ` (${ctx.squareFootage.toLocaleString()} sqft)` : ''));
  if (ctx.region) lines.push('Region: ' + ctx.region);
  lines.push('');
  lines.push('TOTALS');
  lines.push('  Vendor Total: ' + fmtMoney(ctx.grandTotals.vendor));
  lines.push('  Client Total: ' + fmtMoney(ctx.grandTotals.client));
  lines.push('  Tenant Total: ' + fmtMoney(ctx.grandTotals.tenant));
  lines.push('  Net Turn Cost: ' + fmtMoney(ctx.grandTotals.client - ctx.grandTotals.tenant));
  lines.push('  Scope Items: ' + ctx.grandTotals.lineCount);
  lines.push('');
  lines.push('VENDOR BREAKDOWN');
  for (const v of vendorBreakdown) {
    lines.push(`  ${v.vendor}: ${fmtMoney(v.vendorCost)} (${v.lineCount} item${v.lineCount === 1 ? '' : 's'})`);
  }
  lines.push('');
  lines.push('LINKS');
  lines.push('  HubSpot: ' + links.hubspotUrl);
  lines.push('  App:     ' + links.appUrl);
  lines.push('');
  lines.push('FILES (attached where size allows; download links below)');
  if (files.length === 0) {
    lines.push('  (none)');
  } else {
    for (const f of files) { lines.push('  - ' + f.filename); lines.push('    ' + f.url); }
  }
  if (tenantImport && tenantImport.configured) {
    lines.push('');
    lines.push('TENANT CHARGE IMPORT');
    lines.push(tenantImport.ok
      ? '  Tenant charge import successful'
      : '  Tenant charge import unsuccessful' + (tenantImport.error ? ` (${tenantImport.error})` : ''));
  }
  lines.push('');
  lines.push('-- Sent from the ResiHome Inspection App');
  return lines.join('\n');
}

// HTML escaping (small, no external dep)
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}

// ----- Public composer -----

/**
 * Build the full email payload from inspection finalize context.
 *
 * Recipient resolution:
 *   to: soda@resihome.com (always)
 *   cc: team{STATE}@resihome.com (only if property has a 2-letter state code),
 *       plus the inspector's HubSpot email (when present) so they get a copy
 *       of the scope report they completed.
 *
 * State code missing is not an error — the email still goes out, just without
 * the regional team on copy.
 */
/** Status of pushing the Tenant Chargeback Import xlsx to the SFTP site. */
export interface TenantImportStatus {
  ok: boolean;
  /** false when the SFTP_* env vars aren't set (upload was skipped). */
  configured: boolean;
  remotePath?: string;
  error?: string;
}

export function composeInspectionEmail(args: {
  ctx: PdfBuildContext;
  prop: PropertyContact;
  links: InspectionLinks;
  attachments: InspectionAttachments;
  /** Inspector's email from the HubSpot inspection record. Added to CC when
   *  it's a valid address that isn't already a recipient. */
  inspectorEmail?: string | null;
  /** SFTP delivery status for the Tenant Chargeback Import xlsx, rendered as a
   *  line in the email body. Omit/null when there was no xlsx to send. */
  tenantImport?: TenantImportStatus | null;
}): InspectionEmailPayload {
  const { ctx, prop, links, attachments, inspectorEmail, tenantImport } = args;

  // Recipients
  const to = [SODA_EMAIL];
  const cc: string[] = [];
  const teamEmail = buildTeamEmail(prop.stateCode);
  if (teamEmail) cc.push(teamEmail);

  // CC the inspector (from HubSpot) so they receive a copy of their own
  // completed scope. Validate + dedupe (case-insensitive) against existing
  // recipients so we never double-send or add a malformed address.
  const inspector = (inspectorEmail || '').trim();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(inspector)) {
    const already = new Set([...to, ...cc].map((e) => e.toLowerCase()));
    if (!already.has(inspector.toLowerCase())) cc.push(inspector);
  }

  // Vendor breakdown
  const vendorBreakdown = buildVendorBreakdown(ctx);

  // Flatten attachments. Order: Master, Chargeback PDF, Chargeback xlsx,
  // then each vendor PDF in the order their vendors appear in
  // vendorBreakdown so file ordering mirrors the body.
  const attachmentList: InspectionEmailPayload['attachments'] = [];
  if (attachments.masterPdf) {
    attachmentList.push({
      filename: attachments.masterPdf.name,
      url: attachments.masterPdf.url,
      mimeType: 'application/pdf',
    });
  }
  if (attachments.chargebackPdf) {
    attachmentList.push({
      filename: attachments.chargebackPdf.name,
      url: attachments.chargebackPdf.url,
      mimeType: 'application/pdf',
    });
  }
  // Vendor PDFs in the order produced by vendorBreakdown so the listing in
  // the body matches the attachment order in mail clients.
  const vendorPdfMap = new Map(attachments.vendorPdfs.map((v) => [v.vendor, v]));
  for (const vb of vendorBreakdown) {
    const vp = vendorPdfMap.get(vb.vendor);
    if (vp) {
      attachmentList.push({ filename: vp.name, url: vp.url, mimeType: 'application/pdf' });
    }
  }
  // The Tenant Chargeback xlsx import file ALWAYS goes last, after every PDF.
  if (attachments.chargebackXlsx) {
    attachmentList.push({
      filename: attachments.chargebackXlsx.name,
      url: attachments.chargebackXlsx.url,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  }

  // Subject + body. Direct download links for every file go in the body so a
  // large attachment that gets skipped at send time (Gmail 25 MB cap) is still
  // one click away.
  const subject = buildSubject(ctx.grandTotals.client, prop);
  const files = attachmentList.map((a) => ({ filename: a.filename, url: a.url }));
  const htmlBody = buildHtmlBody({ prop, ctx, vendorBreakdown, links, files, tenantImport });
  const textBody = buildTextBody({ prop, ctx, vendorBreakdown, links, files, tenantImport });

  return { to, cc, subject, htmlBody, textBody, attachments: attachmentList };
}
