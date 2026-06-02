/**
 * POST /api/inspections/[id]/send-xlsx-sftp
 *
 * Admin test button: re-push the Tenant Chargeback Import xlsx for a COMPLETED
 * Scope Rate Card inspection to the SFTP site, so we can validate the SFTP
 * pipeline end-to-end without re-finalizing.
 *
 * Reads the already-generated xlsx from `pdf_chargeback_xlsx_url` (the exact
 * file that was emailed at finalize), downloads it, and uploads it via
 * lib/sftp. Returns the SftpUploadResult so the UI can show success/failure.
 *
 * Gated to hwoods@resihome.com ONLY (this is a temporary validation tool).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { fetchInspectionWithPropertyRef } from '@/lib/hubspot';
import { uploadToSftp, probeSftp } from '@/lib/sftp';

const ADMIN_EMAIL = 'hwoods@resihome.com';

export const config = { maxDuration: 60 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if ((session.email || '').toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Admin only.' });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id } = req.query;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Missing inspection id' });
  }

  // Diagnostic mode: POST ...?probe=1 — connect read-only and report the
  // working directory + folder listings so we can find the correct remote path
  // (no file is uploaded). Use this to fix "Not Found" path errors.
  if (req.query.probe) {
    const probe = await probeSftp();
    return res.status(probe.ok ? 200 : (probe.configured ? 502 : 503)).json(probe);
  }

  try {
    const data = await fetchInspectionWithPropertyRef(id);
    if (!data) return res.status(404).json({ error: 'Inspection not found' });

    const insp = data.inspection;
    const xlsxUrl = insp.pdfChargebackXlsxUrl;
    if (!xlsxUrl) {
      return res.status(400).json({
        error: 'No Tenant Chargeback Import xlsx on this inspection (none was generated — no chargeback lines, or it predates this feature). Re-finalize to generate one.',
      });
    }

    // Download the exact xlsx that was generated/emailed at finalize.
    const fileResp = await fetch(xlsxUrl);
    if (!fileResp.ok) {
      return res.status(502).json({ error: `Could not download xlsx from HubSpot (HTTP ${fileResp.status}).` });
    }
    const buffer = Buffer.from(await fileResp.arrayBuffer());

    // Rebuild the descriptive filename (mirrors finalize.ts): address + date.
    const rawAddress = (data.propertyAddressStreet || insp.propertyAddressSnapshot || 'property');
    const safeAddress = rawAddress
      .replace(/[^a-zA-Z0-9_\-\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 90);
    const d = new Date();
    const datePart = `${d.getMonth() + 1}-${d.getDate()}-${String(d.getFullYear()).slice(2)}`;
    const filename = `Tenant Chargeback Import - ${safeAddress} - ${datePart}.xlsx`;

    const result = await uploadToSftp(filename, buffer);

    if (!result.configured) {
      return res.status(503).json({
        ok: false,
        error: 'SFTP is not configured. Set SFTP_HOST, SFTP_USERNAME, SFTP_PASSWORD (and optionally SFTP_PORT, SFTP_REMOTE_DIR) in the environment.',
      });
    }
    if (!result.ok) {
      return res.status(502).json({ ok: false, error: result.error || 'SFTP upload failed.', filename });
    }
    return res.status(200).json({ ok: true, remotePath: result.remotePath, filename });
  } catch (e: any) {
    console.error(`[send-xlsx-sftp] inspection ${id} failed:`, e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
