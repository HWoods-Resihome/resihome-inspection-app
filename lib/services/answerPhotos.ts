/**
 * Per-question completion photos live in the answers object under `<qid>__photos`
 * arrays. Those must only ever hold HOSTED (allowlisted https) URLs — a blob:/ref:
 * draft that never finished uploading would be persisted and then render as a
 * broken image (e.g. the "Grass height at arrival" shot). This filters every
 * `__photos` array down to hosted URLs before the answers are written to HubSpot,
 * so a stray draft URL can never be stored regardless of any client-side slip.
 */
import { isAllowedPhotoHost } from '@/lib/safeProxyFetch';

export function sanitizeAnswerPhotos(answers: Record<string, any>): Record<string, any> {
  if (!answers || typeof answers !== 'object') return {};
  const out: Record<string, any> = { ...answers };
  for (const k of Object.keys(out)) {
    if (k.endsWith('__photos') && Array.isArray(out[k])) {
      out[k] = out[k].map((u: any) => String(u || '').trim()).filter((u: string) => isAllowedPhotoHost(u));
    }
  }
  return out;
}
