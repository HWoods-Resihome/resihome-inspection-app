// App-wide host for the in-app PDF viewer. Mounted once in _app.tsx; listens on
// the pdfViewerBus and renders <PdfViewer> over everything when openPdf() fires.
// pdf.js is heavy, so the viewer is loaded lazily only when first opened.

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { PDF_OPEN_EVENT, type OpenPdfDetail } from '@/lib/pdfViewerBus';

const PdfViewer = dynamic(() => import('@/components/PdfViewer'), { ssr: false });

export function PdfViewerHost() {
  const [doc, setDoc] = useState<OpenPdfDetail | null>(null);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<OpenPdfDetail>).detail;
      if (detail?.url) setDoc(detail);
    };
    window.addEventListener(PDF_OPEN_EVENT, onOpen as EventListener);
    return () => window.removeEventListener(PDF_OPEN_EVENT, onOpen as EventListener);
  }, []);

  if (!doc) return null;
  return <PdfViewer url={doc.url} title={doc.title} onClose={() => setDoc(null)} />;
}
