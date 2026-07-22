/**
 * POST /api/services/[id]/rotate-photo — INTERNAL: rotate one of a service's
 * stored photos 90° clockwise, in place.
 *
 * Body: { url } — the photo entry as shown in the gallery (may carry a #fragment).
 * Finds which photo property holds it (before/after/pet before/pet after/proof),
 * fetches the image, rotates 90° CW (EXIF applied first), uploads the corrected
 * copy, and swaps the URL in that property (preserving any #fragment metadata).
 * The record view, PDFs, and emails all read those properties, so the fix shows
 * everywhere. Internal-only — vendors' submitted evidence stays read-only to them.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import sharp from 'sharp';
import { getSessionFromRequest } from '@/lib/auth';
import { isInternalEmail } from '@/lib/userAccess';
import { servicesEnabled } from '@/lib/servicesAccess';
import { fetchServiceWorkOrder, patchServiceWorkOrder, uploadFile } from '@/lib/hubspot';
import { safeProxyFetch, readBodyCapped, isAllowedPhotoHost } from '@/lib/safeProxyFetch';
import { recordServiceAudit } from '@/lib/services/serviceAudit';

export const config = { maxDuration: 60 };

const PHOTO_PROPS = ['before_photo_urls', 'after_photo_urls', 'pet_before_photo_urls', 'pet_after_photo_urls', 'proof_photo_urls'] as const;
const splitEntries = (v: any): string[] => String(v || '').split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
const baseOf = (u: string) => u.split('#')[0];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  const ok = (await servicesEnabled(email).catch(() => false)) && isInternalEmail(email) && !session?.vendor;
  if (!ok) return res.status(403).json({ error: 'Internal users only' });

  const id = String(req.query.id || '');
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'A valid service id is required.' });
  const target = String((req.body || {}).url || '').trim();
  if (!/^https?:\/\//i.test(baseOf(target))) return res.status(400).json({ error: 'A photo url is required.' });

  try {
    const rec = await fetchServiceWorkOrder(id);
    if (!rec) return res.status(404).json({ error: 'Service not found.' });
    // Locate the entry: match on the #-stripped base so fragment metadata never
    // breaks the lookup, and keep the original entry to preserve its fragment.
    let prop: (typeof PHOTO_PROPS)[number] | null = null;
    let entries: string[] = [];
    let idx = -1;
    for (const p of PHOTO_PROPS) {
      const list = splitEntries(rec.props[p]);
      const i = list.findIndex((e) => baseOf(e) === baseOf(target));
      if (i !== -1) { prop = p; entries = list; idx = i; break; }
    }
    if (!prop) return res.status(400).json({ error: 'This photo isn’t one of the service’s stored photos (answer photos can’t be rotated here).' });

    const fetchUrl = baseOf(entries[idx]);
    if (!isAllowedPhotoHost(fetchUrl)) return res.status(400).json({ error: 'Photo host not allowed.' });
    const r = await safeProxyFetch(fetchUrl);
    if (!r.ok) return res.status(502).json({ error: `Could not fetch the photo (${r.status}).` });
    const buf = await readBodyCapped(r, 40 * 1024 * 1024);
    // Apply any EXIF orientation FIRST (so we rotate what the user sees), then 90° CW.
    const upright = await sharp(buf, { failOn: 'truncated' }).rotate().toBuffer();
    const rotated = await sharp(upright).rotate(90).jpeg({ quality: 85 }).toBuffer();
    const newUrl = await uploadFile(rotated, `rotated-${id}-${idx}-${Date.now()}.jpg`, 'image/jpeg', '/service_photos');
    if (!newUrl) return res.status(500).json({ error: 'Upload of the rotated photo failed.' });

    const fragment = entries[idx].includes('#') ? `#${entries[idx].split('#').slice(1).join('#')}` : '';
    entries[idx] = `${newUrl}${fragment}`;
    await patchServiceWorkOrder(id, { [prop]: entries.join('\n') });
    void recordServiceAudit({ serviceId: id, action: 'edit', actorEmail: email, actorName: session?.name, detail: `Rotated a ${prop.replace(/_/g, ' ').replace(' urls', '')} 90°` });
    return res.status(200).json({ ok: true, newUrl: entries[idx], prop });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
