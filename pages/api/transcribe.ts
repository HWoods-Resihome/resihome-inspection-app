/**
 * POST /api/transcribe  ->  { text }
 *
 * Speech-to-text for browsers without the Web Speech API (notably iOS Safari).
 * The client records a short audio clip (push-to-talk), base64-encodes it, and
 * posts it here; we forward it to OpenAI Whisper and return the transcript,
 * which the Voice Assistant then runs through the normal line-item flow.
 *
 * Requires OPENAI_API_KEY in the environment and `api.openai.com` on the
 * deployment's outbound network allowlist. Behind the session middleware.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';

export const config = {
  api: {
    // Short clips are tiny (~10s ≈ 100–300KB); 12MB is generous headroom for
    // base64 inflation on unusually long takes.
    bodyParser: { sizeLimit: '12mb' },
  },
};

const OPENAI_URL = 'https://api.openai.com/v1/audio/transcriptions';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return res.status(503).json({ error: 'Voice transcription isn’t configured yet (missing OPENAI_API_KEY).' });
  }

  try {
    const { base64, mime, prompt } = req.body || {};
    if (!base64 || typeof base64 !== 'string') {
      return res.status(400).json({ error: 'Missing audio payload' });
    }
    const buf = Buffer.from(base64, 'base64');
    if (buf.length === 0) return res.status(400).json({ error: 'Empty audio payload' });

    const contentType = String(mime || 'audio/mp4').split(';')[0].trim();
    const ext = /mp4|m4a|aac/i.test(contentType) ? 'm4a'
      : /webm/i.test(contentType) ? 'webm'
      : /ogg|opus/i.test(contentType) ? 'ogg'
      : /wav/i.test(contentType) ? 'wav'
      : 'mp4';

    const form = new FormData();
    form.append('file', new Blob([buf], { type: contentType }), `audio.${ext}`);
    form.append('model', 'whisper-1');
    form.append('language', 'en');
    // Vocabulary biasing — nudges Whisper toward inspection/construction terms
    // (e.g. "mist match") instead of plausible-sounding everyday words.
    if (prompt && typeof prompt === 'string') form.append('prompt', prompt.slice(0, 800));

    const r = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form as any,
    });
    if (!r.ok) {
      const t = await r.text();
      console.error('[transcribe] OpenAI error:', r.status, t.slice(0, 300));
      return res.status(502).json({ error: `Transcription failed (${r.status}).` });
    }
    const d = await r.json();
    return res.status(200).json({ text: String(d.text || '').trim() });
  } catch (e: any) {
    console.error('POST /api/transcribe failed:', e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
