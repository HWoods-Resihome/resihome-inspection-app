/**
 * Shared evidence-stamp helpers — the burned-in address / timestamp / GPS
 * overlay used on captured photos. Kept identical to the in-app camera's stamp
 * (see CameraCapture.drawEvidenceStamp) so Room-Scan stills match exactly.
 *
 * `drawEvidenceStamp`, `haversineMeters`, `fmtDistance` and the thresholds are
 * copied verbatim from CameraCapture so the look is the same. The geo helpers
 * (`getGeoFix`, `resolvePropertyRefCoords`, `buildStampLines`) let a non-camera
 * caller (the video frame extractor) produce the same stamp lines.
 */

export type StampLine = { text: string; mark?: 'ok' | 'bad' };

export interface GeoFix { lat: number; lng: number; acc: number; ts: number }
export interface RefCoords { lat: number; lng: number; source: string }

// 250m default to absorb GPS drift and rooftop-vs-parcel geocode offset.
export const PROXIMITY_THRESHOLD_M = Number(process.env.NEXT_PUBLIC_PROXIMITY_THRESHOLD_M) || 250;
export const FIX_TTL_MS = 15000;

// Burn an evidence stamp (address / timestamp / GPS) into the bottom-left of a
// frame. Drawn onto the canvas BEFORE encoding, so it's part of the pixels.
export function drawEvidenceStamp(ctx: CanvasRenderingContext2D, w: number, h: number, lines: StampLine[]) {
  const rows = lines.filter((l) => l.text);
  if (!rows.length) return;
  const pad = Math.round(w * 0.014);
  // Width-scaled (trimmed w/54 → w/72) but CAPPED by height so a low-res capture
  // can't let the bar balloon to dominate the photo. Budget ≤ ~16% of height.
  const lf = 1.34;
  const fontByWidth = Math.round(w / 72);
  const fontByHeight = Math.floor((h * 0.16 - pad * 2) / (rows.length * lf));
  const fontSize = Math.max(11, Math.min(fontByWidth, fontByHeight));
  const lineH = Math.round(fontSize * lf);
  const barH = lineH * rows.length + pad * 2;
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.42)';
  ctx.fillRect(0, h - barH, w, barH);
  ctx.font = `600 ${fontSize}px -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.shadowColor = 'rgba(0,0,0,0.85)';
  ctx.shadowBlur = Math.round(fontSize * 0.3);
  let y = h - barH + pad;
  for (const row of rows) {
    ctx.fillStyle = '#ffffff';
    ctx.fillText(row.text, pad, y);
    if (row.mark) {
      const x = pad + ctx.measureText(row.text + '  ').width;
      ctx.fillStyle = row.mark === 'ok' ? '#34d399' : '#f87171';
      ctx.fillText(row.mark === 'ok' ? '✓' : '✗', x, y);
    }
    y += lineH;
  }
  ctx.restore();
}

export function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function fmtDistance(m: number): string {
  const ft = m * 3.28084;
  return ft < 1000 ? `${Math.round(ft)} ft` : `${(m / 1609.344).toFixed(1)} mi`;
}

// One-shot GPS fix (Promise; resolves null on denial/timeout).
export async function getGeoFix(timeoutMs = 8000): Promise<GeoFix | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return null;
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy, ts: Date.now() }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 10000 },
    );
  });
}

// Property reference coordinates — prefers stored lat/long (propertyRecordId),
// falls back to geocoding the address. Mirrors the camera's resolution.
export async function resolvePropertyRefCoords(propertyRecordId?: string, address?: string): Promise<RefCoords | null> {
  if (!propertyRecordId && !address) return null;
  try {
    const params = new URLSearchParams();
    if (propertyRecordId) params.set('propertyId', propertyRecordId);
    if (address) params.set('address', address);
    const r = await fetch(`/api/geocode?${params.toString()}`);
    if (!r.ok) return null;
    const d = await r.json();
    if (!isFinite(Number(d.lat)) || !isFinite(Number(d.lng))) return null;
    return { lat: Number(d.lat), lng: Number(d.lng), source: String(d.source || 'unknown') };
  } catch {
    return null;
  }
}

// Coordinates + proximity verdict lines (matches CameraCapture.buildGeoStampLines).
export function buildGeoStampLines(fix: GeoFix | null, ref: RefCoords | null): StampLine[] {
  const lines: StampLine[] = [];
  const fresh = !!fix && Date.now() - fix.ts <= FIX_TTL_MS;
  if (fresh && fix) {
    lines.push({ text: `${fix.lat.toFixed(5)}, ${fix.lng.toFixed(5)} (±${Math.round(fix.acc)}m)` });
    if (ref) {
      const dist = haversineMeters(fix.lat, fix.lng, ref.lat, ref.lng);
      const within = dist - fix.acc <= PROXIMITY_THRESHOLD_M;
      lines.push({ text: `${within ? 'At property' : 'Off-site'} · ${fmtDistance(dist)}`, mark: within ? 'ok' : 'bad' });
    }
  } else if (ref) {
    lines.push({ text: 'Location unverified' });
  }
  return lines;
}

// Full stamp: address + date/time + geo lines (matches the camera's poster stamp).
export function buildStampLines(address: string, fix: GeoFix | null, ref: RefCoords | null): StampLine[] {
  const lines: StampLine[] = [];
  if (address) lines.push({ text: address });
  lines.push({ text: new Date().toLocaleString() });
  lines.push(...buildGeoStampLines(fix, ref));
  return lines;
}
