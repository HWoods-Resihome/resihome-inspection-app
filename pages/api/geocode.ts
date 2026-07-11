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
import { fetchPropertyCoords, fetchPropertyAddress } from '@/lib/hubspot';

type Coords = { lat: number; lng: number; source: string };

// cache key (propertyId + address) -> coords | null (null = a confirmed miss)
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
  const propertyId = String(req.query.propertyId || '').trim();
  if (address.length < 5 && !propertyId) {
    return res.status(400).json({ error: 'address or propertyId is required' });
  }

  const cacheKey = `${propertyId}|${address}`;
  if (cache.has(cacheKey)) {
    const hit = cache.get(cacheKey);
    return hit
      ? res.status(200).json(hit)
      : res.status(404).json({ error: 'No geocode match' });
  }

  const geocodeText = async (text: string): Promise<Coords | null> => {
    let c: Coords | null = null;
    try { c = await geocodeCensus(text); } catch { /* try next */ }
    if (!c) { try { c = await geocodeNominatim(text); } catch { /* give up */ } }
    return c;
  };

  let coords: Coords | null = null;
  // 1) Prefer the property's stored coordinates (most reliable when filled in).
  if (propertyId) {
    try {
      const p = await fetchPropertyCoords(propertyId);
      if (p) coords = { lat: p.lat, lng: p.lng, source: 'property' };
    } catch { /* fall back below */ }
  }
  // 2) Geocode the associated property's OWN street address. This is what places
  //    community inspections, whose `address` is a community name, not a street.
  if (!coords && propertyId) {
    try {
      const pa = await fetchPropertyAddress(propertyId);
      if (pa) coords = await geocodeText(pa);
    } catch { /* fall back to the passed address */ }
  }
  // 3) Fall back to geocoding the passed address text.
  if (!coords && address.length >= 5) coords = await geocodeText(address);

  cache.set(cacheKey, coords);
  return coords
    ? res.status(200).json(coords)
    : res.status(404).json({ error: 'No geocode match' });
}
