// Short share-link resolver: /d/<id>/<type>/<sig>  (and /d/<id>/v/<slug>/<sig>)
//
// Verifies the signature, looks up the real HubSpot file URL stored on the
// inspection, and forwards to it. Public (no session) — see middleware.ts.
//
// We render a tiny branded interstitial (instead of a bare server 302) so the
// page carries our favicon/title (from _document) while it forwards — link
// previews + the loading tab show ResiWalk branding. The forward is immediate
// (meta refresh at 0s + JS replace), with a manual link as a no-JS fallback.

import type { GetServerSideProps } from 'next';
import Head from 'next/head';
import { useEffect } from 'react';
import { readInspectionProps } from '@/lib/hubspot';
import { verifyShareSig, slugifyVendor, SHARE_TYPE_TO_PROP, type ShareDocType } from '@/lib/shortLinks';

interface Props { destination: string | null }

export const getServerSideProps: GetServerSideProps<Props> = async (ctx) => {
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

    // Content-negotiate: a real browser navigation sends `Accept: text/html` —
    // give it the branded interstitial (favicon/title) that forwards. Anything
    // else (fetch() for blob downloads, link-fetchers, curl) gets a clean 302 to
    // the file so programmatic downloads still work.
    const accept = String(ctx.req.headers['accept'] || '');
    if (!accept.includes('text/html')) {
      return { redirect: { destination, permanent: false } };
    }
    return { props: { destination } };
  } catch {
    return notFound;
  }
};

export default function ShareRedirect({ destination }: Props) {
  useEffect(() => {
    if (destination) window.location.replace(destination);
  }, [destination]);

  return (
    <>
      <Head>
        <title>ResiWalk — Opening document…</title>
        {/* favicon links also come from _document; repeated here so the tab/
            preview shows our brand on this forwarding page too. */}
        <link rel="icon" type="image/svg+xml" href="/favicon.svg?v=2" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png?v=2" />
        {destination ? <meta httpEquiv="refresh" content={`0;url=${destination}`} /> : null}
        <meta name="robots" content="noindex" />
      </Head>
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', color: '#374151',
        background: '#ffffff', textAlign: 'center', padding: 24,
      }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Opening your document…</div>
          {destination ? (
            <a href={destination} style={{ color: '#ff0060', fontSize: 13, textDecoration: 'underline' }}>
              Click here if it doesn’t open automatically
            </a>
          ) : null}
        </div>
      </div>
    </>
  );
}
