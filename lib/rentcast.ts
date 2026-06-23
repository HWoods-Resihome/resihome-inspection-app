/**
 * lib/rentcast.ts — pull active rental comps for a subject property from RentCast,
 * to validate a 1099 leasing-agent listing-price recommendation. Ported from the
 * "ResiHome RentCast Pricing Review v3" Apps Script: the AVM long-term endpoint
 * with the same incremental BROADENING (tight → loose) and client-side filtering
 * (same state, Active, recency), returning the closest 2–3 comps.
 *
 * The API key is intentionally embeddable (owner-confirmed); override via env.
 */
const API_BASE = 'https://api.rentcast.io/v1';
const AVM_ENDPOINT = '/avm/rent/long-term';
const API_KEY = (process.env.RENTCAST_API_KEY || '50a0024e2af949099263017f1cec7407').trim();
const PROPERTY_TYPE = 'Single Family';
const COMP_COUNT = 20;
const COMPS_TO_DISPLAY = 3;
const RATE_LIMIT_MS = 800;

// Each attempt widens the search (radius / recency / active-only), exactly like
// the Apps Script. Attempt 1 is tight; attempt 3 is loose.
const SEARCH_ATTEMPTS = [
  { maxRadius: 5, daysOld: 180, displayMaxAge: 60, requireActive: true },
  { maxRadius: 10, daysOld: 365, displayMaxAge: 120, requireActive: true },
  { maxRadius: 15, daysOld: 545, displayMaxAge: 270, requireActive: false },
];

export interface RentSubject {
  address: string;            // full address (street, city, state zip) is fine
  state?: string; city?: string; zip?: string;
  bed?: number | null; bath?: number | null; sqft?: number | null;
}

export interface RentComp {
  address: string; city: string; state: string; zip: string;
  price: number; sqft: number; psf: number;
  bed: number | null; bath: number | null;
  distance: number; status: string; daysOnMarket: number; listedDate: string;
}

export interface RentCompResult {
  ok: boolean;
  avmRent: number; avmLow: number; avmHigh: number;
  comps: RentComp[];
  totalReturned: number;
  attempt: number;
  error?: string;
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function buildQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .filter((k) => params[k] !== '' && params[k] != null)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
}

/** Normalize an address for the geocoder: collapse a comma between state and ZIP
 *  ("McDonough, GA, 30253" → "McDonough, GA 30253") and squeeze whitespace. */
export function normalizeAddress(a: string): string {
  return (a || '').replace(/,\s*([A-Za-z]{2}),\s*(\d{5})/, ', $1 $2').replace(/\s{2,}/g, ' ').trim();
}

/** Parse state/zip/city out of a "Street, City, ST ZIP" snapshot when not given. */
export function parseAddressParts(full: string): { state: string; zip: string; city: string } {
  const s = (full || '').trim();
  const zip = (s.match(/\b(\d{5})(?:-\d{4})?\b/) || [])[1] || '';
  const state = (s.match(/,\s*([A-Z]{2})\b/) || [])[1] || '';
  const parts = s.split(',').map((p) => p.trim());
  const city = parts.length >= 2 ? parts[1] : '';
  return { state, zip, city };
}

async function fetchRentAvm(subject: RentSubject, sp: typeof SEARCH_ATTEMPTS[number]) {
  const params: Record<string, string> = {
    address: subject.address,
    propertyType: PROPERTY_TYPE,
    compCount: String(COMP_COUNT),
    maxRadius: String(sp.maxRadius),
    daysOld: String(sp.daysOld),
    lookupSubjectAttributes: 'true', // let RentCast fill subject bed/bath/sqft
  };
  if (subject.bed) params.bedrooms = String(subject.bed);
  if (subject.bath) params.bathrooms = String(subject.bath);
  if (subject.sqft) params.squareFootage = String(subject.sqft);

  const url = `${API_BASE}${AVM_ENDPOINT}?${buildQuery(params)}`;
  const doFetch = () => fetch(url, { method: 'GET', headers: { 'X-Api-Key': API_KEY, Accept: 'application/json' } });

  let resp = await doFetch();
  if (resp.status === 429) { await sleep(3000); resp = await doFetch(); }
  const code = resp.status;
  const body = await resp.text();

  if (code === 401) return { ok: false as const, error: 'UNAUTHORIZED', retryable: false };
  if (code === 402) return { ok: false as const, error: 'OUT OF CREDITS', retryable: false };
  if (code === 404) return { ok: false as const, error: 'ADDRESS NOT FOUND', retryable: false };
  if (code === 400) {
    const insufficient = body.indexOf('insufficient comparables') > -1;
    const badAddr = body.indexOf('could not be parsed') > -1;
    return { ok: false as const, error: badAddr ? 'BAD ADDRESS' : (insufficient ? 'INSUFFICIENT COMPS' : `HTTP 400`), retryable: insufficient };
  }
  if (code < 200 || code >= 300) return { ok: false as const, error: `HTTP ${code}`, retryable: false };
  try {
    const j = JSON.parse(body);
    return {
      ok: true as const,
      rent: Number(j.rent) || 0,
      rentRangeLow: Number(j.rentRangeLow) || 0,
      rentRangeHigh: Number(j.rentRangeHigh) || 0,
      comparables: Array.isArray(j.comparables) ? j.comparables : [],
      retryable: false,
    };
  } catch (e: any) {
    return { ok: false as const, error: 'PARSE ERROR', retryable: false };
  }
}

function daysBetween(a: Date, b: Date) { return Math.abs(Math.round((b.getTime() - a.getTime()) / 86400000)); }
function fmtDate(iso: any): string { if (!iso) return ''; const d = new Date(iso); return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10); }

function filterComps(allComps: any[], subject: RentSubject, sp: typeof SEARCH_ATTEMPTS[number]): RentComp[] {
  const subjState = (subject.state || '').toUpperCase();
  const passed = allComps.filter((c) => {
    if (subjState && c.state && String(c.state).toUpperCase() !== subjState) return false; // same state
    if (sp.requireActive && c.status !== 'Active') return false;
    if (sp.displayMaxAge > 0 && c.lastSeenDate) {
      const age = daysBetween(new Date(c.lastSeenDate), new Date());
      if (age > sp.displayMaxAge) return false;
    }
    return true;
  });
  passed.sort((a, b) => (Number(a.distance) || 999) - (Number(b.distance) || 999));
  return passed.slice(0, COMPS_TO_DISPLAY).map((c) => {
    const addr = c.formattedAddress || c.addressLine1 || '';
    const price = Number(c.price) || 0;
    const sqft = Number(c.squareFootage) || 0;
    return {
      address: addr, city: c.city || '', state: c.state || '', zip: c.zipCode || '',
      price, sqft, psf: sqft && price ? Number((price / sqft).toFixed(2)) : 0,
      bed: c.bedrooms ?? null, bath: c.bathrooms ?? null,
      distance: Number(c.distance) || 0, status: c.status || '',
      daysOnMarket: Number(c.daysOnMarket) || 0, listedDate: fmtDate(c.listedDate),
    };
  });
}

/** Fetch active rental comps for a subject, broadening until some pass filters. */
export async function fetchRentComps(subjectIn: RentSubject): Promise<RentCompResult> {
  // Normalize the address, then fill state/zip/city from it if not supplied.
  const address = normalizeAddress(subjectIn.address);
  const parts = parseAddressParts(address);
  const subject: RentSubject = {
    ...subjectIn,
    address,
    state: subjectIn.state || parts.state,
    city: subjectIn.city || parts.city,
    zip: subjectIn.zip || parts.zip,
  };
  if (!subject.address || subject.address.trim().length < 5) {
    return { ok: false, avmRent: 0, avmLow: 0, avmHigh: 0, comps: [], totalReturned: 0, attempt: 0, error: 'NO ADDRESS' };
  }

  for (let a = 0; a < SEARCH_ATTEMPTS.length; a++) {
    const sp = SEARCH_ATTEMPTS[a];
    const r = await fetchRentAvm(subject, sp);
    if (!r.ok && !r.retryable) {
      return { ok: false, avmRent: 0, avmLow: 0, avmHigh: 0, comps: [], totalReturned: 0, attempt: a + 1, error: r.error };
    }
    if (!r.ok && r.retryable) { await sleep(RATE_LIMIT_MS); continue; }
    if (r.ok) {
      const comps = filterComps(r.comparables, subject, sp);
      if (comps.length > 0 || a === SEARCH_ATTEMPTS.length - 1) {
        return {
          ok: true, avmRent: Math.round(r.rent), avmLow: Math.round(r.rentRangeLow), avmHigh: Math.round(r.rentRangeHigh),
          comps, totalReturned: r.comparables.length, attempt: a + 1,
        };
      }
      await sleep(RATE_LIMIT_MS); // had comps but all filtered out → broaden
    }
  }
  return { ok: false, avmRent: 0, avmLow: 0, avmHigh: 0, comps: [], totalReturned: 0, attempt: SEARCH_ATTEMPTS.length, error: 'NO COMPS AFTER ALL ATTEMPTS' };
}
