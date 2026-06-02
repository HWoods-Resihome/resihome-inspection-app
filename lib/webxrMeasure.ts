/**
 * WebXR floor-area measurement (Android Chrome / ARCore).
 *
 * Sharpens the SF estimate: the inspector aims the phone at the floor and taps
 * to drop corner points; we compute the polygon area from the real-world AR
 * coordinates and return it in square feet. No 3D library — a minimal WebGL
 * clear-layer (required by the session) plus a DOM-overlay UI for the reticle
 * and buttons. Falls back to null on any unsupported step, so callers keep the
 * AI estimate.
 *
 * Android-only: iOS Safari does not ship WebXR, so isArMeasureSupported()
 * returns false there and the UI never offers it.
 */

const M2_TO_SF = 10.7639;

export async function isArMeasureSupported(): Promise<boolean> {
  try {
    const xr = (navigator as any)?.xr;
    if (!xr?.isSessionSupported) return false;
    return await xr.isSessionSupported('immersive-ar');
  } catch {
    return false;
  }
}

// Shoelace area (m²) on the XZ ground plane.
function polygonAreaXZ(pts: Array<{ x: number; z: number }>): number {
  if (pts.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.z - q.x * p.z;
  }
  return Math.abs(a) / 2;
}

/**
 * Launch the AR measure session. Resolves with square feet (rounded) or null
 * if cancelled / unsupported / failed. Pure DOM + WebXR; no external deps.
 */
export async function measureFloorAreaSF(): Promise<number | null> {
  const xr = (navigator as any)?.xr;
  if (!xr?.requestSession) return null;

  // --- WebGL clear-layer (the session requires a base layer) ---
  const canvas = document.createElement('canvas');
  const gl: any = canvas.getContext('webgl', { xrCompatible: true })
    || canvas.getContext('experimental-webgl', { xrCompatible: true });
  if (!gl) return null;

  // --- DOM overlay UI ---
  const root = document.createElement('div');
  root.style.cssText = 'position:fixed;inset:0;z-index:2147483647;font-family:Arial,sans-serif;pointer-events:none;';
  root.innerHTML = `
    <div style="position:absolute;top:0;left:0;right:0;padding:14px;background:linear-gradient(rgba(0,0,0,.55),transparent);color:#fff;text-align:center;font-size:14px" id="xrm-status">Aim at the floor, then tap “Add point”.</div>
    <div style="position:absolute;top:50%;left:50%;width:26px;height:26px;margin:-13px 0 0 -13px;border:3px solid #fff;border-radius:50%;box-shadow:0 0 0 2px rgba(0,0,0,.4)"></div>
    <div style="position:absolute;left:50%;top:50%;width:2px;height:14px;margin:-7px 0 0 -1px;background:#fff"></div>
    <div style="position:absolute;left:50%;top:50%;width:14px;height:2px;margin:-1px 0 0 -7px;background:#fff"></div>
    <div style="position:absolute;bottom:0;left:0;right:0;padding:16px;display:flex;gap:10px;justify-content:center;background:linear-gradient(transparent,rgba(0,0,0,.6));pointer-events:auto">
      <button id="xrm-cancel" style="flex:0 0 auto;padding:12px 16px;border:0;border-radius:10px;background:#ffffff22;color:#fff;font-weight:700">Cancel</button>
      <button id="xrm-undo" style="flex:0 0 auto;padding:12px 16px;border:0;border-radius:10px;background:#ffffff22;color:#fff;font-weight:700">Undo</button>
      <button id="xrm-add" style="flex:1 1 auto;padding:12px 16px;border:0;border-radius:10px;background:#7c3aed;color:#fff;font-weight:800">Add point</button>
      <button id="xrm-done" style="flex:0 0 auto;padding:12px 16px;border:0;border-radius:10px;background:#059669;color:#fff;font-weight:800">Done</button>
    </div>`;

  const statusEl = () => root.querySelector('#xrm-status') as HTMLElement | null;
  const points: Array<{ x: number; z: number }> = [];
  let latestHit: { x: number; y: number; z: number } | null = null;
  let session: any = null;
  let hitTestSource: any = null;
  let refSpace: any = null;
  let finished = false;

  const setStatus = (msg: string) => { const e = statusEl(); if (e) e.textContent = msg; };
  const updateStatus = () => {
    if (points.length === 0) setStatus(latestHit ? 'Tap “Add point” at the first corner.' : 'Move the phone so it sees the floor…');
    else {
      const sf = polygonAreaXZ(points) * M2_TO_SF;
      setStatus(`${points.length} corner${points.length === 1 ? '' : 's'}${points.length >= 3 ? ` · ~${Math.round(sf)} SF` : ' · need 3+'}`);
    }
  };

  return new Promise<number | null>((resolve) => {
    let settled = false;
    const finishWith = (val: number | null) => {
      if (settled) return;
      settled = true;
      finished = true;
      try { hitTestSource?.cancel?.(); } catch { /* noop */ }
      try { session?.end?.(); } catch { /* noop */ }
      try { root.remove(); } catch { /* noop */ }
      resolve(val);
    };

    const onFrame = (_t: number, frame: any) => {
      if (finished || !session) return;
      session.requestAnimationFrame(onFrame);
      try {
        const glLayer = session.renderState.baseLayer;
        gl.bindFramebuffer(gl.FRAMEBUFFER, glLayer.framebuffer);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); // transparent — AR passthrough shows through
        if (hitTestSource && refSpace) {
          const results = frame.getHitTestResults(hitTestSource);
          if (results.length > 0) {
            const pose = results[0].getPose(refSpace);
            if (pose) {
              const p = pose.transform.position;
              latestHit = { x: p.x, y: p.y, z: p.z };
            }
          } else {
            latestHit = null;
          }
        }
        updateStatus();
      } catch { /* frame hiccup — ignore */ }
    };

    (async () => {
      try {
        document.body.appendChild(root);
        session = await xr.requestSession('immersive-ar', {
          requiredFeatures: ['hit-test'],
          optionalFeatures: ['dom-overlay', 'local-floor'],
          domOverlay: { root },
        });
        const glLayer = new (window as any).XRWebGLLayer(session, gl);
        session.updateRenderState({ baseLayer: glLayer });

        // Prefer a floor-aligned space; fall back to local.
        try { refSpace = await session.requestReferenceSpace('local-floor'); }
        catch { refSpace = await session.requestReferenceSpace('local'); }
        const viewerSpace = await session.requestReferenceSpace('viewer');
        try {
          hitTestSource = await session.requestHitTestSource({ space: viewerSpace });
        } catch { hitTestSource = null; }

        // Buttons.
        root.querySelector('#xrm-add')!.addEventListener('click', () => {
          if (latestHit) { points.push({ x: latestHit.x, z: latestHit.z }); updateStatus(); }
          else setStatus('No floor detected yet — move closer / add light.');
        });
        root.querySelector('#xrm-undo')!.addEventListener('click', () => { points.pop(); updateStatus(); });
        root.querySelector('#xrm-cancel')!.addEventListener('click', () => finishWith(null));
        root.querySelector('#xrm-done')!.addEventListener('click', () => {
          if (points.length < 3) { setStatus('Add at least 3 corners.'); return; }
          const sf = Math.round(polygonAreaXZ(points) * M2_TO_SF);
          finishWith(sf > 0 ? sf : null);
        });

        session.addEventListener('end', () => finishWith(settled ? null : null));
        session.requestAnimationFrame(onFrame);
      } catch {
        finishWith(null);
      }
    })();
  });
}
