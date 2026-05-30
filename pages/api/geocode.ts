/**
 * GET /api/geocode?address=...  ->  { lat, lng, source } | { error }
 *
 * Resolves a property address to reference coordinates so the in-app camera can
 * validate the device's GPS fix against the property location (a ✓/✗ stamped on
 * each photo). US-focused: tries the free US Census geocoder first (no API key,
 * government service), then falls back to OpenStreetMap Nominatim.
 *
 * Results (including misses) are cached in-process to avoid re-geocoding the
 * same address on every camera open. Behind the session middleware.
 */
import type { NextApiRequest, NextApiResponse } from 'next';

type Coords = { lat: number; lng: number; source: string };

// address -> coords | null (null = a confirmed miss, so we don't keep retrying)
const cache = new Map<string, Coords | null>();

async function fetchWithTimeout(url: string, ms: number, headers?: Record<string, string>) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal, headers });
  } finally {
    clearTimeout(t);
  }
}

async function geocodeCensus(address: string): Promise<Coords | null> {
  const url =
    'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress' +
    `?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&format=json`;
  const r = await fetchWithTimeout(url, 6000);
  if (!r.ok) return null;
  const d = await r.json();
  const m = d?.result?.addressMatches?.[0];
  const lng = Number(m?.coordinates?.x);
  const lat = Number(m?.coordinates?.y);
  if (isFinite(lat) && isFinite(lng)) return { lat, lng, source: 'census' };
  return null;
}

async function geocodeNominatim(address: string): Promise<Coords | null> {
  const url =
    'https://nominatim.openstreetmap.org/search' +
    `?format=jsonv2&limit=1&q=${encodeURIComponent(address)}`;
  const r = await fetchWithTimeout(url, 6000, {
    'User-Agent': 'ResiHome-Inspection-App/1.0 (property inspections)',
    Accept: 'application/json',
  });
  if (!r.ok) return null;
  const d = await r.json();
  const first = Array.isArray(d) ? d[0] : null;
  const lat = Number(first?.lat);
  const lng = Number(first?.lon);
  if (isFinite(lat) && isFinite(lng)) return { lat, lng, source: 'nominatim' };
  return null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const address = String(req.query.address || '').trim();
  if (address.length < 5) return res.status(400).json({ error: 'address is required' });

  if (cache.has(address)) {
    const hit = cache.get(address);
    return hit
      ? res.status(200).json(hit)
      : res.status(404).json({ error: 'No geocode match' });
  }

  let coords: Coords | null = null;
  try { coords = await geocodeCensus(address); } catch { /* try fallback */ }
  if (!coords) {
    try { coords = await geocodeNominatim(address); } catch { /* give up */ }
  }

  cache.set(address, coords);
  return coords
    ? res.status(200).json(coords)
    : res.status(404).json({ error: 'No geocode match' });
}
