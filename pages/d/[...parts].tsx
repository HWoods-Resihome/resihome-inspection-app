// Short share-link resolver: /d/<id>/<type>/<sig>  (and /d/<id>/v/<slug>/<sig>)
//
// Verifies the signature, looks up the real HubSpot file URL stored on the
// inspection, and 302-redirects to it. Public (no session) — see middleware.ts.
// Nothing renders; the redirect happens in getServerSideProps.

import type { GetServerSideProps } from 'next';
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

    // Resolve the real URL from the inspection's stored properties.
    const props = await readInspectionProps(id, [
      'pdf_master_url', 'pdf_chargeback_url', 'pdf_chargeback_xlsx_url', 'pdf_vendor_urls_json',
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
    return { redirect: { destination, permanent: false } };
  } catch {
    return notFound;
  }
};

export default function ShareRedirect() {
  // Never rendered (server-side redirect). Minimal fallback just in case.
  return null;
}
