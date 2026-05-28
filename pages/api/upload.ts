import type { NextApiRequest, NextApiResponse } from 'next';
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
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    // Frontend sends { filename, contentType, base64 } -- base64-encoded file bytes
    const { filename, contentType, base64 } = req.body || {};
    if (!base64 || !filename) {
      return res.status(400).json({ error: 'Missing filename or base64 body' });
    }
    const buffer = Buffer.from(base64, 'base64');
    const url = await uploadFile(buffer, String(filename), String(contentType || 'image/jpeg'));
    return res.status(200).json({ url });
  } catch (e: any) {
    console.error('POST /api/upload failed:', e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}
