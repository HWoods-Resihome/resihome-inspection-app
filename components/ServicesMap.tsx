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
}

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
export default function ServicesMap({ items }: { items: MapItem[] }) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const markersRef = useRef<Map<string, { marker: L.Marker; color: string; html: string }>>(new Map());
  const popupOpenRef = useRef(false);
  const fitSigRef = useRef('');   // signature of the id set last auto-fit to

  // Create the map once.
  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const map = L.map(elRef.current, { scrollWheelZoom: false, attributionControl: true }).setView([33.75, -84.39], 9);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors', maxZoom: 19,
    }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    map.on('popupopen', () => { popupOpenRef.current = true; });
    map.on('popupclose', () => { popupOpenRef.current = false; });
    mapRef.current = map;
    // A tick after mount so Leaflet measures the container correctly.
    setTimeout(() => map.invalidateSize(), 0);
    return () => { map.remove(); mapRef.current = null; layerRef.current = null; markersRef.current.clear(); };
  }, []);

  // Reconcile pins when the items change (see the note above).
  useEffect(() => {
    const map = mapRef.current, layer = layerRef.current;
    if (!map || !layer) return;
    const esc = (s: string) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));
    const iconFor = (color: string) => L.divIcon({
      className: '',
      html: `<div style="width:18px;height:18px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.45)"></div>`,
      iconSize: [18, 18], iconAnchor: [9, 9], popupAnchor: [0, -10],
    });
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
      const existing = markersRef.current.get(it.id);
      if (existing) {
        if (existing.color !== it.color) { existing.marker.setIcon(iconFor(it.color)); existing.color = it.color; }
        if (existing.html !== html) { existing.marker.setPopupContent(html); existing.html = html; }
        existing.marker.setLatLng([it.lat, it.lng]);
      } else {
        const marker = L.marker([it.lat, it.lng], { icon: iconFor(it.color) }).addTo(layer).bindPopup(html);
        markersRef.current.set(it.id, { marker, color: it.color, html });
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

  return <div ref={elRef} className="w-full h-80 rounded-xl overflow-hidden border border-gray-200" style={{ zIndex: 0 }} />;
}
