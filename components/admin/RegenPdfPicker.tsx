/**
 * Combined "Regenerate PDFs" admin tool: pick which inspection TYPES to
 * regenerate, then run with live progress. One page covering every report type.
 *
 * Lists all regeneratable inspections (/api/admin/regenerate-list, each tagged
 * with a route), groups them by template type with a checkbox + count, and on
 * Run dispatches each selected id to the right endpoint:
 *   scope → POST /api/inspections/<id>/finalize { regenerateOnly:true }
 *   qa    → GET  /api/admin/regenerate-inspection-pdfs?id=<id>
 *   qc    → GET  /api/admin/regenerate-qc-pdfs?id=<id>
 *
 * Bounded concurrency + auto-retry, progress bar + live log, CSV export. Keep
 * the tab open while it runs.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import Head from 'next/head';

type Route = 'scope' | 'qa' | 'qc';
type Item = { id: string; templateType: string; label: string; address: string; status: string; route: Route; date?: string };

// "Last N days" windows for the regen filter (0 = all time).
const DAY_WINDOWS: { value: number; label: string }[] = [
  { value: 0, label: 'All time' },
  { value: 7, label: 'Last 7 days' },
  { value: 14, label: 'Last 14 days' },
  { value: 30, label: 'Last 30 days' },
  { value: 90, label: 'Last 90 days' },
];
type LogLine = { id: string; ok: boolean; msg: string };

const CONCURRENCY = 3;
const MAX_RETRY = 2;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Which Scope Rate Card PDF(s) to rebuild. 'all' keeps the original behavior
// (Master + Chargeback + every vendor). The rest regenerate just that kind and
// leave the other PDFs' stored URLs untouched. Vendors are generic slots
// ("Vendor 1"…), so a specific vendor that doesn't exist on a given inspection
// is simply skipped for that one.
const SCOPE_KINDS: { value: string; label: string }[] = [
  { value: 'all', label: 'All PDFs (Master + Chargeback + Vendors)' },
  { value: 'master', label: 'Master only' },
  { value: 'chargeback', label: 'Tenant Chargeback only' },
  { value: 'vendor', label: 'All Vendor PDFs' },
  { value: 'vendor:Vendor 1', label: 'Vendor 1 only' },
  { value: 'vendor:Vendor 2', label: 'Vendor 2 only' },
  { value: 'vendor:Vendor 3', label: 'Vendor 3 only' },
];

// Translate a SCOPE_KINDS value into the finalize request body for a scope regen.
function scopeRegenBody(kind: string): Record<string, any> {
  if (kind === 'all' || !kind) return { regenerateOnly: true };
  if (kind.startsWith('vendor:')) {
    return { regenerateOnly: true, regenerateTypes: ['vendor'], regenerateVendor: kind.slice('vendor:'.length) };
  }
  return { regenerateOnly: true, regenerateTypes: [kind] };
}

export function RegenPdfPicker({ embedded = false }: { embedded?: boolean } = {}) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set()); // selected templateTypes
  const [scopeKind, setScopeKind] = useState<string>('all'); // which Scope PDF(s) to regenerate
  const [days, setDays] = useState<number>(0); // "last N days" window (0 = all time)
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [okCount, setOkCount] = useState(0);
  const [failCount, setFailCount] = useState(0);
  const [log, setLog] = useState<LogLine[]>([]);
  const cancelRef = useRef(false);
  const resultsRef = useRef<LogLine[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/admin/regenerate-list', { cache: 'no-store' });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        const its: Item[] = d.items || [];
        setItems(its);
        // Default: every type selected.
        setSelected(new Set(its.map((i) => i.templateType)));
      } catch (e: any) {
        setError(String(e?.message || e));
      }
    })();
  }, []);

  // Apply the "last N days" window (by each inspection's completed/created date).
  const visibleItems = useMemo(() => {
    if (!days) return items || [];
    const cutoff = Date.now() - days * 864e5;
    return (items || []).filter((i) => { const t = Date.parse(i.date || ''); return isFinite(t) && t >= cutoff; });
  }, [items, days]);

  // Group by template type, preserving first-seen order (within the day window).
  const groups = useMemo(() => {
    const m = new Map<string, { label: string; ids: string[] }>();
    for (const i of visibleItems) {
      let g = m.get(i.templateType);
      if (!g) { g = { label: i.label, ids: [] }; m.set(i.templateType, g); }
      g.ids.push(i.id);
    }
    return Array.from(m.entries()).map(([type, g]) => ({ type, ...g }));
  }, [visibleItems]);

  const byId = useMemo(() => {
    const m = new Map<string, Item>();
    for (const i of items || []) m.set(i.id, i);
    return m;
  }, [items]);

  // Route per template type (so we can show the Scope-only PDF-kind dropdown).
  const routeByType = useMemo(() => {
    const m = new Map<string, Route>();
    for (const i of items || []) if (!m.has(i.templateType)) m.set(i.templateType, i.route);
    return m;
  }, [items]);

  const selectedItems = useMemo(
    () => visibleItems.filter((i) => selected.has(i.templateType)),
    [visibleItems, selected],
  );

  function toggle(type: string) {
    setSelected((s) => { const n = new Set(s); if (n.has(type)) n.delete(type); else n.add(type); return n; });
  }

  // One inspection → the right endpoint for its route, with transient retry.
  async function regenOne(item: Item): Promise<LogLine> {
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      try {
        let ok = false; let status = 0; let errMsg = '';
        if (item.route === 'scope') {
          const r = await fetch(`/api/inspections/${item.id}/finalize`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scopeRegenBody(scopeKind)),
          });
          status = r.status;
          const d = await r.json().catch(() => ({} as any));
          ok = r.ok;
          errMsg = (d.error || `HTTP ${r.status}`).toString();
        } else {
          const base = item.route === 'qc' ? '/api/admin/regenerate-qc-pdfs' : '/api/admin/regenerate-inspection-pdfs';
          const r = await fetch(`${base}?id=${encodeURIComponent(item.id)}`, { cache: 'no-store' });
          status = r.status;
          const d = await r.json().catch(() => ({} as any));
          const res = (d.results && d.results[0]) || {};
          ok = r.ok && !!res.ok;
          errMsg = (res.error || d.error || `HTTP ${r.status}`).toString();
        }
        if (ok) return { id: item.id, ok: true, msg: 'ok' };
        if (status >= 500 && attempt < MAX_RETRY) { await delay(800 * (attempt + 1)); continue; }
        return { id: item.id, ok: false, msg: errMsg.slice(0, 200) };
      } catch (e: any) {
        if (attempt < MAX_RETRY) { await delay(800 * (attempt + 1)); continue; }
        return { id: item.id, ok: false, msg: String(e?.message || e).slice(0, 200) };
      }
    }
    return { id: item.id, ok: false, msg: 'failed after retries' };
  }

  async function run(testLimit?: number) {
    if (running) return;
    const list = typeof testLimit === 'number' ? selectedItems.slice(0, testLimit) : selectedItems;
    if (list.length === 0) return;
    setRunning(true);
    cancelRef.current = false;
    setDone(0); setOkCount(0); setFailCount(0); setLog([]);
    resultsRef.current = [];

    let next = 0;
    const worker = async () => {
      while (!cancelRef.current) {
        const idx = next++;
        if (idx >= list.length) return;
        const line = await regenOne(list[idx]);
        resultsRef.current.push(line);
        if (line.ok) setOkCount((n) => n + 1); else setFailCount((n) => n + 1);
        setLog((l) => [line, ...l].slice(0, 300));
        setDone((n) => n + 1);
        await delay(150);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
    setRunning(false);
  }

  function downloadCsv() {
    const rows = [['inspection_id', 'type', 'status', 'message'], ...resultsRef.current.map((r) => {
      const it = byId.get(r.id);
      return [r.id, it?.label || '', r.ok ? 'ok' : 'failed', r.msg];
    })];
    const csv = rows.map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `regenerate-results-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  if (error) return <div className={embedded ? 'text-sm text-red-600 p-2' : 'min-h-screen flex items-center justify-center text-sm text-red-600 p-6'}>{error}</div>;

  const totalSelected = selectedItems.length;
  const pct = totalSelected ? Math.round((done / totalSelected) * 100) : 0;

  // Embedded: render just the tool body (the host page provides the section
  // header + chrome). Standalone: keep the full-page layout for any direct visit.
  const body = (
    <>
      {!embedded && <h1 className="font-heading font-extrabold text-xl text-ink">Regenerate PDFs</h1>}
      <p className="text-sm text-gray-600 mt-1 leading-relaxed">
          Pick the inspection types to regenerate, then Run. PDFs are rebuilt <b>in place</b> from
          saved data — never changing status, bypassing approval, or sending any email/ticket. Keep
          this tab open while it runs.
        </p>

        {items === null ? (
          <div className="mt-6 text-sm text-gray-500">Loading inspections…</div>
        ) : (
          <>
            {/* Type picker */}
            <div className="mt-5 border border-gray-200 rounded-lg bg-white p-4">
              <div className="flex items-center justify-between">
                <h2 className="font-heading font-bold text-sm text-ink">Inspection types</h2>
                <div className="flex items-center gap-3 text-[12px]">
                  <button type="button" className="text-brand hover:underline" disabled={running}
                    onClick={() => setSelected(new Set(groups.map((g) => g.type)))}>Select all</button>
                  <button type="button" className="text-gray-500 hover:underline" disabled={running}
                    onClick={() => setSelected(new Set())}>None</button>
                </div>
              </div>
              {/* Date window: only regenerate inspections completed/created in the
                  last N days (e.g. "fix just the last 7 days"). Counts + run set
                  below update to match. */}
              <div className="mt-3 flex items-center gap-2 text-sm">
                <span className="text-gray-600">Only from:</span>
                <select value={days} disabled={running} onChange={(e) => setDays(Number(e.target.value))}
                  className="border border-gray-300 rounded-md px-2 py-1 text-sm bg-white">
                  {DAY_WINDOWS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
                </select>
              </div>
              {groups.length === 0 ? (
                <div className="mt-3 text-sm text-gray-500">No regeneratable inspections found.</div>
              ) : (
                <div className="mt-3 space-y-1.5">
                  {groups.map((g) => {
                    const isScope = routeByType.get(g.type) === 'scope';
                    return (
                      <div key={g.type}>
                        <label className="flex items-center gap-2.5 text-sm text-gray-700 cursor-pointer">
                          <input type="checkbox" disabled={running} checked={selected.has(g.type)} onChange={() => toggle(g.type)}
                            className="w-4 h-4 accent-brand" />
                          <span className="flex-1">{g.label}</span>
                          <span className="text-xs text-gray-400 tabular-nums">{g.ids.length}</span>
                        </label>
                        {/* Scope Rate Card: choose WHICH PDF(s) to rebuild so you
                            don't have to regenerate all of them every time. A
                            vertical radio list (not a cramped native dropdown) —
                            full-width, big tap targets, readable on a phone. */}
                        {isScope && selected.has(g.type) && (
                          <div className="mt-2 ml-7 rounded-lg border border-gray-200 bg-gray-50 p-2.5">
                            <div className="text-[11px] font-heading font-semibold text-gray-500 uppercase tracking-wide mb-1">
                              Which Scope PDFs to rebuild
                            </div>
                            <div className="space-y-0.5">
                              {SCOPE_KINDS.map((k) => (
                                <label
                                  key={k.value}
                                  className={`flex items-center gap-2.5 px-2 py-2 rounded-md cursor-pointer text-sm ${
                                    scopeKind === k.value ? 'bg-white border border-brand/40 text-ink font-semibold' : 'text-gray-700 hover:bg-white/70'
                                  }`}
                                >
                                  <input
                                    type="radio" name="scopeKind" value={k.value}
                                    checked={scopeKind === k.value} disabled={running}
                                    onChange={() => setScopeKind(k.value)}
                                    className="w-4 h-4 accent-brand shrink-0"
                                  />
                                  <span>{k.label}</span>
                                </label>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Run controls */}
            <div className="mt-5 flex items-center gap-3 flex-wrap">
              <span className="text-sm text-gray-700"><b>{totalSelected}</b> selected to regenerate.</span>
              <button type="button" disabled={running || totalSelected === 0} onClick={() => run(3)}
                className="text-sm font-heading font-semibold px-3 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-100 disabled:opacity-40">
                Run test (first 3)
              </button>
              <button type="button" disabled={running || totalSelected === 0} onClick={() => run()}
                className="text-sm font-heading font-semibold px-4 py-2 rounded-lg bg-brand text-white hover:bg-brand-dark disabled:opacity-40">
                Run selected ({totalSelected})
              </button>
              {running && (
                <button type="button" onClick={() => { cancelRef.current = true; }}
                  className="text-sm font-heading font-semibold px-3 py-2 rounded-lg border border-red-300 text-red-700 hover:bg-red-50">Stop</button>
              )}
              {!running && done > 0 && (
                <button type="button" onClick={downloadCsv}
                  className="text-sm font-heading font-semibold px-3 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-100">Download CSV</button>
              )}
            </div>
            <p className="text-[12px] text-gray-400 mt-2">Runs {CONCURRENCY} at a time, auto-retries transient failures up to {MAX_RETRY}×.</p>

            {(running || done > 0) && (
              <div className="mt-5">
                <div className="h-2 rounded-full bg-gray-200 overflow-hidden">
                  <div className="h-full bg-brand transition-all" style={{ width: `${pct}%` }} />
                </div>
                <div className="text-xs text-gray-600 mt-2">
                  {done}/{totalSelected} done · <span className="text-emerald-700 font-semibold">{okCount} ok</span> · <span className="text-red-700 font-semibold">{failCount} failed</span>
                  {running ? ' · running…' : ' · finished'}
                </div>
              </div>
            )}

            {log.length > 0 && (
              <div className="mt-4 border border-gray-200 rounded-lg bg-white divide-y divide-gray-100 max-h-[50vh] overflow-y-auto">
                {log.map((l, i) => (
                  <div key={`${l.id}-${i}`} className="px-3 py-1.5 text-xs flex items-center gap-2">
                    <span className={l.ok ? 'text-emerald-600' : 'text-red-600'}>{l.ok ? '✓' : '✕'}</span>
                    <span className="font-mono text-gray-500">{l.id}</span>
                    <span className="text-gray-400 truncate">{byId.get(l.id)?.label || ''}</span>
                    <span className={`ml-auto ${l.ok ? 'text-gray-500' : 'text-red-600'}`}>{l.msg}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
    </>
  );

  return embedded ? body : (
    <div className="min-h-screen bg-gray-50">
      <Head><title>Regenerate PDFs</title></Head>
      <div className="max-w-2xl mx-auto px-5 py-6">{body}</div>
    </div>
  );
}
