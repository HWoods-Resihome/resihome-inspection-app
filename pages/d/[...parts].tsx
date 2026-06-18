// Short share-link resolver/proxy: /d/<id>/<type>/<sig>  (+ /d/<id>/v/<slug>/<sig>)
//
// Verifies the signature, looks up the real HubSpot file URL stored on the
// inspection, then STREAMS the file back through our domain so the browser
// stays on the clean resiwalk.com/d/... URL (instead of redirecting and
// exposing the giant HubSpot URL). Streaming (not buffering) so large PDFs
// aren't capped by the serverless buffered-response limit. Public — see
// middleware.ts. On any failure we fall back to a redirect so the file is still
// reachable.

import type { GetServerSideProps } from 'next';
import { Readable } from 'stream';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { readInspectionProps, fetchAnswersForInspection, fetchInspectionById } from '@/lib/hubspot';
import { resolveSections } from '@/lib/sections';
import { verifyShareSig, slugifyVendor, SHARE_TYPE_TO_PROP, type ShareDocType } from '@/lib/shortLinks';
import { displayImageSrc } from '@/lib/photoDisplay';

// Short-lived in-memory cache of resolved gallery photo lists (per lambda
// instance) so repeated opens of the same gallery don't re-query HubSpot.
const GALLERY_TTL_MS = 60_000;
const galleryCache = new Map<string, { photos: string[]; at: number }>();

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const parts = (ctx.params?.parts as string[]) || [];
  const notFound = { notFound: true as const };

  try {
    // Vendor form: [id, 'v', vendorSlug, sig]; others: [id, type, sig]
    let id = '';
    let type: ShareDocType | '' = '';
    let vendorSlug = '';
    let sig = '';

    if (parts.length === 4 && parts[1] === 'v') {
      [id, , vendorSlug, sig] = parts;
      type = 'vendor';
    } else if (parts.length === 3) {
      [id, type as any, sig] = parts as [string, ShareDocType, string];
    } else {
      return notFound;
    }

    if (!id || !type || !sig) return notFound;
    if (!verifyShareSig(id, type as ShareDocType, sig, type === 'vendor' ? vendorSlug : '')) return notFound;

    // Photo gallery: render a browsable viewer over ALL the inspection's photos
    // (left/right), starting at the clicked one. The signed link grants access,
    // so external email recipients (no login) can use it.
    if ((type as string) === 'photos') {
      // Mirror the PDF the photo was clicked from, grouped + ordered by the same
      // section list the PDF renders (so the first photo is gallery #1 and the
      // count matches). `k` scopes per-PDF: default/qc = section photos; vendor =
      // section photos + that vendor's line after-photos. Short TTL cache so
      // repeated opens don't re-hit HubSpot.
      const kind = typeof ctx.query.k === 'string' ? ctx.query.k : '';
      const vSlug = typeof ctx.query.v === 'string' ? ctx.query.v : '';
      const start = typeof ctx.query.u === 'string' ? ctx.query.u : '';
      const cacheKey = `${id}:${kind}:${vSlug}`;
      const hit = galleryCache.get(cacheKey);
      if (hit && Date.now() - hit.at < GALLERY_TTL_MS) return { props: { photos: hit.photos, start } };

      const [insp, answers] = await Promise.all([
        fetchInspectionById(id).catch(() => null),
        fetchAnswersForInspection(id).catch(() => [] as any[]),
      ]);
      const sections = resolveSections(insp?.sectionListJson, insp?.bedroomsAtInspection || 0, insp?.bathroomsAtInspection || 0);
      const lookup = new Map<string, { id: string }>();
      for (const s of sections) {
        lookup.set(`${s.label}||${s.location}`, s);
        if (s.location) lookup.set(s.location, s);
      }
      const resolve = (sec: string, loc: string) => lookup.get(`${sec}||${loc}`) || (loc ? lookup.get(loc) : undefined);
      const ok = (u: any) => typeof u === 'string' && u && !u.startsWith('blob:');
      const bySection = new Map<string, string[]>();
      const afterBySection = new Map<string, string[]>();
      for (const a of (answers as any[]) || []) {
        const s = resolve(a.section, a.location);
        if (!s) continue;
        if (a.answerType === 'section_photo') {
          const arr = bySection.get(s.id) || [];
          for (const u of [...(a.photoUrls || []), ...(a.afterPhotoUrls || [])]) if (ok(u)) arr.push(u);
          bySection.set(s.id, arr);
        } else if (a.answerType === 'rate_card_line' && kind === 'vendor' && vSlug) {
          if (slugifyVendor(a.assignedTo || '') !== vSlug) continue;
          const arr = afterBySection.get(s.id) || [];
          for (const u of (a.afterPhotoUrls || [])) if (ok(u)) arr.push(u);
          afterBySection.set(s.id, arr);
        }
      }
      const seen = new Set<string>();
      const photos: string[] = [];
      for (const s of sections) {
        for (const u of (bySection.get(s.id) || [])) if (!seen.has(u)) { seen.add(u); photos.push(u); }
        for (const u of (afterBySection.get(s.id) || [])) if (!seen.has(u)) { seen.add(u); photos.push(u); }
      }
      galleryCache.set(cacheKey, { photos, at: Date.now() });
      return { props: { photos, start } };
    }

    const props = await readInspectionProps(id, [
      'pdf_master_url', 'pdf_chargeback_url', 'pdf_chargeback_xlsx_url', 'pdf_vendor_urls_json',
      'pdf_attachment_url',
    ]);
    if (!props) return notFound;

    let destination = '';
    if (type === 'vendor') {
      try {
        const map = JSON.parse(props.pdf_vendor_urls_json || '{}') || {};
        for (const [vendor, url] of Object.entries(map)) {
          if (slugifyVendor(vendor) === vendorSlug && typeof url === 'string') { destination = url; break; }
        }
      } catch { /* malformed json → not found */ }
    } else {
      destination = props[SHARE_TYPE_TO_PROP[type as Exclude<ShareDocType, 'vendor' | 'photos'>]] || '';
    }

    if (!destination) return notFound;

    // Proxy the file so the clean URL stays in the address bar.
    // Cache-bust the upstream fetch: regenerated PDFs are OVERWRITTEN in place
    // (uploadFileWithId keeps the same HubSpot URL), so HubSpot's file CDN can
    // keep serving the previous bytes long after a regen. A unique query param +
    // no-store forces the freshest file on every view so completed-inspection
    // links never resolve to a stale PDF.
    const bust = `${destination.includes('?') ? '&' : '?'}cb=${Date.now()}`;
    const fileResp = await fetch(destination + bust, { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } });
    if (!fileResp.ok || !fileResp.body) {
      // Couldn't fetch — fall back to a redirect so the file is still reachable.
      return { redirect: { destination, permanent: false } };
    }

    const contentType = fileResp.headers.get('content-type') || 'application/pdf';
    let filename = 'document.pdf';
    try {
      const seg = new URL(destination).pathname.split('/').pop();
      if (seg) filename = decodeURIComponent(seg);
    } catch { /* keep default */ }

    ctx.res.setHeader('Content-Type', contentType);
    // inline → view in the browser tab at the clean URL; clients can still save.
    ctx.res.setHeader('Content-Disposition', `inline; filename="${filename.replace(/["\\]/g, '')}"`);
    // Don't let the browser cache the streamed bytes — otherwise a regenerated
    // PDF would keep showing the previously-viewed version from cache.
    ctx.res.setHeader('Cache-Control', 'no-store, must-revalidate');
    const len = fileResp.headers.get('content-length');
    if (len) ctx.res.setHeader('Content-Length', len);

    await new Promise<void>((resolve, reject) => {
      const nodeStream = Readable.fromWeb(fileResp.body as any);
      nodeStream.on('error', reject);
      ctx.res.on('error', reject);
      ctx.res.on('finish', resolve);
      nodeStream.pipe(ctx.res);
    });

    // Response already streamed; nothing to render.
    return { props: {} };
  } catch {
    return notFound;
  }
};

export default function ShareProxy(props: { photos?: string[]; start?: string }) {
  // File links stream in getServerSideProps and never render. The photo gallery
  // returns props and renders this browsable viewer.
  if (!props.photos) return null;
  return <PhotoGallery photos={props.photos} start={props.start || ''} />;
}

// Public, dependency-free photo gallery: full-screen image with left/right
// (arrows, keyboard ←/→, swipe), pinch / double-tap zoom + pan, and neighbor
// preloading. Continuous across all photos; arrows hide only at first/last.
function PhotoGallery({ photos, start }: { photos: string[]; start: string }) {
  const foundIdx = photos.indexOf(start);
  const [i, setI] = useState(foundIdx >= 0 ? foundIdx : 0);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  // Gesture bookkeeping.
  const g = useRef({ swipeX: 0, pinchDist: 0, pinchScale: 1, panX: 0, panY: 0, sx: 0, sy: 0, lastTap: 0, moved: false });

  const resetZoom = () => { setScale(1); setPan({ x: 0, y: 0 }); };
  const go = (n: number) => { setI(Math.max(0, Math.min(photos.length - 1, n))); resetZoom(); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') go(i - 1);
      else if (e.key === 'ArrowRight') go(i + 1);
      else if (e.key === 'Escape') resetZoom();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i, photos.length]);

  // Preload the neighbours so left/right is instant.
  useEffect(() => {
    [i - 1, i + 1].forEach((n) => {
      if (n >= 0 && n < photos.length && typeof Image !== 'undefined') { const im = new Image(); im.src = displayImageSrc(photos[n]); }
    });
  }, [i, photos]);

  if (photos.length === 0) {
    return <div style={{ minHeight: '100vh', background: '#000', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', font: '14px sans-serif' }}>No photos for this inspection.</div>;
  }

  const dist = (t: { [k: number]: { clientX: number; clientY: number } }) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches;
    g.current.moved = false;
    if (t.length === 2) {
      g.current.pinchDist = dist(t); g.current.pinchScale = scale;
    } else if (t.length === 1) {
      g.current.swipeX = t[0].clientX; g.current.sx = t[0].clientX; g.current.sy = t[0].clientY;
      g.current.panX = pan.x; g.current.panY = pan.y;
    }
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const t = e.touches;
    if (t.length === 2 && g.current.pinchDist > 0) {
      g.current.moved = true;
      const next = Math.max(1, Math.min(5, g.current.pinchScale * (dist(t) / g.current.pinchDist)));
      setScale(next);
    } else if (t.length === 1 && scale > 1) {
      g.current.moved = true;
      setPan({ x: g.current.panX + (t[0].clientX - g.current.sx), y: g.current.panY + (t[0].clientY - g.current.sy) });
    } else if (t.length === 1) {
      if (Math.abs(t[0].clientX - g.current.sx) > 6) g.current.moved = true;
    }
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    // Double-tap toggles zoom.
    const now = Date.now();
    if (!g.current.moved && e.touches.length === 0) {
      if (now - g.current.lastTap < 300) { setScale((s) => (s > 1 ? 1 : 2.5)); if (scale > 1) setPan({ x: 0, y: 0 }); g.current.lastTap = 0; return; }
      g.current.lastTap = now;
    }
    if (scale <= 1.02) { resetZoom(); }
    // Swipe nav only when not zoomed.
    if (scale <= 1.02 && e.changedTouches.length) {
      const d = e.changedTouches[0].clientX - g.current.swipeX;
      if (d < -50) go(i + 1); else if (d > 50) go(i - 1);
    }
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', touchAction: 'none' }}
      onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
      onDoubleClick={() => { setScale((s) => (s > 1 ? 1 : 2.5)); setPan({ x: 0, y: 0 }); }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={displayImageSrc(photos[i])} alt="" draggable={false}
        style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`, transition: g.current.moved ? 'none' : 'transform 150ms ease-out', cursor: scale > 1 ? 'grab' : 'default' }} />
      <div style={{ position: 'absolute', top: 12, left: 0, right: 0, textAlign: 'center', color: '#fff', font: '600 13px sans-serif', opacity: 0.85 }}>{i + 1} / {photos.length}</div>
      {/* Close → back to the PDF (the page the photo link came from). */}
      <button
        onClick={() => { if (typeof window !== 'undefined') { if (window.history.length > 1) window.history.back(); else window.close(); } }}
        aria-label="Back to PDF" title="Back to PDF"
        style={{ position: 'absolute', top: 10, right: 12, width: 40, height: 40, borderRadius: 999, border: 'none', cursor: 'pointer', background: 'rgba(0,0,0,0.5)', color: '#fff', fontSize: 24, lineHeight: '38px' }}
      >×</button>
      {i > 0 && scale <= 1.02 && (
        <button onClick={() => go(i - 1)} aria-label="Previous" style={navBtn('left')}>‹</button>
      )}
      {i < photos.length - 1 && scale <= 1.02 && (
        <button onClick={() => go(i + 1)} aria-label="Next" style={navBtn('right')}>›</button>
      )}
    </div>
  );
}

function navBtn(side: 'left' | 'right'): CSSProperties {
  return {
    position: 'absolute', top: '50%', transform: 'translateY(-50%)', [side]: 12,
    width: 48, height: 48, borderRadius: 999, border: 'none', cursor: 'pointer',
    background: 'rgba(0,0,0,0.45)', color: '#fff', fontSize: 30, lineHeight: '44px',
  };
}
