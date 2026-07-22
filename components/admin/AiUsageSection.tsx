/**
 * Admin card: Claude / AI API usage & cost.
 *
 * A collapsible section for /admin/flows. On open it pulls the estimated spend
 * (from /api/admin/ai-usage — per-instance daily rollup blobs written by
 * lib/aiUsage.ts) for a chosen window, and surfaces: the headline cost, the TOP
 * spend by feature + model (so you can see where the money goes), and a few
 * concrete cost-reduction pointers. Links to the full /admin/ai-usage dashboard
 * for the by-day trend. Costs are estimates; the [ai-usage] logs are authoritative.
 */
import { useCallback, useEffect, useState } from 'react';

type Bucket = { calls: number; inputTokens: number; outputTokens: number; costUSD: number };
type UsageResp = { ok: boolean; days: number; bySource: Record<string, Bucket>; byModel: Record<string, Bucket>; total: Bucket };

const SOURCE_LABEL: Record<string, string> = {
  ai_review: 'AI Review (inspections)',
  service_ai_review: 'AI Review (services)',
  service_ai_learning: 'AI Learning (services)',
  room_scan_live: 'Live Camera Scan',
  room_scan: 'Room Scan (video)',
  voice_assist: 'Voice Assistant',
  transcribe: 'Voice Transcription',
  embeddings: 'Catalog Embeddings',
  slack_bot: 'Slack Bot',
};

const money = (n: number) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (n: number) => (Number(n) || 0).toLocaleString('en-US');

function Chevron({ open }: { open: boolean }) {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform shrink-0 ${open ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>;
}

export function AiUsageSection() {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState(30);
  const [data, setData] = useState<UsageResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (d: number) => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/admin/ai-usage?days=${d}`, { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setData(j);
    } catch (e: any) { setError(String(e?.message || e)); }
    finally { setLoading(false); }
  }, []);

  // Fetch on first open, and whenever the window changes while open.
  useEffect(() => { if (open) load(days); }, [open, days, load]);

  const ranked = (rec: Record<string, Bucket> | undefined, label?: (k: string) => string) =>
    Object.entries(rec || {}).sort((a, b) => b[1].costUSD - a[1].costUSD).map(([k, b]) => ({ key: label ? label(k) : k, ...b }));

  const total = data?.total;
  const sources = ranked(data?.bySource, (k) => SOURCE_LABEL[k] || k);
  const models = ranked(data?.byModel);
  const top = sources[0];
  const topPct = total && total.costUSD > 0 && top ? Math.round((top.costUSD / total.costUSD) * 100) : 0;
  const usesOpus = models.some((m) => /opus/i.test(m.key) && m.costUSD > 0);

  // Concrete, data-aware cost-reduction pointers.
  const tips: string[] = [];
  if (top) tips.push(`${top.key} is your biggest spend — ${topPct}% of the estimated total (${money(top.costUSD)}). Focus optimization there first.`);
  if (usesOpus) tips.push('Opus is the priciest tier (~5×/25× per Mtok). Reserve it for the hardest calls and try Sonnet — or Haiku for routine, high-volume checks.');
  tips.push('Prompt caching is the biggest lever (cached input ≈ 0.1× rate). Keep long system prompts / the AI knowledge base STABLE so the prefix caches; grep the [ai-usage] logs for cacheRead vs cacheCreation to confirm it’s landing.');
  tips.push('For vision calls, send fewer/smaller images (downscale + cap the photo budget) — image tokens dominate review cost.');

  return (
    <section className="mt-5 border border-gray-200 rounded-xl bg-white">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="w-full flex items-center justify-between gap-3 p-4 text-left">
        <div>
          <h2 className="font-heading font-bold text-base text-ink">Claude API Usage &amp; Cost</h2>
          <p className="text-[12px] text-gray-500 mt-0.5 leading-relaxed">Estimated AI spend, top usage by feature &amp; model, and where to trim cost.</p>
        </div>
        <Chevron open={open} />
      </button>
      {open && (
        <div className="px-4 pb-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-[12px] text-gray-600">Window:</span>
            {[1, 7, 30, 90].map((d) => (
              <button key={d} type="button" onClick={() => setDays(d)}
                className={`text-[12px] font-heading font-semibold px-2.5 py-1 rounded-lg border ${days === d ? 'bg-brand text-white border-brand' : 'border-gray-300 text-gray-700 hover:bg-gray-100'}`}>
                {d === 1 ? 'Today' : `${d}d`}
              </button>
            ))}
            <button type="button" onClick={() => load(days)} disabled={loading}
              className="text-[12px] font-heading font-semibold px-2.5 py-1 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-100 disabled:opacity-40 ml-auto">
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>

          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">{error}</div>}

          <div className="grid grid-cols-3 gap-2 mb-3">
            <div className="bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5">
              <div className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">Est. cost ({data?.days ?? days}d)</div>
              <div className="text-xl font-extrabold text-ink mt-0.5 tabular-nums">{money(total?.costUSD || 0)}</div>
            </div>
            <div className="bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5">
              <div className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">Calls</div>
              <div className="text-xl font-extrabold text-ink mt-0.5 tabular-nums">{num(total?.calls || 0)}</div>
            </div>
            <div className="bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5">
              <div className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">Tokens in / out</div>
              <div className="text-[12px] font-bold text-ink mt-1.5 tabular-nums">{num(total?.inputTokens || 0)} <span className="text-gray-400 font-normal">/</span> {num(total?.outputTokens || 0)}</div>
            </div>
          </div>

          <TopTable title="Top spend by feature" col="Feature" items={sources.slice(0, 6)} loading={loading} />
          <TopTable title="By model" col="Model" items={models.slice(0, 6)} loading={loading} />

          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-3">
            <div className="text-[12px] font-heading font-bold text-amber-800 mb-1.5">Opportunities to reduce spend</div>
            <ul className="space-y-1.5 text-[12px] text-amber-900 list-disc pl-4">
              {tips.map((t, i) => <li key={i} className="leading-snug">{t}</li>)}
            </ul>
          </div>

          <a href="/admin/ai-usage" className="inline-block mt-3 text-[13px] font-heading font-semibold text-brand hover:underline">Open full dashboard (by-day trend) →</a>
        </div>
      )}
    </section>
  );
}

function TopTable({ title, col, items, loading }: { title: string; col: string; items: ({ key: string } & Bucket)[]; loading: boolean }) {
  return (
    <div className="mt-3">
      <h3 className="font-heading font-bold text-[12px] text-ink mb-1.5">{title}</h3>
      <div className="border border-gray-200 rounded-lg bg-white overflow-hidden">
        <table className="w-full text-[12px]">
          <thead className="bg-gray-50 text-gray-500">
            <tr>
              <th className="text-left font-semibold px-3 py-1.5">{col}</th>
              <th className="text-right font-semibold px-3 py-1.5">Calls</th>
              <th className="text-right font-semibold px-3 py-1.5">Est. cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {items.length === 0 ? (
              <tr><td colSpan={3} className="px-3 py-3 text-center text-gray-400">{loading ? 'Loading…' : 'No usage recorded.'}</td></tr>
            ) : items.map((r) => (
              <tr key={r.key}>
                <td className="px-3 py-1.5 text-gray-700">{r.key}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-gray-600">{num(r.calls)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums font-semibold text-gray-800">{money(r.costUSD)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
