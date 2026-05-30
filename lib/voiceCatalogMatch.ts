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

export interface MatchResult {
  candidates: CandidateMatch[];
  topScore: number;       // cosine score of the best match (0..~1)
  confident: boolean;     // topScore clears the floor
}

// Cosine score below which we treat the best match as "not confident" — the
// agent should then double-check with the inspector rather than assume.
// voyage-3-lite retrieval scores for a good match typically sit well above this.
const CONFIDENCE_FLOOR = 0.45;

// Embed the utterance and return the top-K most similar catalog items, plus a
// confidence read on the best match. `categoryHint` (from the agent) and
// `sectionName` (the room/area) lightly boost on-topic items.
// Speech engines mishear some domain terms. Normalize known ones before
// matching so the right catalog item is found. "Mist Match" (a paint blending
// line item) is routinely transcribed as "mismatch/mismatched/missed match".
function normalizeDomainTerms(text: string): string {
  let t = text;
  t = t.replace(/\bmis[\s-]?match(ed|ing)?\b/gi, 'mist match');
  t = t.replace(/\bmissed[\s-]?match(ed|ing)?\b/gi, 'mist match');
  t = t.replace(/\bmist[\s-]?match(ed|ing)\b/gi, 'mist match');
  return t;
}

export async function matchCatalog(
  utterance: string,
  items: RateCardLineItem[],
  opts: { topK?: number; categoryHint?: string; sectionName?: string } = {}
): Promise<MatchResult> {
  const topK = opts.topK ?? 10;
  const cache = await getCatalogEmbeddings(items);
  const normalized = normalizeDomainTerms(utterance);
  const [queryVec] = await voyageEmbed([normalized.slice(0, 400)], 'query');
  if (!queryVec) return { candidates: [], topScore: 0, confident: false };

  const hint = (opts.categoryHint || '').toLowerCase().trim();
  // Map common section words to likely catalog categories for a gentle bias.
  const sectionCats = sectionCategoryHints(opts.sectionName || '');

  const scored: CandidateMatch[] = [];
  for (const item of items) {
    const v = cache.byCode.get(item.lineItemCode);
    if (!v) continue;
    const baseScore = cosine(queryVec, v);
    let score = baseScore;
    const cat = item.category.toLowerCase();
    if (hint && cat.includes(hint)) score += 0.05;
    if (sectionCats.some((c) => cat.includes(c))) score += 0.03;
    // Store the RAW cosine for confidence; biases only affect ranking.
    scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const candidates = scored.slice(0, topK);
  // Confidence uses the raw cosine of the top-ranked item (recompute without bias).
  const top = candidates[0];
  const topScore = top ? cosine(queryVec, cache.byCode.get(top.item.lineItemCode) || []) : 0;
  return { candidates, topScore, confident: topScore >= CONFIDENCE_FLOOR };
}

// Very light section→category hinting. Not exhaustive; just nudges ranking for
// the obvious cases. Unknown sections contribute nothing.
function sectionCategoryHints(section: string): string[] {
  const s = section.toLowerCase();
  const out: string[] = [];
  if (/exterior|yard|gutter|roof|siding/.test(s)) out.push('gutter', 'roof', 'siding', 'exterior', 'paint');
  if (/kitchen/.test(s)) out.push('appliance', 'cabinet', 'plumbing', 'countertop');
  if (/bath/.test(s)) out.push('plumbing', 'tile', 'cabinet');
  if (/bedroom|living|hall|stair/.test(s)) out.push('carpet', 'paint', 'drywall', 'flooring');
  if (/hvac|mechanical/.test(s)) out.push('hvac');
  if (/garage/.test(s)) out.push('door', 'concrete');
  return out;
}
