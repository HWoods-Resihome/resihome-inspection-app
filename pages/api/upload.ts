import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { uploadFile } from '@/lib/hubspot';

export const config = {
  api: {
    bodyParser: {
      // 20MB is well over what we should ever send post-compression (target is
      // ~600KB; canvas fallback caps at ~2MB raw → ~2.7MB base64). The headroom
      // is safety margin for unusual phone outputs.
      sizeLimit: '20mb',
    },
  },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Defense-in-depth: middleware already gates this, but verify the
  // session here too so the route is never reachable unauthenticated
  // even if the middleware matcher changes.
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    // Frontend sends { filename, contentType, base64 } -- base64-encoded file bytes
    const { filename, contentType, base64 } = req.body || {};
    if (!base64 || !filename) {
      return res.status(400).json({ error: 'Missing filename or base64 body' });
    }

    // Only accept image uploads. Without this, any authenticated user could push
    // arbitrary file types (e.g. HTML) to HubSpot Files, which then serves them
    // from a public CDN URL — a stored-content / file-abuse vector.
    const ALLOWED_TYPES = new Set([
      'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
    ]);
    const safeContentType = String(contentType || 'image/jpeg').toLowerCase().split(';')[0].trim();
    if (!ALLOWED_TYPES.has(safeContentType)) {
      return res.status(400).json({ error: `Unsupported content type: ${safeContentType}` });
    }

    // Sanitize the filename: strip any path components and disallow anything but
    // a conservative character set, cap the length, and guarantee an extension.
    const rawName = String(filename).split(/[\\/]/).pop() || 'photo.jpg';
    let safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
    if (!/\.[a-zA-Z0-9]{1,5}$/.test(safeName)) {
      safeName += '.jpg';
    }

    const buffer = Buffer.from(base64, 'base64');
    // Reject empty / clearly-bogus payloads.
    if (buffer.length === 0) {
      return res.status(400).json({ error: 'Empty file payload' });
    }
    const url = await uploadFile(buffer, safeName, safeContentType);
    return res.status(200).json({ url });
  } catch (e: any) {
    console.error('POST /api/upload failed:', e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}
