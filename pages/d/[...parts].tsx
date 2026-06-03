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
import { readInspectionProps } from '@/lib/hubspot';
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
      destination = props[SHARE_TYPE_TO_PROP[type as Exclude<ShareDocType, 'vendor'>]] || '';
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

export default function ShareProxy() {
  // Never rendered — getServerSideProps streams the file (or redirects/404s).
  return null;
}
