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
import { readInspectionProps, fetchAnswersForInspection } from '@/lib/hubspot';
import { verifyShareSig, slugifyVendor, SHARE_TYPE_TO_PROP, type ShareDocType } from '@/lib/shortLinks';

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
      const answers = await fetchAnswersForInspection(id).catch(() => [] as any[]);
      const seen = new Set<string>();
      const photos: string[] = [];
      // Mirror the photos the PDFs actually render: the per-section photos
      // (section_photo answers). Excludes line-tagged photos so the gallery
      // count matches what's shown on the PDF.
      for (const a of (answers as any[]) || []) {
        if (a.answerType !== 'section_photo') continue;
        for (const u of [...(a.photoUrls || []), ...(a.afterPhotoUrls || [])]) {
          if (typeof u === 'string' && u && !u.startsWith('blob:') && !seen.has(u)) { seen.add(u); photos.push(u); }
        }
      }
      const start = typeof ctx.query.u === 'string' ? ctx.query.u : '';
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
    const fileResp = await fetch(destination);
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
    ctx.res.setHeader('Cache-Control', 'private, max-age=300');
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
// (arrows, keyboard ←/→, and swipe). Continuous across all the inspection's
// photos; arrows hide only at the very first/last.
function PhotoGallery({ photos, start }: { photos: string[]; start: string }) {
  const foundIdx = photos.indexOf(start);
  const [i, setI] = useState(foundIdx >= 0 ? foundIdx : 0);
  const touchStart = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') setI((n) => Math.max(0, n - 1));
      else if (e.key === 'ArrowRight') setI((n) => Math.min(photos.length - 1, n + 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [photos.length]);

  if (photos.length === 0) {
    return <div style={{ minHeight: '100vh', background: '#000', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', font: '14px sans-serif' }}>No photos for this inspection.</div>;
  }
  const prev = () => setI((n) => Math.max(0, n - 1));
  const next = () => setI((n) => Math.min(photos.length - 1, n + 1));
  return (
    <div
      style={{ position: 'fixed', inset: 0, background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', touchAction: 'pan-y' }}
      onTouchStart={(e) => { touchStart.current = e.touches[0].clientX; }}
      onTouchEnd={(e) => { const d = e.changedTouches[0].clientX - touchStart.current; if (d < -50) next(); else if (d > 50) prev(); }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={photos[i]} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
      <div style={{ position: 'absolute', top: 12, left: 0, right: 0, textAlign: 'center', color: '#fff', font: '600 13px sans-serif', opacity: 0.85 }}>{i + 1} / {photos.length}</div>
      {/* Close → back to the PDF (the page the photo link came from). */}
      <button
        onClick={() => { if (typeof window !== 'undefined') { if (window.history.length > 1) window.history.back(); else window.close(); } }}
        aria-label="Back to PDF"
        title="Back to PDF"
        style={{ position: 'absolute', top: 10, right: 12, width: 40, height: 40, borderRadius: 999, border: 'none', cursor: 'pointer', background: 'rgba(0,0,0,0.5)', color: '#fff', fontSize: 24, lineHeight: '38px' }}
      >×</button>
      {i > 0 && (
        <button onClick={prev} aria-label="Previous" style={navBtn('left')}>‹</button>
      )}
      {i < photos.length - 1 && (
        <button onClick={next} aria-label="Next" style={navBtn('right')}>›</button>
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
