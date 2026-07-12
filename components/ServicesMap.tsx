import { useEffect, useRef } from 'react';
import L from 'leaflet';

export interface MapItem {
  id: string;
  lat: number;
  lng: number;
  title: string;      // address (pink link)
  line2: string;      // "Worktype · Subtype · Status"
  line3: string;      // "Due 7/22 · Vendor"  (or "Done 7/6 · 3:45 PM · Vendor")
  href: string;       // link into the record
  color: string;      // pin color (hex)
  badge?: string;     // optional number shown inside the pin (day-view route stop #)
}

// A vendor's ordered day-route drawn as a light dashed line beneath the dots.
export interface RouteLine { color: string; points: [number, number][]; }

/**
 * Leaflet + OpenStreetMap map of record locations. Client-only (imported via
 * next/dynamic with ssr:false). Custom HTML pins avoid Leaflet's default marker
 * image assets; each pin opens a 3-row popup (address / detail · status / date ·
 * vendor) linking into the record.
 *
 * Markers are RECONCILED BY ID across renders — existing ones are kept (color +
 * popup content refreshed in place), new ones added, gone ones removed — instead
 * of clearing and rebuilding every marker. Records stream in asynchronously
 * (coords fill progressively), and a full rebuild would destroy the very marker
 * whose popup you'd just opened. The view also won't auto-fit while a popup is
 * open, so opening one never yanks the map out from under you.
 */
export default function ServicesMap({ items, routes }: { items: MapItem[]; routes?: RouteLine[] }) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const routeLayerRef = useRef<L.LayerGroup | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const markersRef = useRef<Map<string, { marker: L.Marker; key: string; html: string }>>(new Map());
  const popupOpenRef = useRef(false);
  const fitSigRef = useRef('');   // signature of the id set last auto-fit to

  // Create the map once. Route lines go in a layer added BEFORE the markers so
  // they sit beneath the dots.
  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const map = L.map(elRef.current, { scrollWheelZoom: false, attributionControl: true }).setView([33.75, -84.39], 9);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors', maxZoom: 19,
    }).addTo(map);
    routeLayerRef.current = L.layerGroup().addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    map.on('popupopen', () => { popupOpenRef.current = true; });
    map.on('popupclose', () => { popupOpenRef.current = false; });
    mapRef.current = map;
    // A tick after mount so Leaflet measures the container correctly.
    setTimeout(() => map.invalidateSize(), 0);
    return () => { map.remove(); mapRef.current = null; layerRef.current = null; routeLayerRef.current = null; markersRef.current.clear(); };
  }, []);

  // Reconcile pins when the items change (see the note above).
  useEffect(() => {
    const map = mapRef.current, layer = layerRef.current;
    if (!map || !layer) return;
    const esc = (s: string) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));
    const iconFor = (color: string, badge?: string) => {
      const size = badge ? 22 : 18;
      const inner = badge
        ? `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:800;line-height:1">${esc(badge)}</div>`
        : `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.45)"></div>`;
      return L.divIcon({ className: '', html: inner, iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -(size / 2 + 1)] });
    };
    const htmlFor = (it: MapItem) =>
      `<div style="min-width:170px">
         <a href="${esc(it.href)}" style="font-weight:800;color:#ff0060;text-decoration:none;font-size:13px">${esc(it.title)}</a>
         <div style="color:#111827;font-size:12px;margin-top:2px">${esc(it.line2)}</div>
         <div style="color:#6b7280;font-size:12px;margin-top:2px">${esc(it.line3)}</div>
       </div>`;

    const seen = new Set<string>();
    const pts: L.LatLngExpression[] = [];
    for (const it of items) {
      if (!Number.isFinite(it.lat) || !Number.isFinite(it.lng)) continue;
      seen.add(it.id);
      pts.push([it.lat, it.lng]);
      const html = htmlFor(it);
      const key = `${it.color}|${it.badge || ''}`;
      const existing = markersRef.current.get(it.id);
      if (existing) {
        if (existing.key !== key) { existing.marker.setIcon(iconFor(it.color, it.badge)); existing.key = key; }
        if (existing.html !== html) { existing.marker.setPopupContent(html); existing.html = html; }
        existing.marker.setLatLng([it.lat, it.lng]);
      } else {
        const marker = L.marker([it.lat, it.lng], { icon: iconFor(it.color, it.badge) }).addTo(layer).bindPopup(html);
        markersRef.current.set(it.id, { marker, key, html });
      }
    }
    // Drop markers whose record is gone.
    for (const [id, rec] of markersRef.current) {
      if (!seen.has(id)) { layer.removeLayer(rec.marker); markersRef.current.delete(id); }
    }

    // Auto-fit only when the SET of records changed and no popup is open (so an
    // open popup — or a progressive coord backfill — never re-frames the map).
    const sig = Array.from(seen).sort().join(',');
    if (!popupOpenRef.current && sig !== fitSigRef.current) {
      fitSigRef.current = sig;
      if (pts.length === 1) map.setView(pts[0], 12);
      else if (pts.length > 1) map.fitBounds(L.latLngBounds(pts).pad(0.25));
    }
  }, [items]);

  // Route lines — cheap to rebuild (no popups), so just clear + redraw. Dashed,
  // light, beneath the dots; traces each vendor's stops in order.
  useEffect(() => {
    const layer = routeLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    for (const r of routes || []) {
      if (r.points.length < 2) continue;
      L.polyline(r.points, { color: r.color, weight: 2.5, opacity: 0.55, dashArray: '4 6', lineJoin: 'round' }).addTo(layer);
    }
  }, [routes]);

  return <div ref={elRef} className="w-full h-80 rounded-xl overflow-hidden border border-gray-200" style={{ zIndex: 0 }} />;
}
