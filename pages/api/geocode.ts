/**
 * GET /api/geocode?address=...&propertyId=...  ->  { lat, lng, source } | { error }
 *
 * Resolves an address (and/or a HubSpot Property/Community id) to reference
 * coordinates so the in-app camera can validate the device's GPS fix and the
 * calendar/services maps can plot a pin. The resolution logic lives in
 * lib/geocodeResolve (shared with the create-time coordinate stamping) so the
 * live endpoint and the stamped values always agree. Behind session middleware.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { resolveCoords } from '@/lib/geocodeResolve';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const address = String(req.query.address || '').trim();
  const propertyId = String(req.query.propertyId || '').trim();
  if (address.length < 5 && !propertyId) {
    return res.status(400).json({ error: 'address or propertyId is required' });
  }
  const coords = await resolveCoords({ address, propertyId });
  return coords
    ? res.status(200).json(coords)
    : res.status(404).json({ error: 'No geocode match' });
}
