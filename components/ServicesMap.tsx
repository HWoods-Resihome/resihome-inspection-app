import { useEffect, useRef } from 'react';
import L from 'leaflet';

export interface MapItem {
  id: string;
  lat: number;
  lng: number;
  title: string;      // address
  subtitle: string;   // "Worktype · Subtype · Due …"
  vendor: string;
  href: string;       // link into the service
  color: string;      // pin color (hex)
}

/**
 * Leaflet + OpenStreetMap map of service locations. Client-only (imported via
 * next/dynamic with ssr:false). Custom HTML pins avoid Leaflet's default marker
 * image assets; each pin opens a popup with the address, service detail, vendor,
 * and a link into the service.
 */
export default function ServicesMap({ items }: { items: MapItem[] }) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);

  // Create the map once.
  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const map = L.map(elRef.current, { scrollWheelZoom: false, attributionControl: true }).setView([33.75, -84.39], 9);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors', maxZoom: 19,
    }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    // A tick after mount so Leaflet measures the container correctly.
    setTimeout(() => map.invalidateSize(), 0);
    return () => { map.remove(); mapRef.current = null; layerRef.current = null; };
  }, []);

  // (Re)draw pins when the items change.
  useEffect(() => {
    const map = mapRef.current, layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    const pts: L.LatLngExpression[] = [];
    items.forEach((it) => {
      const icon = L.divIcon({
        className: '',
        html: `<div style="width:18px;height:18px;border-radius:50%;background:${it.color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.45)"></div>`,
        iconSize: [18, 18], iconAnchor: [9, 9], popupAnchor: [0, -10],
      });
      const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));
      const html =
        `<div style="min-width:170px">
           <a href="${esc(it.href)}" style="font-weight:800;color:#ff0060;text-decoration:none;font-size:13px">${esc(it.title)}</a>
           <div style="color:#111827;font-size:12px;margin-top:2px">${esc(it.subtitle)}</div>
           <div style="color:#6b7280;font-size:12px;margin-top:2px">${esc(it.vendor)}</div>
         </div>`;
      L.marker([it.lat, it.lng], { icon }).addTo(layer).bindPopup(html);
      pts.push([it.lat, it.lng]);
    });
    if (pts.length === 1) map.setView(pts[0], 12);
    else if (pts.length > 1) map.fitBounds(L.latLngBounds(pts).pad(0.25));
  }, [items]);

  return <div ref={elRef} className="w-full h-80 rounded-xl overflow-hidden border border-gray-200" style={{ zIndex: 0 }} />;
}
