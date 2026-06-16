// lib/geolocationBridge.ts
//
// Gated native-only geolocation bridge for the ResiWALK Capacitor iOS shell.
//
// WHY: the in-app camera burns a GPS evidence stamp + an on-site proximity ✓/✗
// using the web `navigator.geolocation` API (see components/CameraCapture.tsx).
// Android WebView implements that API, but a plain WKWebView does NOT bridge it
// to CoreLocation — so on the native iOS app the stamp reads "unverified" and the
// proximity check never evaluates. This installs a drop-in `navigator.geolocation`
// backed by @capacitor/geolocation (a tested CLLocationManager wrapper) so the
// EXACT SAME web code works unchanged on iOS.
//
// HARD GATE: behind Capacitor.isNativePlatform() AND platform === 'ios' — a no-op
// in a normal browser (and in Android's WebView, which already has geolocation),
// so web behavior is byte-for-byte unchanged. The Capacitor packages are imported
// dynamically so they never enter the browser bundle's critical path and a
// missing native runtime can't throw.
//
// WIRE-UP: call installGeolocationBridge() once at startup in pages/_app.tsx,
// alongside installOAuthBridge() (see mobile/ios-pending/README.md). Requires
// @capacitor/geolocation in package.json + `npx cap sync ios`.

let installed = false;

export async function installGeolocationBridge(): Promise<void> {
  if (typeof window === 'undefined') return;
  if (installed) return;

  let Capacitor: typeof import('@capacitor/core').Capacitor;
  try {
    ({ Capacitor } = await import('@capacitor/core'));
  } catch {
    return; // Capacitor not available — nothing to do.
  }

  // THE GATE: only bridge where the native API is genuinely missing (iOS
  // WKWebView). Normal browsers and Android WebView already have geolocation.
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'ios') return;

  let CapGeolocation: typeof import('@capacitor/geolocation').Geolocation;
  try {
    ({ Geolocation: CapGeolocation } = await import('@capacitor/geolocation'));
  } catch {
    return; // plugin not in this build — leave navigator.geolocation as-is.
  }

  installed = true;

  // Map a Capacitor Position onto the W3C GeolocationPosition shape the web app
  // reads (CameraCapture uses coords.latitude/longitude/accuracy + timestamp).
  const toPosition = (p: { coords: any; timestamp?: number }): GeolocationPosition => ({
    coords: {
      latitude: p.coords.latitude,
      longitude: p.coords.longitude,
      accuracy: p.coords.accuracy,
      altitude: p.coords.altitude ?? null,
      altitudeAccuracy: p.coords.altitudeAccuracy ?? null,
      heading: p.coords.heading ?? null,
      speed: p.coords.speed ?? null,
    },
    timestamp: p.timestamp ?? Date.now(),
  }) as GeolocationPosition;

  const toError = (e: any): GeolocationPositionError => {
    const denied = /denied|permission/i.test(String(e?.message || e));
    return {
      code: denied ? 1 : 2, // 1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE, 3 TIMEOUT
      message: String(e?.message || e || 'Location unavailable'),
      PERMISSION_DENIED: 1,
      POSITION_UNAVAILABLE: 2,
      TIMEOUT: 3,
    } as GeolocationPositionError;
  };

  const opts = (o?: PositionOptions) => ({
    enableHighAccuracy: o?.enableHighAccuracy ?? true,
    timeout: o?.timeout,
    maximumAge: o?.maximumAge,
  });

  // Capacitor's watch id is a STRING that resolves ASYNC; the web API hands back a
  // number synchronously. Bridge the two, and handle a clearWatch() that races in
  // before the native watch id has resolved.
  const watchCapIds = new Map<number, string>();
  const clearedEarly = new Set<number>();
  let nextId = 1;

  const shim: Geolocation = {
    getCurrentPosition: (success, error, options) => {
      CapGeolocation.getCurrentPosition(opts(options))
        .then((p) => success(toPosition(p)))
        .catch((e) => error?.(toError(e)));
    },
    watchPosition: (success, error, options) => {
      const id = nextId++;
      CapGeolocation.watchPosition(opts(options), (p, err) => {
        if (err) { error?.(toError(err)); return; }
        if (p) success(toPosition(p));
      })
        .then((capId) => {
          // Cleared before the native id arrived → tear it down immediately.
          if (clearedEarly.has(id)) { void CapGeolocation.clearWatch({ id: capId }); clearedEarly.delete(id); return; }
          watchCapIds.set(id, capId);
        })
        .catch((e) => error?.(toError(e)));
      return id;
    },
    clearWatch: (id) => {
      const capId = watchCapIds.get(id);
      if (capId) { void CapGeolocation.clearWatch({ id: capId }); watchCapIds.delete(id); }
      else clearedEarly.add(id); // native id not back yet — clear it on arrival.
    },
  };

  try {
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: shim });
  } catch {
    // Some webviews lock navigator.geolocation — best-effort direct assign.
    try { (navigator as any).geolocation = shim; } catch { /* locked — stamp stays unverified */ }
  }
}
