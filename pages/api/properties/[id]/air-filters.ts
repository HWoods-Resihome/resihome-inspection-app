import type { NextApiRequest, NextApiResponse } from 'next';
import { updateProperty } from '@/lib/hubspot';
import { getSessionFromRequest } from '@/lib/auth';

/**
 * Write the Final Checklist's confirmed air-filter quantity/types back onto the
 * Property object in HubSpot. Whitelisted to the air-filter fields only — this
 * surface can't write any other property.
 *
 * Body: { totalQuantity?: number, types?: (string|null)[] }  // types index 0..2 → __1/__2/__3
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const { id } = req.query;
  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'Missing property id' });
  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body || {};
    const props: Record<string, any> = {};

    if (body.totalQuantity != null && body.totalQuantity !== '') {
      const n = Number(body.totalQuantity);
      if (Number.isFinite(n)) props['air_filters___total_quantity'] = n;
    }
    const types = Array.isArray(body.types) ? body.types : [];
    for (let i = 0; i < 3; i++) {
      // undefined → leave untouched; null/'' → clear; value → set.
      if (types[i] !== undefined) {
        props[`air_filters___type__${i + 1}`] = types[i] == null ? '' : String(types[i]);
      }
    }

    if (Object.keys(props).length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }
    await updateProperty(id, props);
    return res.status(200).json({ success: true });
  } catch (e: any) {
    console.error(`PATCH /api/properties/${id}/air-filters failed:`, e);
    return res.status(500).json({ error: 'Could not write air-filter values to the property.' });
  }
}
