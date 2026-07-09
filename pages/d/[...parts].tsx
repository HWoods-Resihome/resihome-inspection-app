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
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { readInspectionProps, fetchAnswersForInspection, fetchInspectionById, fetchSourceSectionPhotos } from '@/lib/hubspot';
import { resolveSections } from '@/lib/sections';
import { finalChecklistPhotos } from '@/lib/finalChecklist';
import { verifyShareSig, slugifyVendor, SHARE_TYPE_TO_PROP, type ShareDocType } from '@/lib/shortLinks';
import { displayImageSrc } from '@/lib/photoDisplay';

// Room grouping for the QC gallery: each room carries its Before + After photo
// sets so the viewer can offer a room selector + a Before/After toggle. Only
// populated for reinspect QC (the only template with a Before/After split).
type RoomGroup = { name: string; before: string[]; after: string[] };

// Short-lived in-memory cache of resolved gallery photo lists (per lambda
// instance) so repeated opens of the same gallery don't re-query HubSpot.
const GALLERY_TTL_MS = 60_000;
const galleryCache = new Map<string, { photos: string[]; rooms: RoomGroup[] | null; at: number }>();

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
      // embed=1 → rendered inside the in-app PDF viewer overlay (which provides
      // its own close button), so the gallery hides its own × to avoid two.
      const embed = ctx.query.embed === '1';
      const cacheKey = `${id}:${kind}:${vSlug}`;
      const hit = galleryCache.get(cacheKey);
      if (hit && Date.now() - hit.at < GALLERY_TTL_MS) return { props: { photos: hit.photos, rooms: hit.rooms, start, embed } };

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
      // Answers whose section isn't in the resolved room list — e.g. "Review /
      // Sign-Off" or "Final Checklist" section photos — must STILL be in the
      // gallery (the PDF links them). Group them under a raw-name key and append
      // after the resolved sections, in first-seen order, so EVERY photo the PDF
      // shows is clickable and reachable by swiping.
      const extraOrder: string[] = [];
      const extraNames = new Map<string, string>();
      const keyFor = (a: any): string => {
        const s = resolve(a.section, a.location);
        if (s) return s.id;
        const k = `__extra__${a.section || ''}||${a.location || ''}`;
        if (!extraOrder.includes(k)) { extraOrder.push(k); extraNames.set(k, a.location || a.section || 'Other'); }
        return k;
      };
      // Final Checklist (HVAC & Air Filters, Smart Home Tech, …) persists as ONE
      // 'qa' record whose `note` is a JSON blob of the FcAnswers — its photos
      // (per-question + label-sticker slots) live there, NOT in photo_urls. The
      // PDF links every one of them into this gallery, so parse the blob and add
      // them (in the same order finalChecklistPhotos produces for the PDF).
      const fcPhotos: string[] = [];
      const isFcBlob = (a: any) =>
        a.questionIdExternal === 'fc__all' || String(a.answerIdExternal || '').startsWith('FINALCHECKLIST-');
      for (const a of (answers as any[]) || []) {
        if (isFcBlob(a)) {
          try {
            for (const u of finalChecklistPhotos(JSON.parse(a.note || '{}'))) if (ok(u)) fcPhotos.push(u);
          } catch { /* malformed FC blob → skip */ }
          continue;
        }
        if (a.answerType === 'section_photo') {
          const key = keyFor(a);
          const arr = bySection.get(key) || [];
          for (const u of [...(a.photoUrls || []), ...(a.afterPhotoUrls || [])]) if (ok(u)) arr.push(u);
          bySection.set(key, arr);
        } else if (a.answerType === 'qa') {
          // Q&A answers carry their own photos on 1099 / vacancy / community
          // reports (e.g. the per-question PHOTO REQUIRED tiles). Include them so
          // the gallery covers every photo the PDF links to.
          const key = keyFor(a);
          const arr = bySection.get(key) || [];
          for (const u of (a.photoUrls || [])) if (ok(u)) arr.push(u);
          bySection.set(key, arr);
        } else if (a.answerType === 'rate_card_line' && kind === 'vendor' && vSlug) {
          const s = resolve(a.section, a.location);
          if (!s) continue;
          if (slugifyVendor(a.assignedTo || '') !== vSlug) continue;
          const arr = afterBySection.get(s.id) || [];
          for (const u of (a.afterPhotoUrls || [])) if (ok(u)) arr.push(u);
          afterBySection.set(s.id, arr);
        }
      }
      // QC "Before" photos live on the SOURCE scope inspection (not this QC's own
      // answers), so they'd otherwise be missing from the gallery — the QC PDF
      // links each by URL, so a missing one silently falls back to photo #1 (the
      // bug: clicking a Before photo showed the first After set). Pull them in,
      // mapped to each section, and render them BEFORE the After photos to match
      // the PDF layout.
      const beforeBySection = new Map<string, string[]>();
      if (insp?.templateType === 'pm_turn_reinspect_qc' && insp.sourceRateCardId) {
        try {
          const beforeByLoc = await fetchSourceSectionPhotos(insp.sourceRateCardId);
          for (const s of sections) {
            const b = beforeByLoc[`${s.label}||${s.location}`] || (s.location ? beforeByLoc[s.location] : undefined) || beforeByLoc[s.label] || [];
            const clean = b.filter(ok);
            if (clean.length) beforeBySection.set(s.id, clean);
          }
        } catch { /* before photos unavailable — after photos still show */ }
      }
      const seen = new Set<string>();
      const photos: string[] = [];
      const pushKey = (key: string) => {
        for (const u of (beforeBySection.get(key) || [])) if (!seen.has(u)) { seen.add(u); photos.push(u); }
        for (const u of (bySection.get(key) || [])) if (!seen.has(u)) { seen.add(u); photos.push(u); }
        for (const u of (afterBySection.get(key) || [])) if (!seen.has(u)) { seen.add(u); photos.push(u); }
      };
      for (const s of sections) pushKey(s.id);     // resolved rooms, in section order
      for (const k of extraOrder) pushKey(k);       // Review/Sign-Off, etc.
      for (const u of fcPhotos) if (!seen.has(u)) { seen.add(u); photos.push(u); } // Final Checklist photos last (matches the PDF)

      // Reinspect QC: expose the per-room Before/After grouping so the gallery
      // can render a room selector + a Before/After toggle (left/right then
      // navigates within the active grouping across rooms). Other templates keep
      // the flat list — they have no Before/After split.
      let rooms: RoomGroup[] | null = null;
      if (insp?.templateType === 'pm_turn_reinspect_qc') {
        rooms = [];
        for (const s of sections) {
          const before = (beforeBySection.get(s.id) || []).filter(ok);
          const after = (bySection.get(s.id) || []).filter(ok);
          if (before.length || after.length) rooms.push({ name: s.displayName || s.label || 'Room', before, after });
        }
        for (const k of extraOrder) {
          const after = (bySection.get(k) || []).filter(ok);
          if (after.length) rooms.push({ name: extraNames.get(k) || 'Other', before: [], after });
        }
        const fc = fcPhotos.filter(ok);
        if (fc.length) rooms.push({ name: 'Final Checklist', before: [], after: fc });
      }

      galleryCache.set(cacheKey, { photos, rooms, at: Date.now() });
      return { props: { photos, rooms, start, embed } };
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

export default function ShareProxy(props: { photos?: string[]; rooms?: RoomGroup[] | null; start?: string; embed?: boolean }) {
  // File links stream in getServerSideProps and never render. The photo gallery
  // returns props and renders this browsable viewer.
  if (!props.photos) return null;
  // Reinspect QC: room selector + Before/After toggle over the grouped photos.
  if (props.rooms && props.rooms.length) {
    return <QcPhotoGallery rooms={props.rooms} start={props.start || ''} embed={!!props.embed} />;
  }
  return <PhotoGallery photos={props.photos} start={props.start || ''} embed={!!props.embed} />;
}

// Close → back to the PDF (the page the photo link came from). Hidden in embed
// mode: the in-app PDF viewer overlay provides its own close.
function CloseButton() {
  return (
    <button
      onClick={() => { if (typeof window !== 'undefined') { if (window.history.length > 1) window.history.back(); else window.close(); } }}
      aria-label="Back to PDF" title="Back to PDF"
      style={{ position: 'absolute', top: 10, right: 12, width: 40, height: 40, borderRadius: 999, border: 'none', cursor: 'pointer', background: 'rgba(0,0,0,0.5)', color: '#fff', fontSize: 24, lineHeight: '38px', zIndex: 3 }}
    >×</button>
  );
}

// Shared full-screen photo stage: one image with pinch / double-tap zoom + pan,
// left/right (arrows, keyboard ←/→, swipe) delegated to onPrev/onNext, and
// neighbor preloading. `children` render as an overlay above the image (counter,
// close, room controls). Nav is driven by the parent so both the flat gallery
// and the QC room/before-after gallery can reuse it.
function PhotoStage({ src, preloadSrcs, canPrev, canNext, onPrev, onNext, children }: {
  src: string; preloadSrcs: string[]; canPrev: boolean; canNext: boolean;
  onPrev: () => void; onNext: () => void; children?: ReactNode;
}) {
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const g = useRef({ swipeX: 0, pinchDist: 0, pinchScale: 1, panX: 0, panY: 0, sx: 0, sy: 0, lastTap: 0, moved: false });
  const resetZoom = () => { setScale(1); setPan({ x: 0, y: 0 }); };

  // Reset zoom/pan whenever the displayed photo changes.
  useEffect(() => { resetZoom(); }, [src]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') onPrev();
      else if (e.key === 'ArrowRight') onNext();
      else if (e.key === 'Escape') resetZoom();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onPrev, onNext]);

  // Preload the neighbours so left/right is instant.
  const preloadKey = preloadSrcs.join('|');
  useEffect(() => {
    preloadSrcs.forEach((u) => { if (u && typeof Image !== 'undefined') { const im = new Image(); im.src = displayImageSrc(u); } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preloadKey]);

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
      if (d < -50) onNext(); else if (d > 50) onPrev();
    }
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', touchAction: 'none' }}
      onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
      onDoubleClick={() => { setScale((s) => (s > 1 ? 1 : 2.5)); setPan({ x: 0, y: 0 }); }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={displayImageSrc(src)} alt="" draggable={false}
        style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`, transition: g.current.moved ? 'none' : 'transform 150ms ease-out', cursor: scale > 1 ? 'grab' : 'default' }} />
      {children}
      {canPrev && scale <= 1.02 && (
        <button onClick={onPrev} aria-label="Previous" style={navBtn('left')}>‹</button>
      )}
      {canNext && scale <= 1.02 && (
        <button onClick={onNext} aria-label="Next" style={navBtn('right')}>›</button>
      )}
    </div>
  );
}

// Public, dependency-free photo gallery: continuous across all photos; arrows
// hide only at first/last. Used for every doc type except reinspect QC.
function PhotoGallery({ photos, start, embed }: { photos: string[]; start: string; embed?: boolean }) {
  const foundIdx = photos.indexOf(start);
  const [i, setI] = useState(foundIdx >= 0 ? foundIdx : 0);
  const go = (n: number) => setI(Math.max(0, Math.min(photos.length - 1, n)));

  if (photos.length === 0) {
    return <div style={{ minHeight: '100vh', background: '#000', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', font: '14px sans-serif' }}>No photos for this inspection.</div>;
  }

  return (
    <PhotoStage
      src={photos[i]}
      preloadSrcs={[photos[i - 1], photos[i + 1]].filter(Boolean) as string[]}
      canPrev={i > 0} canNext={i < photos.length - 1}
      onPrev={() => go(i - 1)} onNext={() => go(i + 1)}
    >
      <div style={{ position: 'absolute', top: 12, left: 0, right: 0, textAlign: 'center', color: '#fff', font: '600 13px sans-serif', opacity: 0.85, zIndex: 2 }}>{i + 1} / {photos.length}</div>
      {!embed && <CloseButton />}
    </PhotoStage>
  );
}

type SeqItem = { url: string; roomIdx: number };

// Reinspect QC gallery: a room selector + a Before/After toggle sit on top, and
// left/right navigates within the ACTIVE grouping (all Before photos across
// rooms, or all After photos across rooms) — crossing room boundaries just like
// the flat gallery, but never mixing Before with After. Toggling keeps you on
// the same room when it has photos in the other grouping; picking a room jumps
// there (auto-switching grouping if that room only has photos in the other one).
function QcPhotoGallery({ rooms, start, embed }: { rooms: RoomGroup[]; start: string; embed?: boolean }) {
  const beforeSeq = useMemo<SeqItem[]>(() => {
    const out: SeqItem[] = [];
    rooms.forEach((r, ri) => r.before.forEach((url) => out.push({ url, roomIdx: ri })));
    return out;
  }, [rooms]);
  const afterSeq = useMemo<SeqItem[]>(() => {
    const out: SeqItem[] = [];
    rooms.forEach((r, ri) => r.after.forEach((url) => out.push({ url, roomIdx: ri })));
    return out;
  }, [rooms]);
  const hasBefore = beforeSeq.length > 0;
  const hasAfter = afterSeq.length > 0;

  // Initial grouping + index from the clicked photo (`start`); fall back to the
  // first After photo, else the first Before photo.
  const [nav, setNav] = useState<{ mode: 'before' | 'after'; i: number }>(() => {
    const b = beforeSeq.findIndex((it) => it.url === start);
    if (b >= 0) return { mode: 'before', i: b };
    const a = afterSeq.findIndex((it) => it.url === start);
    if (a >= 0) return { mode: 'after', i: a };
    if (hasAfter) return { mode: 'after', i: 0 };
    return { mode: 'before', i: 0 };
  });
  const { mode, i } = nav;
  const seq = mode === 'before' ? beforeSeq : afterSeq;
  const curRoom = seq[i]?.roomIdx ?? 0;

  // Keep the active room pill centered in the scroller as navigation moves
  // between rooms, so the next/previous room is visible approaching the centre
  // and the highlight tracks the photo you're on.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const activePillRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = activePillRef.current, sc = scrollerRef.current;
    if (!el || !sc || typeof el.getBoundingClientRect !== 'function') return;
    const er = el.getBoundingClientRect(), cr = sc.getBoundingClientRect();
    const delta = (er.left + er.width / 2) - (cr.left + cr.width / 2);
    if (Math.abs(delta) > 1) sc.scrollBy({ left: delta, behavior: 'smooth' });
  }, [curRoom, mode]);

  if (seq.length === 0) {
    return <div style={{ minHeight: '100vh', background: '#000', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', font: '14px sans-serif' }}>No photos for this inspection.</div>;
  }

  const clamp = (n: number, len: number) => Math.max(0, Math.min(len - 1, n));
  const go = (n: number) => setNav((v) => ({ mode: v.mode, i: clamp(n, (v.mode === 'before' ? beforeSeq : afterSeq).length) }));

  const switchMode = (m: 'before' | 'after') => {
    if (m === mode) return;
    const target = m === 'before' ? beforeSeq : afterSeq;
    if (!target.length) return;
    const curRoom = seq[i]?.roomIdx ?? 0;
    const idx = target.findIndex((it) => it.roomIdx === curRoom);
    setNav({ mode: m, i: idx >= 0 ? idx : 0 });
  };

  const selectRoom = (ri: number) => {
    const idx = seq.findIndex((it) => it.roomIdx === ri);
    if (idx >= 0) { setNav((v) => ({ mode: v.mode, i: idx })); return; }
    // Room has nothing in the current grouping — switch to the other one.
    const other: 'before' | 'after' = mode === 'before' ? 'after' : 'before';
    const otherSeq = other === 'before' ? beforeSeq : afterSeq;
    const oidx = otherSeq.findIndex((it) => it.roomIdx === ri);
    if (oidx >= 0) setNav({ mode: other, i: oidx });
  };

  const roomName = rooms[curRoom]?.name || 'Room';
  const roomStart = seq.findIndex((it) => it.roomIdx === curRoom);
  const roomCount = seq.reduce((n, it) => n + (it.roomIdx === curRoom ? 1 : 0), 0);
  const posInRoom = i - roomStart + 1;
  const stop = (e: React.TouchEvent) => e.stopPropagation();

  return (
    <PhotoStage
      src={seq[i].url}
      preloadSrcs={[seq[i - 1]?.url, seq[i + 1]?.url].filter(Boolean) as string[]}
      canPrev={i > 0} canNext={i < seq.length - 1}
      onPrev={() => go(i - 1)} onNext={() => go(i + 1)}
    >
      {/* Hide the native horizontal scrollbar on the room pills (it otherwise
          renders over the pill text). Auto-centering + swipe cover discovery. */}
      <style>{`.qc-rooms::-webkit-scrollbar{display:none}`}</style>
      {/* Top controls: label, Before/After toggle, room pills. */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '10px 8px 14px', background: 'linear-gradient(to bottom, rgba(0,0,0,0.6), rgba(0,0,0,0))', pointerEvents: 'none', zIndex: 2 }}>
        <div style={{ color: '#fff', font: '600 13px sans-serif', opacity: 0.9, textAlign: 'center', paddingLeft: embed ? 0 : 44, paddingRight: embed ? 0 : 44 }}>
          {roomName}{roomCount > 1 ? ` · ${posInRoom} / ${roomCount}` : ''}
        </div>
        {hasBefore && hasAfter && (
          <div onTouchStart={stop} onTouchMove={stop} onTouchEnd={stop}
            style={{ display: 'flex', background: 'rgba(255,255,255,0.15)', borderRadius: 999, padding: 3, pointerEvents: 'auto' }}>
            {(['before', 'after'] as const).map((m) => (
              <button key={m} onClick={() => switchMode(m)}
                style={{ border: 'none', cursor: 'pointer', borderRadius: 999, padding: '6px 18px', font: '600 13px sans-serif', color: mode === m ? '#fff' : 'rgba(255,255,255,0.75)', background: mode === m ? '#ff0060' : 'transparent' }}>
                {m === 'before' ? 'Before' : 'After'}
              </button>
            ))}
          </div>
        )}
        <div ref={scrollerRef} className="qc-rooms" onTouchStart={stop} onTouchMove={stop} onTouchEnd={stop}
          style={{ display: 'flex', gap: 6, overflowX: 'auto', maxWidth: '100%', padding: '4px', pointerEvents: 'auto', touchAction: 'pan-x', WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none', msOverflowStyle: 'none' } as CSSProperties}>
          {rooms.map((r, ri) => (
            <button key={ri} ref={ri === curRoom ? activePillRef : undefined} onClick={() => selectRoom(ri)}
              style={{ whiteSpace: 'nowrap', flex: '0 0 auto', border: 'none', cursor: 'pointer', borderRadius: 999, padding: '6px 12px', font: '600 12px sans-serif', color: ri === curRoom ? '#fff' : 'rgba(255,255,255,0.8)', background: ri === curRoom ? '#ff0060' : 'rgba(255,255,255,0.15)' }}>
              {r.name}
            </button>
          ))}
        </div>
      </div>
      {!embed && <CloseButton />}
    </PhotoStage>
  );
}

function navBtn(side: 'left' | 'right'): CSSProperties {
  return {
    position: 'absolute', top: '50%', transform: 'translateY(-50%)', [side]: 12,
    width: 48, height: 48, borderRadius: 999, border: 'none', cursor: 'pointer',
    background: 'rgba(0,0,0,0.45)', color: '#fff', fontSize: 30, lineHeight: '44px',
  };
}
