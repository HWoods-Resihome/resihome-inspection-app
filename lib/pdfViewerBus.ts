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

/** Open the given PDF in the in-app viewer. No-op during SSR. */
export function openPdf(url: string, title?: string): void {
  if (typeof window === 'undefined' || !url) return;
  window.dispatchEvent(new CustomEvent<OpenPdfDetail>(PDF_OPEN_EVENT, { detail: { url, title } }));
}
