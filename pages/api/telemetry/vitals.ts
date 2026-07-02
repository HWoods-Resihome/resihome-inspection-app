import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Sink for Real-User Web Vitals (see reportWebVitals in pages/_app.tsx) — LCP,
 * INP, CLS, FCP, TTFB measured on ACTUAL field devices, not a lab. Emits a
 * structured, greppable line so the numbers are queryable in Vercel logs (and
 * can be shipped onward by a log drain). Unauthenticated on purpose (vitals can
 * fire pre-interaction / on unload) and never errors loudly — bounded + best
 * effort, like the client-error sink.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const b = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {});
    const name = String(b?.name || '').slice(0, 24);
    if (name) {
      console.log('[web-vitals]', JSON.stringify({
        name,
        value: typeof b.value === 'number' && isFinite(b.value) ? b.value : null,
        rating: b.rating ? String(b.rating).slice(0, 16) : undefined,
        url: b.url ? String(b.url).slice(0, 200) : undefined,
        at: new Date().toISOString(),
      }));
    }
  } catch {
    /* swallow — telemetry must never fail loudly */
  }
  return res.status(204).end();
}

function safeParse(s: string): any { try { return JSON.parse(s); } catch { return {}; } }
