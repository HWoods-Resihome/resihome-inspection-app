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
import { fetchPropertyCoords, fetchPropertyAddress, fetchCommunityFirstPropertyId } from '@/lib/hubspot';

type Coords = { lat: number; lng: number; source: string };

// cache key (propertyId + address) -> coords | null (null = a confirmed miss)
const cache = new Map<string, Coords | null>();

// Rough per-state bounding boxes [latMin, latMax, lngMin, lngMax] used to reject
// a coordinate that lands in the wrong state — e.g. an "Anderson, SC" address
// that a loose geocoder (or stale stored coords) placed in California. Padded a
// little so points near a border aren't wrongly rejected. AK/HI omitted (island
// geometry makes a single box unreliable) — those simply skip the check.
const STATE_BBOX: Record<string, [number, number, number, number]> = {
  AL: [30.1, 35.1, -88.6, -84.8], AZ: [31.2, 37.1, -115.0, -108.9], AR: [32.9, 36.6, -94.8, -89.5],
  CA: [32.4, 42.1, -124.6, -114.0], CO: [36.9, 41.1, -109.2, -101.9], CT: [40.9, 42.2, -73.9, -71.7],
  DE: [38.4, 39.9, -75.9, -74.9], DC: [38.7, 39.1, -77.2, -76.8], FL: [24.3, 31.1, -87.8, -79.8],
  GA: [30.3, 35.1, -85.8, -80.7], ID: [41.9, 49.1, -117.4, -110.9], IL: [36.9, 42.6, -91.7, -87.3],
  IN: [37.7, 41.8, -88.3, -84.7], IA: [40.3, 43.6, -96.8, -90.0], KS: [36.9, 40.1, -102.2, -94.5],
  KY: [36.4, 39.2, -89.8, -81.8], LA: [28.8, 33.1, -94.2, -88.7], ME: [42.9, 47.6, -71.2, -66.8],
  MD: [37.8, 39.8, -79.6, -74.9], MA: [41.1, 43.0, -73.6, -69.8], MI: [41.6, 48.4, -90.5, -82.2],
  MN: [43.4, 49.5, -97.4, -89.4], MS: [30.1, 35.1, -91.8, -88.0], MO: [35.9, 40.7, -96.0, -88.9],
  MT: [44.3, 49.1, -116.2, -103.9], NE: [39.9, 43.1, -104.2, -95.2], NV: [34.9, 42.1, -120.1, -113.9],
  NH: [42.6, 45.4, -72.6, -70.5], NJ: [38.8, 41.4, -75.6, -73.8], NM: [31.2, 37.1, -109.2, -102.9],
  NY: [40.4, 45.1, -79.9, -71.8], NC: [33.7, 36.6, -84.4, -75.4], ND: [45.8, 49.1, -104.2, -96.5],
  OH: [38.3, 42.4, -85.0, -80.4], OK: [33.6, 37.1, -103.1, -94.4], OR: [41.9, 46.4, -124.7, -116.4],
  PA: [39.6, 42.4, -80.6, -74.6], RI: [41.1, 42.1, -71.9, -71.0], SC: [31.9, 35.3, -83.5, -78.4],
  SD: [42.4, 46.0, -104.2, -96.4], TN: [34.9, 36.8, -90.4, -81.6], TX: [25.7, 36.6, -106.8, -93.4],
  UT: [36.9, 42.1, -114.1, -108.9], VT: [42.7, 45.1, -73.5, -71.4], VA: [36.5, 39.5, -83.8, -75.1],
  WA: [45.5, 49.1, -125.0, -116.8], WV: [37.1, 40.7, -82.8, -77.6], WI: [42.4, 47.4, -93.0, -86.2],
  WY: [40.9, 45.1, -111.2, -103.9],
};

// The 2-letter state from an address like "194 Copperleaf Lane, Anderson, SC, 29625"
// (or "…, Anderson, SC 29625") — the token right before the trailing ZIP, or the
// last comma-token. '' if none found.
function stateFromAddress(address: string): string {
  const m =
    address.match(/,\s*([A-Za-z]{2})\s*,?\s*\d{5}(?:-\d{4})?\s*$/) ||
    address.match(/,\s*([A-Za-z]{2})\s*$/);
  const st = (m?.[1] || '').toUpperCase();
  return STATE_BBOX[st] ? st : '';
}

// True if the point sits inside the state's (padded) bounding box.
function inState(lat: number, lng: number, st: string): boolean {
  const b = STATE_BBOX[st];
  if (!b) return true; // unknown state → can't validate, don't reject
  return lat >= b[0] && lat <= b[1] && lng >= b[2] && lng <= b[3];
}

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

// Split "STREET, CITY, ST, ZIP" (or "…, ST ZIP") into structured parts. Missing
// pieces come back empty. Used so Nominatim respects the state/ZIP instead of
// matching a same-named street in another state.
function parseUsAddress(address: string): { street: string; city: string; state: string; postalcode: string } {
  const parts = address.split(',').map((s) => s.trim()).filter(Boolean);
  let street = '', city = '', state = '', postalcode = '';
  if (parts.length >= 3) {
    street = parts[0];
    city = parts[1];
    // Remaining tail holds state and/or ZIP, e.g. ["SC", "29625"] or ["SC 29625"].
    const tail = parts.slice(2).join(' ');
    const sm = tail.match(/\b([A-Za-z]{2})\b/);
    const zm = tail.match(/\b(\d{5})(?:-\d{4})?\b/);
    state = (sm?.[1] || '').toUpperCase();
    postalcode = zm?.[1] || '';
  }
  return { street, city, state, postalcode };
}

async function geocodeNominatim(address: string): Promise<Coords | null> {
  // Prefer a STRUCTURED query (street/city/state/postalcode, US only) — it honors
  // the state and ZIP, so it won't drift to a same-named street elsewhere. Fall
  // back to the free-text query only when we can't parse structured parts.
  const p = parseUsAddress(address);
  const base = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us';
  const url = p.street && p.city
    ? `${base}&street=${encodeURIComponent(p.street)}&city=${encodeURIComponent(p.city)}` +
      (p.state ? `&state=${encodeURIComponent(p.state)}` : '') +
      (p.postalcode ? `&postalcode=${encodeURIComponent(p.postalcode)}` : '')
    : `${base}&q=${encodeURIComponent(address)}`;
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

  // The state the address claims — used to reject a coordinate that lands in the
  // wrong state (bad stored coords, or a loose geocode of a same-named street).
  const wantState = stateFromAddress(address);
  const okState = (c: Coords | null): Coords | null =>
    c && (!wantState || inState(c.lat, c.lng, wantState)) ? c : null;

  const geocodeText = async (text: string): Promise<Coords | null> => {
    let c: Coords | null = null;
    try { c = okState(await geocodeCensus(text)); } catch { /* try next */ }
    if (!c) { try { c = okState(await geocodeNominatim(text)); } catch { /* give up */ } }
    return c;
  };

  let coords: Coords | null = null;
  // 1) Prefer the property's stored coordinates (most reliable when filled in) —
  //    but only if they land in the address's state (guards against stale/wrong
  //    stored coords, e.g. an SC property carrying California coordinates).
  if (propertyId) {
    try {
      const p = await fetchPropertyCoords(propertyId);
      if (p) coords = okState({ lat: p.lat, lng: p.lng, source: 'property' });
    } catch { /* fall back below */ }
  }
  // 2) Geocode the associated property's OWN street address (propertyId is a real
  //    Property whose stored coords are empty).
  if (!coords && propertyId) {
    try {
      const pa = await fetchPropertyAddress(propertyId);
      if (pa) coords = await geocodeText(pa);
    } catch { /* fall through */ }
  }
  // 3) Community inspections associate to a Community, not a Property, so the id
  //    resolves no Property above. Use the community's FIRST associated property's
  //    coords (then its address) as the mapping location.
  if (!coords && propertyId) {
    try {
      const firstProp = await fetchCommunityFirstPropertyId(propertyId);
      if (firstProp) {
        const c = await fetchPropertyCoords(firstProp);
        if (c) coords = okState({ lat: c.lat, lng: c.lng, source: 'community-property' });
        if (!coords) { const a = await fetchPropertyAddress(firstProp); if (a) coords = await geocodeText(a); }
      }
    } catch { /* fall through */ }
  }
  // 4) Fall back to geocoding the passed address text.
  if (!coords && address.length >= 5) coords = await geocodeText(address);

  cache.set(cacheKey, coords);
  return coords
    ? res.status(200).json(coords)
    : res.status(404).json({ error: 'No geocode match' });
}
