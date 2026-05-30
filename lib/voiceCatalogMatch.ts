// lib/voiceCatalogMatch.ts
//
// Semantic catalog matching for the voice line-item assistant (Scope only).
//
// COST MODEL (the whole point of this design):
//   - The 853-row catalog is embedded ONCE per catalog_version, then cached
//     (in-memory + a /tmp JSON file). Re-embedding only happens when the
//     catalog changes. ~26K tokens total => a fraction of a cent, once.
//   - Per spoken utterance we embed ONE short phrase (~10 tokens, effectively
//     free) and do an in-memory cosine search. No per-utterance catalog cost.
//   - The LLM then sees only the top-K candidates (default 10), never all 853,
//     which keeps the (more expensive) Claude call small.
//
// Provider: Voyage AI (Anthropic's recommended embeddings partner).
//   Env: VOYAGE_API_KEY. Model: voyage-3-lite (cheap, strong for retrieval).

import type { RateCardLineItem } from './types';
import { promises as fs } from 'fs';
import path from 'path';

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_MODEL = 'voyage-3-lite';
// Voyage allows large batches; keep chunks modest so a single failure is cheap
// to retry and we stay well within request-size limits.
const EMBED_BATCH = 128;

// Where we persist catalog vectors between cold starts. /tmp is writable on
// Vercel serverless and survives within a warm instance; the in-memory cache
// below avoids even reading the file on warm calls.
const CACHE_DIR = '/tmp';
function cacheFileFor(version: string): string {
  const safe = (version || 'noversion').replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(CACHE_DIR, `rc_embeddings_${safe}.json`);
}

export interface CatalogVector {
  code: string;
  vector: number[];
}

interface EmbeddingCache {
  version: string;
  byCode: Map<string, number[]>;
}

let MEM_CACHE: EmbeddingCache | null = null;

function voyageKey(): string {
  const k = process.env.VOYAGE_API_KEY;
  if (!k) throw new Error('VOYAGE_API_KEY is not set — voice catalog matching is unavailable.');
  return k;
}

// The text we embed for each catalog item. Keep it compact but distinctive:
// description carries the meaning, category/subcategory disambiguate
// near-duplicates ("gutter cleaning" vs "gutter repair"), unit helps the
// downstream agent. We deliberately exclude prices/codes (not semantic).
export function catalogItemEmbedText(item: RateCardLineItem): string {
  const parts = [
    item.laborShortDescription,
    item.laborSubtext || item.laborFullDescription,
    item.category,
    item.subcategory,
    item.laborMeas ? `unit ${item.laborMeas}` : '',
  ].filter(Boolean);
  return parts.join(' — ').slice(0, 400);
}

async function voyageEmbed(texts: string[], inputType: 'document' | 'query'): Promise<number[][]> {
  const res = await fetch(VOYAGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${voyageKey()}`,
    },
    body: JSON.stringify({
      model: VOYAGE_MODEL,
      input: texts,
      input_type: inputType,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Voyage embeddings failed ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  // Voyage returns { data: [{ embedding: number[], index }], ... }
  const out: number[][] = new Array(texts.length);
  for (const row of data.data || []) {
    out[row.index] = row.embedding;
  }
  return out;
}

// Embed the full catalog (batched). Called once per version on a cache miss.
async function embedCatalog(items: RateCardLineItem[]): Promise<Map<string, number[]>> {
  const byCode = new Map<string, number[]>();
  for (let i = 0; i < items.length; i += EMBED_BATCH) {
    const chunk = items.slice(i, i + EMBED_BATCH);
    const vectors = await voyageEmbed(chunk.map(catalogItemEmbedText), 'document');
    chunk.forEach((item, j) => {
      if (vectors[j]) byCode.set(item.lineItemCode, vectors[j]);
    });
  }
  return byCode;
}

function catalogVersion(items: RateCardLineItem[]): string {
  // Prefer the explicit catalog_version if present; else derive a cheap
  // fingerprint from count + a sample of codes so a changed catalog re-embeds.
  const v = (items[0] as any)?.catalogVersion;
  if (v) return String(v);
  return `n${items.length}_${items.slice(0, 3).map((i) => i.lineItemCode).join('-')}`;
}

// Get (or build) the catalog embeddings for the given items. Layered cache:
// 1) in-memory (warm instance, zero cost), 2) /tmp file (same version),
// 3) Voyage embed + persist (cold / new version).
export async function getCatalogEmbeddings(items: RateCardLineItem[]): Promise<EmbeddingCache> {
  const version = catalogVersion(items);

  if (MEM_CACHE && MEM_CACHE.version === version) return MEM_CACHE;

  const file = cacheFileFor(version);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as { version: string; vectors: CatalogVector[] };
    if (parsed.version === version && parsed.vectors?.length) {
      const byCode = new Map<string, number[]>();
      for (const cv of parsed.vectors) byCode.set(cv.code, cv.vector);
      MEM_CACHE = { version, byCode };
      return MEM_CACHE;
    }
  } catch {
    // no cache file / unreadable — fall through to embed
  }

  const byCode = await embedCatalog(items);
  MEM_CACHE = { version, byCode };

  // Persist best-effort; failure is non-fatal (we still have it in memory).
  try {
    const vectors: CatalogVector[] = Array.from(byCode.entries()).map(([code, vector]) => ({ code, vector }));
    await fs.writeFile(file, JSON.stringify({ version, vectors }), 'utf8');
  } catch (e) {
    console.warn('[voiceCatalogMatch] could not persist embeddings cache:', e);
  }

  return MEM_CACHE;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface CandidateMatch {
  item: RateCardLineItem;
  score: number;
}

// Embed the utterance and return the top-K most similar catalog items.
// `categoryHint` (optional) lightly boosts items in a matching category — cheap
// help for phrases that clearly map to one category (e.g. "gutter ...").
export async function matchCatalog(
  utterance: string,
  items: RateCardLineItem[],
  opts: { topK?: number; categoryHint?: string } = {}
): Promise<CandidateMatch[]> {
  const topK = opts.topK ?? 10;
  const cache = await getCatalogEmbeddings(items);
  const [queryVec] = await voyageEmbed([utterance.slice(0, 400)], 'query');
  if (!queryVec) return [];

  const hint = (opts.categoryHint || '').toLowerCase().trim();
  const scored: CandidateMatch[] = [];
  for (const item of items) {
    const v = cache.byCode.get(item.lineItemCode);
    if (!v) continue;
    let score = cosine(queryVec, v);
    if (hint && item.category.toLowerCase().includes(hint)) score += 0.05;
    scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
