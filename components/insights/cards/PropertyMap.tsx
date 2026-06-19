/**
 * Property / inspection map — plots the filtered inspections at their resolved
 * coordinates (snapshot-backfilled: Property stored lat/long, else geocoded).
 * Leaflet is imported client-side only (inside the effect) so SSR is safe; tiles
 * are CARTO dark to match the dashboard (free, no API key, same OSM data the
 * in-app camera geocoder uses). Markers are status-colored circleMarkers (no
 * image assets) with a popup linking to the inspection. Respects all global
 * filters. Coordinates fill in over a few snapshot builds, so the located count
 * climbs after each refresh.
 */
import { useEffect, useMemo, useRef } from 'react';
import { CardFrame, CardNote } from '../cardChrome';
import { templateLabel } from '@/lib/templateLabels';
import type { InsightsRow } from '@/lib/insightsSnapshot';

const ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" /></svg>
);

// Status → marker color (matches the dashboard's status language).
const STATUS_COLOR: Record<string, string> = {
  scheduled: '#a1a1aa',
  in_progress: '#73E3DF',
  pending_approval: '#f5a623',
  completed: '#ff0060',
  other: '#71717a',
};
const STATUS_LABEL: Record<string, string> = {
  scheduled: 'Scheduled', in_progress: 'In progress', pending_approval: 'Pending approval',
  completed: 'Completed', other: 'Other',
};

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

export function PropertyMap({ rows }: { rows: InsightsRow[] }) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const layerRef = useRef<any>(null);

  const located = useMemo(
    () => rows.filter((r) => typeof r.lat === 'number' && typeof r.lng === 'number'),
    [rows],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const mod = await import('leaflet');
      const L: any = (mod as any).default ?? mod;
      if (cancelled || !elRef.current) return;

      if (!mapRef.current) {
        mapRef.current = L.map(elRef.current, { scrollWheelZoom: false, worldCopyJump: true });
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
        }).addTo(mapRef.current);
        layerRef.current = L.layerGroup().addTo(mapRef.current);
      }

      layerRef.current.clearLayers();
      const latlngs: [number, number][] = [];
      for (const r of located) {
        const color = STATUS_COLOR[r.status] || STATUS_COLOR.other;
        const lat = r.lat as number, lng = r.lng as number;
        const popup =
          `<div style="font-size:12px;line-height:1.4;min-width:160px">`
          + `<div style="font-weight:700;color:#18181c">${esc(r.propertyAddress || '(no address)')}</div>`
          + `<div style="color:#52525b">${esc(r.inspectorName || r.inspectorEmail || '—')}</div>`
          + `<div style="color:#52525b">${esc(STATUS_LABEL[r.status] || r.status)}${r.templateType ? ' · ' + esc(templateLabel(r.templateType)) : ''}</div>`
          + `<a href="/inspection/${encodeURIComponent(r.recordId)}" target="_blank" rel="noopener noreferrer" style="color:#ff0060;font-weight:600;text-decoration:none">Open inspection ↗</a>`
          + `</div>`;
        L.circleMarker([lat, lng], { radius: 6, color: '#0e0e11', weight: 1, fillColor: color, fillOpacity: 0.92 })
          .bindPopup(popup)
          .addTo(layerRef.current);
        latlngs.push([lat, lng]);
      }
      if (latlngs.length === 1) mapRef.current.setView(latlngs[0], 12);
      else if (latlngs.length > 1) mapRef.current.fitBounds(latlngs, { padding: [28, 28], maxZoom: 12 });
      else mapRef.current.setView([39.5, -98.35], 4); // continental US
      // The card may mount hidden/resized — recompute tiles once laid out.
      setTimeout(() => { if (!cancelled && mapRef.current) mapRef.current.invalidateSize(); }, 60);
    })();
    return () => { cancelled = true; };
  }, [located]);

  // Tear the map down on unmount (e.g. when the card is minimized).
  useEffect(() => () => {
    if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; layerRef.current = null; }
  }, []);

  return (
    <CardFrame
      title="Property / inspection map" icon={ICON}
      subtitle="located inspections, colored by status"
      headerRight={<span className="text-[11px] text-[#71717a]">{located.length} of {rows.length} located</span>}
      bodyClassName="p-0"
    >
      {rows.length === 0 ? (
        <CardNote>No inspections in the current filter.</CardNote>
      ) : (
        <div className="relative">
          <div ref={elRef} className="h-[440px] w-full rounded-b-2xl overflow-hidden" style={{ background: '#0e0e11' }} />
          {located.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <span className="text-[12px] text-[#a1a1aa] bg-[#18181c]/90 rounded-lg px-3 py-2">
                Geocoding addresses… coordinates fill in over the next few refreshes.
              </span>
            </div>
          )}
        </div>
      )}
    </CardFrame>
  );
}
