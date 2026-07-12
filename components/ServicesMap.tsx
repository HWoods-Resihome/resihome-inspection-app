import { useEffect, useRef } from 'react';
import L from 'leaflet';

export interface MapItem {
  id: string;
  lat: number;
  lng: number;
  title: string;      // address
  subtitle: string;   // "Worktype · Status"
  detail: string;     // "Done 7/6 3:45 PM · Inspector" (date, time, inspector)
  href: string;       // link into the service
  color: string;      // pin color (hex)
}

/**
 * Leaflet + OpenStreetMap map of service locations. Client-only (imported via
 * next/dynamic with ssr:false). Custom HTML pins avoid Leaflet's default marker
 * image assets; each pin opens a popup with the address, service detail, and a
 * link into the service.
 */
export default function ServicesMap({ items }: { items: MapItem[] }) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  // Markers kept across renders, keyed by inspection id, so streaming in more
  // dots (e.g. completed inspections loading after mount) reconciles instead of
  // wiping every marker — which was closing the popup the moment it opened.
  const markersRef = useRef<Map<string, { marker: L.Marker; color: string }>>(new Map());
  // True while any popup is open — we skip auto-fitting the view then, so a late
  // batch of dots never yanks the map out from under an open popup.
  const popupOpenRef = useRef(false);

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

  // Reconcile pins when the items change (add new, drop gone, recolor changed) —
  // never a full clear, so an already-open popup stays put.
  useEffect(() => {
    const map = mapRef.current, layer = layerRef.current;
    if (!map || !layer) return;
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));
    const iconFor = (color: string) => L.divIcon({
      className: '',
      html: `<div style="width:18px;height:18px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.45)"></div>`,
      iconSize: [18, 18], iconAnchor: [9, 9], popupAnchor: [0, -10],
    });

    const store = markersRef.current;
    const nextIds = new Set(items.map((it) => it.id));
    // Remove markers whose items are gone.
    store.forEach((rec, id) => {
      if (!nextIds.has(id)) { layer.removeLayer(rec.marker); store.delete(id); }
    });

    const pts: L.LatLngExpression[] = [];
    items.forEach((it) => {
      pts.push([it.lat, it.lng]);
      const existing = store.get(it.id);
      if (existing) {
        // Keep the marker (and any open popup) — just refresh color if it changed.
        if (existing.color !== it.color) { existing.marker.setIcon(iconFor(it.color)); existing.color = it.color; }
        return;
      }
      const html =
        `<div style="min-width:170px">
           <a href="${esc(it.href)}" style="font-weight:800;color:#ff0060;text-decoration:none;font-size:13px">${esc(it.title)}</a>
           <div style="color:#111827;font-size:12px;margin-top:2px">${esc(it.subtitle)}</div>
           <div style="color:#6b7280;font-size:12px;margin-top:2px">${esc(it.detail)}</div>
         </div>`;
      const marker = L.marker([it.lat, it.lng], { icon: iconFor(it.color) }).addTo(layer).bindPopup(html);
      store.set(it.id, { marker, color: it.color });
    });

    // Auto-fit to the dots — but NOT while a popup is open, so streaming loads
    // don't recenter and hide what the user just tapped.
    if (!popupOpenRef.current) {
      if (pts.length === 1) map.setView(pts[0], 12);
      else if (pts.length > 1) map.fitBounds(L.latLngBounds(pts).pad(0.25));
    }
  }, [items]);

  return <div ref={elRef} className="w-full h-80 rounded-xl overflow-hidden border border-gray-200" style={{ zIndex: 0 }} />;
}
