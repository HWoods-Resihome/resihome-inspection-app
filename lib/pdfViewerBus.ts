// Tiny app-wide bus for opening PDFs in the in-app viewer overlay.
//
// Any "view PDF" affordance calls openPdf(url, title); a single <PdfViewer>
// mounted in _app.tsx listens and renders the overlay. This keeps PDF viewing
// INSIDE the app (no new browser tab) so the device/browser back button — and
// the native Android back gesture — just closes the PDF and returns to the last
// screen instead of exiting the app. The overlay is backed by a pushed history
// entry, so "back" pops it everywhere (PWA, plain browser, and the native shell).

export const PDF_OPEN_EVENT = 'resiwalk:open-pdf';

export interface OpenPdfDetail {
  url: string;
  title?: string;
}

/** Open the given PDF in the in-app viewer. No-op during SSR.
 *
 *  Appends a per-open cache-buster. The report link (/d/<id>/report/<sig>) is a
 *  STABLE url, so after a regenerate the browser / pdf.js would otherwise reuse
 *  the previously-loaded (old) document cached under that identical url — even
 *  though the server resolves the fresh file. A unique query each open forces a
 *  fresh fetch. Harmless downstream: the /d resolver reads route params (ignores
 *  extra query), and HubSpot file urls ignore it too. */
export function openPdf(url: string, title?: string): void {
  if (typeof window === 'undefined' || !url) return;
  const busted = `${url}${url.includes('?') ? '&' : '?'}_cb=${Date.now()}`;
  window.dispatchEvent(new CustomEvent<OpenPdfDetail>(PDF_OPEN_EVENT, { detail: { url: busted, title } }));
}
