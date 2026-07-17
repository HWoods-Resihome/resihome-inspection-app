/**
 * components/insights/ServicesDashboard.tsx — Insights → Services tab (dark).
 *
 * Vendor-performance view: overall KPI tiles + a per-vendor performance table.
 * Reads /api/insights/services (computed from Service Work Orders); no snapshot
 * pipeline. Palette matches the inspections dashboard (page #0e0e11 · cards
 * #18181c · borders white/10 · pink #ff0060 · aqua #73E3DF for good outcomes).
 */
import { useEffect, useState } from 'react';
import type { ServiceInsights, SvcMetrics, VendorMetrics } from '@/lib/services/insights';

const pct = (n: number) => `${Math.round(n * 100)}%`;
const money = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-[#18181c] border border-white/10 rounded-2xl p-4">
      <div className="text-[11px] font-heading font-semibold uppercase tracking-wide text-[#a1a1aa] mb-1">{label}</div>
      <div className="text-2xl font-heading font-bold text-[#f4f4f5]">{value}</div>
      {sub && <div className="text-[11px] text-[#71717a] mt-0.5">{sub}</div>}
    </div>
  );
}

function KpiTiles({ m }: { m: SvcMetrics }) {
  return (
    <div className="grid gap-3 mb-5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
      <Tile label="Completed" value={pct(m.completedPct)} sub={`${m.completed} completed · ${m.total} total`} />
      <Tile label="On-time" value={pct(m.onTimePct)} sub="of completed" />
      <Tile label="Closed out" value={String(m.closedOut)} sub="completed services" />
      <Tile label="Bid items" value={pct(m.bidItemPct)} sub="of all services" />
      <Tile label="Reject / modify" value={pct(m.rejectModifyRate)} sub={`${m.reviewedCount} reviewed`} />
      <Tile label="Avg vendor cost" value={money(m.avgVendorCost)} sub="completed" />
    </div>
  );
}

function VendorTable({ rows }: { rows: VendorMetrics[] }) {
  if (!rows.length) return <p className="text-sm text-[#a1a1aa]">No vendor activity yet.</p>;
  const th = 'text-left text-[11px] font-heading font-semibold uppercase tracking-wide text-[#a1a1aa] px-3 py-2 whitespace-nowrap';
  const td = 'px-3 py-2 text-sm text-[#e4e4e7] whitespace-nowrap tabular-nums';
  return (
    <div className="bg-[#18181c] border border-white/10 rounded-2xl overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-white/10">
            <th className={th}>Vendor</th>
            <th className={th}>Services</th>
            <th className={th}>Completed</th>
            <th className={th}>On-time</th>
            <th className={th}>Bid</th>
            <th className={th}>Reject/Modify</th>
            <th className={th}>Avg cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((v) => (
            <tr key={v.vendor} className="border-b border-white/5 last:border-0">
              <td className={`${td} font-heading font-semibold text-[#f4f4f5]`}>{v.vendor}</td>
              <td className={td}>{v.total}</td>
              <td className={td}><span className="text-[#73E3DF]">{pct(v.completedPct)}</span> <span className="text-[#71717a]">({v.completed})</span></td>
              <td className={td}>{pct(v.onTimePct)}</td>
              <td className={td}>{pct(v.bidItemPct)}</td>
              <td className={td}><span className={v.rejectModifyRate > 0.2 ? 'text-[#ff0060]' : ''}>{pct(v.rejectModifyRate)}</span></td>
              <td className={td}>{money(v.avgVendorCost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ServicesDashboard() {
  const [data, setData] = useState<ServiceInsights | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'unconfigured' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/insights/services', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (cancelled) return;
        if (!d?.configured) { setState('unconfigured'); return; }
        setData(d.insights);
        setState('ready');
      })
      .catch(() => { if (!cancelled) setState('error'); });
    return () => { cancelled = true; };
  }, []);

  if (state === 'loading') {
    return <div className="text-center py-16"><div className="inline-block w-8 h-8 border-4 border-[#ff0060] border-t-transparent rounded-full animate-spin" /></div>;
  }
  if (state === 'unconfigured') {
    return <div className="bg-[#18181c] border border-white/10 rounded-2xl p-6 text-sm text-[#a1a1aa]">Services aren’t provisioned in this environment yet — no work orders to report on.</div>;
  }
  if (state === 'error' || !data) {
    return <div className="bg-[#18181c] border border-white/10 rounded-2xl p-6 text-sm text-[#a1a1aa]">Couldn’t load services insights. Try again shortly.</div>;
  }

  return (
    <div>
      <KpiTiles m={data.overall} />
      <h3 className="text-[12px] font-heading font-bold uppercase tracking-wide text-[#a1a1aa] mb-2">Per-vendor performance</h3>
      <VendorTable rows={data.perVendor} />
      <p className="text-[11px] text-[#71717a] mt-3">{data.rows} services · split billing lines rolled into their master. Completion excludes canceled; on-time and avg cost are over completed services.</p>
    </div>
  );
}
