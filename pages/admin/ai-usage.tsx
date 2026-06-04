/**
 * /admin/ai-usage  (admin only)
 *
 * At-a-glance AI spend dashboard: estimated cost + call/token counts for the
 * last N days, broken down by feature (source), model, and day. Data comes from
 * /api/admin/ai-usage, which sums per-instance daily rollup blobs written by
 * lib/aiUsage.ts. Costs are ESTIMATES (rate table in lib/aiUsage.ts); the
 * structured `[ai-usage]` logs are the authoritative record.
 */
import { useEffect, useState, useCallback } from 'react';
import Head from 'next/head';

type Bucket = { calls: number; inputTokens: number; outputTokens: number; costUSD: number };
type UsageResp = {
  ok: boolean;
  days: number;
  byDay: Record<string, Bucket>;
  bySource: Record<string, Bucket>;
  byModel: Record<string, Bucket>;
  total: Bucket;
};

const SOURCE_LABEL: Record<string, string> = {
  ai_review: 'AI Review',
  room_scan_live: 'Live Camera Scan',
  room_scan: 'Room Scan (video)',
  voice_assist: 'Voice Assistant',
  transcribe: 'Voice Transcription',
  embeddings: 'Catalog Embeddings',
};

const money = (n: number) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (n: number) => (Number(n) || 0).toLocaleString('en-US');

export default function AiUsagePage() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<UsageResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (d: number) => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/admin/ai-usage?days=${d}`, { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setData(j);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(days); }, [days, load]);

  // Sort helper: descending by cost.
  const rows = (rec: Record<string, Bucket> | undefined, label?: (k: string) => string) =>
    Object.entries(rec || {})
      .sort((a, b) => b[1].costUSD - a[1].costUSD)
      .map(([k, b]) => ({ key: label ? label(k) : k, ...b }));

  const dayRows = Object.entries(data?.byDay || {})
    .sort((a, b) => (a[0] < b[0] ? 1 : -1)) // newest first
    .map(([k, b]) => ({ key: k, ...b }));

  const Section = ({ title, col, items }: { title: string; col: string; items: ({ key: string } & Bucket)[] }) => (
    <div className="mt-6">
      <h2 className="font-heading font-bold text-sm text-ink mb-2">{title}</h2>
      <div className="border border-gray-200 rounded-lg bg-white overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-gray-50 text-gray-500">
            <tr>
              <th className="text-left font-semibold px-3 py-2">{col}</th>
              <th className="text-right font-semibold px-3 py-2">Calls</th>
              <th className="text-right font-semibold px-3 py-2">In tokens</th>
              <th className="text-right font-semibold px-3 py-2">Out tokens</th>
              <th className="text-right font-semibold px-3 py-2">Est. cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {items.length === 0 ? (
              <tr><td colSpan={5} className="px-3 py-4 text-center text-gray-400">No usage recorded.</td></tr>
            ) : items.map((r) => (
              <tr key={r.key}>
                <td className="px-3 py-2 text-gray-700">{r.key}</td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-600">{num(r.calls)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-600">{num(r.inputTokens)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-600">{num(r.outputTokens)}</td>
                <td className="px-3 py-2 text-right tabular-nums font-semibold text-gray-800">{money(r.costUSD)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  const total = data?.total;

  return (
    <div className="min-h-screen bg-gray-50">
      <Head><title>AI Usage &amp; Cost</title></Head>
      <div className="max-w-3xl mx-auto px-5 py-6">
        <h1 className="font-heading font-extrabold text-xl text-ink">AI Usage &amp; Cost</h1>
        <p className="text-sm text-gray-600 mt-1 leading-relaxed">
          Estimated spend across all AI features (review, camera scan, voice, transcription, embeddings).
          Costs are estimates from a rate table; the structured logs are authoritative.
        </p>

        <div className="mt-4 flex items-center gap-2">
          <span className="text-sm text-gray-600">Window:</span>
          {[1, 7, 30, 90].map((d) => (
            <button key={d} type="button" onClick={() => setDays(d)}
              className={`text-sm font-heading font-semibold px-3 py-1.5 rounded-lg border ${days === d ? 'bg-brand text-white border-brand' : 'border-gray-300 text-gray-700 hover:bg-gray-100'}`}>
              {d === 1 ? 'Today' : `${d}d`}
            </button>
          ))}
          <button type="button" onClick={() => load(days)} disabled={loading}
            className="text-sm font-heading font-semibold px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-100 disabled:opacity-40 ml-auto">
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        {error && <div className="mt-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

        {/* Headline total */}
        <div className="mt-5 grid grid-cols-3 gap-3">
          <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-gray-400 font-semibold">Est. cost ({data?.days ?? days}d)</div>
            <div className="text-2xl font-extrabold text-ink mt-1">{money(total?.costUSD || 0)}</div>
          </div>
          <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-gray-400 font-semibold">Total calls</div>
            <div className="text-2xl font-extrabold text-ink mt-1">{num(total?.calls || 0)}</div>
          </div>
          <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-gray-400 font-semibold">Tokens (in / out)</div>
            <div className="text-sm font-bold text-ink mt-2 tabular-nums">{num(total?.inputTokens || 0)} <span className="text-gray-400 font-normal">/</span> {num(total?.outputTokens || 0)}</div>
          </div>
        </div>

        <Section title="By feature" col="Feature" items={rows(data?.bySource, (k) => SOURCE_LABEL[k] || k)} />
        <Section title="By model" col="Model" items={rows(data?.byModel)} />
        <Section title="By day" col="Day" items={dayRows} />

        <p className="text-[11px] text-gray-400 mt-6 leading-relaxed">
          Persisted via per-instance daily rollup blobs (throttled writes), so very recent calls may lag a few seconds
          and a reclaimed cold instance can drop its small tail. For exact accounting, query the <code>[ai-usage]</code> log lines.
        </p>
      </div>
    </div>
  );
}
