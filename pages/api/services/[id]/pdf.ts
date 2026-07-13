/**
 * GET /api/services/[id]/pdf — render a Service Work Order completion PDF inline.
 * Available once the service has been submitted. Services-gated. Photos are
 * fetched + downscaled to data URIs so react-pdf renders them reliably server-side.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isInternalEmail } from '@/lib/userAccess';
import { renderServicePdfBuffer } from '@/lib/servicePdfRender';

export const config = { maxDuration: 60 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  const ok = await servicesEnabled(session?.email).catch(() => false);
  if (!ok) return res.status(403).json({ error: 'Not available' });
  const id = String(req.query.id || '');
  if (!/^\d+$/.test(id)) return res.status(404).json({ error: 'PDF is available for live services only.' });

  // Vendor copy (shows Vendor Cost) is available to everyone; the Client copy
  // (shows Client Cost) is internal-only — vendors never see client pricing.
  const internal = isInternalEmail(session?.email);
  const variant: 'vendor' | 'client' = req.query.variant === 'client' && internal ? 'client' : 'vendor';
  const baseUrl = `${(req.headers['x-forwarded-proto'] as string) || 'https'}://${req.headers.host || ''}`;

  try {
    const buffer = await renderServicePdfBuffer(id, { variant, baseUrl, internal });
    if (!buffer) return res.status(404).json({ error: 'Service not found.' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="service-${id}-${variant}.pdf"`);
    // Rendered fresh from the live record every request — never cache, so a PDF
    // opened before a logic/format change is always superseded on the next open.
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).send(buffer);
  } catch (e: any) {
    console.error('GET /api/services/[id]/pdf failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
