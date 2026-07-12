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
  routeOrder?: number;  // day-view: this inspector's visit # (1-based); labels the dot
  routeGroup?: string;  // day-view: inspector key — dots in a group are joined by a dashed line
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
  // Route lines (dashed per-inspector paths) live in their own layer under the
  // markers; they carry no popups so we clear & redraw them on every change.
  const routeLayerRef = useRef<L.LayerGroup | null>(null);
  // Markers kept across renders, keyed by inspection id, so streaming in more
  // dots (e.g. completed inspections loading after mount) reconciles instead of
  // wiping every marker — which was closing the popup the moment it opened.
  const markersRef = useRef<Map<string, { marker: L.Marker; key: string }>>(new Map());
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
    // Route lines added first so they sit BENEATH the marker dots.
    routeLayerRef.current = L.layerGroup().addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    map.on('popupopen', () => { popupOpenRef.current = true; });
    map.on('popupclose', () => { popupOpenRef.current = false; });
    mapRef.current = map;
    // A tick after mount so Leaflet measures the container correctly.
    setTimeout(() => map.invalidateSize(), 0);
    return () => { map.remove(); mapRef.current = null; layerRef.current = null; routeLayerRef.current = null; markersRef.current.clear(); };
  }, []);

  // Reconcile pins when the items change (add new, drop gone, recolor changed) —
  // never a full clear, so an already-open popup stays put.
  useEffect(() => {
    const map = mapRef.current, layer = layerRef.current;
    if (!map || !layer) return;
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));
    // A plain dot, or — in the day view — a slightly larger dot with the
    // inspector's route number centered in it.
    const iconFor = (color: string, order?: number) => order
      ? L.divIcon({
          className: '',
          html: `<div style="width:22px;height:22px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:11px;line-height:1;font-family:system-ui,-apple-system,sans-serif">${order}</div>`,
          iconSize: [22, 22], iconAnchor: [11, 11], popupAnchor: [0, -12],
        })
      : L.divIcon({
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
      const key = `${it.color}|${it.routeOrder ?? ''}`;
      const existing = store.get(it.id);
      if (existing) {
        // Keep the marker (and any open popup) — just refresh the icon if the
        // color or route number changed.
        if (existing.key !== key) { existing.marker.setIcon(iconFor(it.color, it.routeOrder)); existing.key = key; }
        return;
      }
      const html =
        `<div style="min-width:170px">
           <a href="${esc(it.href)}" style="font-weight:800;color:#ff0060;text-decoration:none;font-size:13px">${esc(it.title)}</a>
           <div style="color:#111827;font-size:12px;margin-top:2px">${esc(it.subtitle)}</div>
           <div style="color:#6b7280;font-size:12px;margin-top:2px">${esc(it.detail)}</div>
         </div>`;
      const marker = L.marker([it.lat, it.lng], { icon: iconFor(it.color, it.routeOrder) }).addTo(layer).bindPopup(html);
      store.set(it.id, { marker, key });
    });

    // Redraw the dashed per-inspector route lines (joining each group's stops in
    // visit order). Cleared each time — they have no popups to preserve.
    const routeLayer = routeLayerRef.current;
    if (routeLayer) {
      routeLayer.clearLayers();
      const groups: Record<string, MapItem[]> = {};
      items.forEach((it) => { if (it.routeGroup && it.routeOrder) (groups[it.routeGroup] ||= []).push(it); });
      Object.values(groups).forEach((arr) => {
        if (arr.length < 2) return;
        const path = arr.slice().sort((a, b) => (a.routeOrder || 0) - (b.routeOrder || 0)).map((it) => [it.lat, it.lng] as L.LatLngExpression);
        // White casing underneath makes the colored dashes readable over busy
        // map tiles; the colored dashed line rides on top — visible, not heavy.
        L.polyline(path, { color: '#ffffff', weight: 5, opacity: 0.7, lineCap: 'round', lineJoin: 'round' }).addTo(routeLayer);
        L.polyline(path, { color: arr[0].color, weight: 3, opacity: 0.9, dashArray: '6 6', lineCap: 'round', lineJoin: 'round' }).addTo(routeLayer);
      });
    }

    // Auto-fit to the dots — but NOT while a popup is open, so streaming loads
    // don't recenter and hide what the user just tapped.
    if (!popupOpenRef.current) {
      if (pts.length === 1) map.setView(pts[0], 12);
      else if (pts.length > 1) map.fitBounds(L.latLngBounds(pts).pad(0.25));
    }
  }, [items]);

  return <div ref={elRef} className="w-full h-80 rounded-xl overflow-hidden border border-gray-200" style={{ zIndex: 0 }} />;
}
