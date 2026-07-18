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
import { enforceRateLimit } from '@/lib/rateLimit';
import { recordAiUsage, estimateTranscribeCostUSD } from '@/lib/aiUsage';

// gpt-4o-mini-transcribe is faster + more accurate than whisper-1 for short
// speech clips (and cheaper). Overridable via env for a no-deploy rollback.
const STT_MODEL = process.env.TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';

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
  // Warm-up ping: prime the OpenAI TLS/connection pool so the first real
  // transcription (iOS/Safari Whisper path) doesn't pay the handshake. Cheap,
  // best-effort; fired by the shared AI warm-up on login / inspection open.
  if (req.method === 'GET') {
    try {
      const k = process.env.OPENAI_API_KEY;
      if (k) await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${k}` } }).then((r) => r.body?.cancel?.()).catch(() => {});
    } catch { /* non-fatal */ }
    return res.status(200).json({ ok: true });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  // Per-user cap on the (paid) Whisper transcription call.
  if (enforceRateLimit(res, { key: session.email || 'anon', route: 'ai-transcribe', max: 60, windowMs: 60_000 })) return;

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
    form.append('model', STT_MODEL);
    form.append('language', 'en');
    // The gpt-4o transcribe models support only `json` / `text` (no verbose_json),
    // so we don't get an exact `duration` back — cost is estimated from the clip
    // size below. whisper-1 still supports verbose_json if rolled back via env.
    form.append('response_format', /whisper/.test(STT_MODEL) ? 'verbose_json' : 'json');
    // Vocabulary biasing — nudges the model toward inspection/construction terms
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
    // Use the exact duration when present (verbose_json), else estimate from the
    // compressed clip size (~32 kbps speech) — telemetry only, not billed.
    const seconds = Number.isFinite(Number(d?.duration)) ? Number(d.duration) : buf.length / 4000;
    recordAiUsage({ source: 'transcribe', model: STT_MODEL, costUSD: estimateTranscribeCostUSD(STT_MODEL, seconds) });
    return res.status(200).json({ text: String(d.text || '').trim() });
  } catch (e: any) {
    console.error('POST /api/transcribe failed:', e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
