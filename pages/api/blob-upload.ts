/**
 * POST /api/blob-upload — client-upload token handshake for Vercel Blob.
 *
 * Video clips are uploaded straight from the browser to Vercel Blob storage,
 * which bypasses Vercel's ~4.5MB serverless request-body limit (the wall that
 * capped base64 uploads at ~10s). The browser calls `upload()` from
 * `@vercel/blob/client`, which hits this route only to (a) get a short-lived
 * upload token and (b) report completion — the file bytes never pass through
 * this function.
 *
 * Requires a Vercel Blob store linked to the project (sets BLOB_READ_WRITE_TOKEN
 * automatically). Behind the session middleware; also re-checks the session.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { getSessionFromRequest } from '@/lib/auth';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const body = req.body as HandleUploadBody;
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ['video/mp4', 'video/webm', 'video/quicktime'],
        addRandomSuffix: true,
        maximumSizeInBytes: 200 * 1024 * 1024, // generous; the recorder caps duration
      }),
      // The upload completes browser→Blob directly; nothing to persist here.
      onUploadCompleted: async () => { /* noop */ },
    });
    return res.status(200).json(jsonResponse);
  } catch (e: any) {
    // Most commonly: no Blob store linked yet (BLOB_READ_WRITE_TOKEN missing).
    console.error('POST /api/blob-upload failed:', e?.message || e);
    return res.status(400).json({ error: String(e?.message || e) });
  }
}
