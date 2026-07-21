/**
 * Convert a Word (.docx) document to a PDF buffer, server-side, so a vendor's
 * Word "proof of service" invoice can be reviewed by the AI the same way a PDF
 * proof is (the Anthropic document block only accepts PDF, not .docx).
 *
 * Pure-JS + serverless-safe: `mammoth` extracts the document's text and embedded
 * images (no LibreOffice/headless binary needed, which Vercel doesn't provide),
 * then react-pdf lays them out into a simple, faithful-enough PDF. Legacy binary
 * .doc is NOT supported by mammoth — those return null and route to human review.
 */
import mammoth from 'mammoth';
import sharp from 'sharp';
import React from 'react';
import { Document, Page, Text, View, Image, StyleSheet, renderToBuffer } from '@react-pdf/renderer';

const s = StyleSheet.create({
  page: { padding: 36, fontSize: 10, fontFamily: 'Helvetica', color: '#111', lineHeight: 1.4 },
  title: { fontSize: 12, fontFamily: 'Helvetica-Bold', marginBottom: 8, color: '#111' },
  para: { marginBottom: 5 },
  img: { marginTop: 6, marginBottom: 6, maxWidth: '100%', objectFit: 'contain' },
});

// Strip the mammoth HTML down to readable, paragraph-separated plain text. Block
// tags become line breaks; entities are decoded; runs of whitespace collapse.
function htmlToText(html: string): string {
  return String(html || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|table|ul|ol)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map((l) => l.trim()).join('\n')
    .trim();
}

/** Returns a PDF Buffer for a .docx, or null if it can't be parsed/rendered. */
export async function docxBufferToPdf(buf: Buffer): Promise<Buffer | null> {
  try {
    const images: string[] = [];   // data URIs, downscaled to keep the PDF light
    const { value: html } = await mammoth.convertToHtml({ buffer: buf }, {
      // Collect each embedded image (downscaled JPEG) for the PDF; return an empty
      // src so the HTML stays lightweight (we render images separately below).
      convertImage: mammoth.images.imgElement(async (image: any) => {
        try {
          const raw = Buffer.from(await image.read('base64'), 'base64');
          const jpeg = await sharp(raw, { failOn: 'truncated' }).rotate().resize(1100, 1100, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer();
          if (images.length < 30) images.push(`data:image/jpeg;base64,${jpeg.toString('base64')}`);
        } catch { /* skip an unreadable embedded image */ }
        return { src: '' };
      }),
    });
    const text = htmlToText(html);
    if (!text && !images.length) return null;   // nothing usable extracted

    const paras = text.split('\n').filter((p) => p.length > 0);
    const doc = React.createElement(
      Document, null,
      React.createElement(
        Page, { size: 'LETTER', style: s.page, wrap: true },
        React.createElement(Text, { style: s.title }, 'Proof of Service (converted from Word)'),
        ...paras.map((p, i) => React.createElement(Text, { key: `t${i}`, style: s.para }, p)),
        ...images.map((src, i) => React.createElement(
          View, { key: `i${i}`, wrap: false },
          React.createElement(Image, { src, style: s.img }),
        )),
      ),
    );
    return await renderToBuffer(doc as any);
  } catch {
    return null;
  }
}
