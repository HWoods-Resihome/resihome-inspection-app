// Short, clean, signed share links for the finalize PDFs/xlsx.
//
// Problem: the raw HubSpot file URLs are enormous and ugly to share. Instead we
// hand out links on our own domain that 302-redirect to the real file:
//
//   https://resiwalk.com/d/<inspectionId>/<type>/<sig>
//   https://resiwalk.com/d/<inspectionId>/v/<vendorSlug>/<sig>   (per-vendor PDF)
//
// `sig` is a short HMAC over (id:type:vendorSlug) using SESSION_SECRET (already
// set + stable in prod), so links are unguessable without a database and are
// DETERMINISTIC — a backfill script can regenerate the exact same link for any
// existing inspection. The resolver reads the real URL from the inspection's
// stored pdf_* properties at click time, so old inspections work with no change.

import crypto from 'crypto';

// 'report' is the single PDF used by non-Rate-Card templates (question
// templates + QC reinspect), stored in pdf_attachment_url.
export type ShareDocType = 'master' | 'chargeback' | 'xlsx' | 'report' | 'vendor' | 'photos';

// Stable signing secret. Reuses SESSION_SECRET so we don't introduce a new env
// var that would have to be kept in lockstep. Falls back to a constant only in
// local/dev where SESSION_SECRET may be unset (links still resolve there).
function signingSecret(): string {
  return process.env.SESSION_SECRET || 'resiwalk-dev-link-secret';
}

/** Slugify a vendor name into a URL-safe segment (reversible-enough via match). */
export function slugifyVendor(vendor: string): string {
  return (vendor || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'vendor';
}

function sigFor(id: string, type: ShareDocType, vendorSlug = ''): string {
  return crypto
    .createHmac('sha256', signingSecret())
    .update(`${id}:${type}:${vendorSlug}`)
    .digest('hex')
    .slice(0, 10);
}

/** Constant-time compare of a provided signature against the expected one. */
export function verifyShareSig(id: string, type: ShareDocType, sig: string, vendorSlug = ''): boolean {
  const expected = sigFor(id, type, vendorSlug);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(sig || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Build a short share link. `baseUrl` is the app origin (e.g. https://resiwalk.com).
 * For vendor PDFs pass type 'vendor' + the vendor name.
 */
export function buildShortLink(baseUrl: string, id: string, type: ShareDocType, vendorName?: string): string {
  const base = (baseUrl || '').replace(/\/+$/, '');
  if (type === 'vendor') {
    const slug = slugifyVendor(vendorName || '');
    return `${base}/d/${id}/v/${slug}/${sigFor(id, 'vendor', slug)}`;
  }
  return `${base}/d/${id}/${type}/${sigFor(id, type)}`;
}

/** Map a non-vendor doc type to the HubSpot property holding its real URL. */
export const SHARE_TYPE_TO_PROP: Record<Exclude<ShareDocType, 'vendor' | 'photos'>, string> = {
  master: 'pdf_master_url',
  chargeback: 'pdf_chargeback_url',
  xlsx: 'pdf_chargeback_xlsx_url',
  report: 'pdf_attachment_url',
};
