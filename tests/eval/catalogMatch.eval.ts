/**
 * Catalog-matching eval — the quality GATE for changes to semantic matching
 * (confidence floors, domain aliases, section hints) and the model that powers
 * voice/scan line capture.
 *
 * Runs a gold set of utterances through matchCatalog against the LIVE catalog
 * and asserts top-1 accuracy clears a threshold, so a change that quietly makes
 * matching worse fails CI instead of shipping. It also prints accuracy@3, mean
 * confidence for hits vs misses, and the per-case result for triage.
 *
 * Requires live keys (VOYAGE_API_KEY + a HubSpot token). Without them the suite
 * SKIPS — it never blocks a keyless `npm test` (it's excluded from the default
 * run anyway; see vitest.eval.config.ts). Run it explicitly with:  npm run eval
 *
 * Gold set: tests/eval/catalogMatch.gold.json. Cases key on a description
 * keyword (portable across portals) or an exact `expectCode`. Curate it against
 * your catalog and grow it from real misses (see lib/aiFeedback feedback data).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { matchCatalog } from '@/lib/voiceCatalogMatch';
import { getCachedCatalog } from '@/pages/api/rate-card/catalog';
import type { RateCardLineItem } from '@/lib/types';
import gold from './catalogMatch.gold.json';

interface GoldCase {
  utterance: string;
  expectCode?: string;
  expectDescriptionIncludes?: string;
  section?: string;
  note?: string;
}

const hasEnv = !!process.env.VOYAGE_API_KEY
  && !!(process.env.HUBSPOT_TOKEN || process.env.HUBSPOT_SANDBOX_TOKEN);
const MIN_ACCURACY = Number(process.env.EVAL_MIN_ACCURACY) || 0.7;
const MIN_ACCURACY_TOP3 = Number(process.env.EVAL_MIN_ACCURACY_TOP3) || 0.85;

function describe_(item: RateCardLineItem): string {
  return [item.laborShortDescription, item.laborFullDescription, item.laborSubtext, item.subcategory, item.materialDescription]
    .filter(Boolean).join(' ');
}

function matches(item: RateCardLineItem, c: GoldCase): boolean {
  if (c.expectCode) return item.lineItemCode === c.expectCode;
  if (c.expectDescriptionIncludes) {
    return describe_(item).toLowerCase().includes(c.expectDescriptionIncludes.toLowerCase());
  }
  return false;
}

describe.skipIf(!hasEnv)('catalog matching eval', () => {
  let catalog: RateCardLineItem[] = [];

  beforeAll(async () => {
    catalog = await getCachedCatalog();
  }, 60_000);

  it('clears the accuracy gate on the gold set', async () => {
    const cases = gold as GoldCase[];
    let hit1 = 0, hit3 = 0;
    const confHit: number[] = [], confMiss: number[] = [];
    const rows: any[] = [];

    for (const c of cases) {
      const res = await matchCatalog(c.utterance, catalog, { sectionName: c.section, topK: 3 });
      const top = res.candidates[0]?.item;
      const ok1 = !!top && matches(top, c);
      const ok3 = res.candidates.slice(0, 3).some((cand) => matches(cand.item, c));
      if (ok1) hit1++;
      if (ok3) hit3++;
      (ok1 ? confHit : confMiss).push(Number(res.topScore.toFixed(3)));
      rows.push({
        utterance: c.utterance.slice(0, 40),
        expect: c.expectCode || c.expectDescriptionIncludes,
        top: top ? (top.laborShortDescription || top.lineItemCode).slice(0, 32) : '—',
        score: Number(res.topScore.toFixed(3)),
        '@1': ok1 ? '✓' : '✗',
        '@3': ok3 ? '✓' : '✗',
      });
    }

    const acc1 = hit1 / cases.length;
    const acc3 = hit3 / cases.length;
    const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

    // eslint-disable-next-line no-console
    console.table(rows);
    // eslint-disable-next-line no-console
    console.log(`[eval] cases=${cases.length} acc@1=${(acc1 * 100).toFixed(1)}% acc@3=${(acc3 * 100).toFixed(1)}% ` +
      `meanConf(hit)=${mean(confHit).toFixed(3)} meanConf(miss)=${mean(confMiss).toFixed(3)} ` +
      `(gate: @1>=${MIN_ACCURACY}, @3>=${MIN_ACCURACY_TOP3})`);

    expect(acc1).toBeGreaterThanOrEqual(MIN_ACCURACY);
    expect(acc3).toBeGreaterThanOrEqual(MIN_ACCURACY_TOP3);
  }, 120_000);
});
