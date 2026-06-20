/**
 * Reusable admin "regenerate PDFs with live progress" runner.
 *
 * Drives any of the per-id regenerate endpoints that expose:
 *   GET <apiBase>?list        → { ids: string[], count }
 *   GET <apiBase>?id=<id>     → { ok, results: [{ id, ok, pdfUrl?, error? }] }
 *
 * Mirrors /admin/regenerate-pdfs (the Scope page): a single-inspection preview,
 * a bounded-concurrency run with auto-retry, a progress bar + live log, and a
 * CSV export. Keep the tab open while it runs.
 */
import { useEffect, useRef, useState } from 'react';
import Head from 'next/head';

type LogLine = { id: string; ok: boolean; msg: string };

export function RegenPdfRunner(props: {
  title: string;
  description: React.ReactNode;
  apiBase: string;       // e.g. '/api/admin/regenerate-qc-pdfs'
  noun: string;          // e.g. 'QC inspections'
}) {
  const { apiBase, noun } = props;
  const [ids, setIds] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [okCount, setOkCount] = useState(0);
  const [failCount, setFailCount] = useState(0);
  const [log, setLog] = useState<LogLine[]>([]);
  const cancelRef = useRef(false);
  const resultsRef = useRef<LogLine[]>([]);

  const [oneId, setOneId] = useState('');
  const [oneBusy, setOneBusy] = useState(false);
  const [oneErr, setOneErr] = useState<string | null>(null);
  const [oneLink, setOneLink] = useState<string | null>(null);

  const CONCURRENCY = 3;
  const MAX_RETRY = 2;

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${apiBase}?list=1`, { cache: 'no-store' });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        setIds(d.ids || []);
      } catch (e: any) {
        setError(String(e?.message || e));
      }
    })();
  }, [apiBase]);

  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function regenOne(id: string): Promise<{ line: LogLine; pdfUrl?: string }> {
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      try {
        const r = await fetch(`${apiBase}?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
        const d = await r.json().catch(() => ({} as any));
        const res = (d.results && d.results[0]) || {};
        if (r.ok && res.ok) return { line: { id, ok: true, msg: 'ok' }, pdfUrl: res.pdfUrl };
        if (r.status >= 500 && attempt < MAX_RETRY) { await delay(800 * (attempt + 1)); continue; }
        return { line: { id, ok: false, msg: (res.error || d.error || `HTTP ${r.status}`).toString().slice(0, 200) } };
      } catch (e: any) {
        if (attempt < MAX_RETRY) { await delay(800 * (attempt + 1)); continue; }
        return { line: { id, ok: false, msg: String(e?.message || e).slice(0, 200) } };
      }
    }
    return { line: { id, ok: false, msg: 'failed after retries' } };
  }

  async function run(limit?: number) {
    if (!ids || running) return;
    const list = typeof limit === 'number' ? ids.slice(0, limit) : ids;
    setRunning(true);
    cancelRef.current = false;
    setDone(0); setOkCount(0); setFailCount(0); setLog([]);
    resultsRef.current = [];

    let next = 0;
    const worker = async () => {
      while (!cancelRef.current) {
        const idx = next++;
        if (idx >= list.length) return;
        const { line } = await regenOne(list[idx]);
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

  async function previewOne() {
    const id = oneId.trim();
    if (!id || oneBusy) return;
    setOneBusy(true); setOneErr(null); setOneLink(null);
    const { line, pdfUrl } = await regenOne(id);
    if (line.ok) setOneLink(pdfUrl || null);
    else setOneErr(line.msg);
    setOneBusy(false);
  }

  function downloadCsv() {
    const rows = [['inspection_id', 'status', 'message'], ...resultsRef.current.map((r) => [r.id, r.ok ? 'ok' : 'failed', r.msg])];
    const csv = rows.map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `regenerate-results-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  if (error) {
    return <div className="min-h-screen flex items-center justify-center text-sm text-red-600 p-6">{error}</div>;
  }

  const total = ids?.length ?? 0;
  const pct = total ? Math.round((done / total) * 100) : 0;

  return (
    <div className="min-h-screen bg-gray-50">
      <Head><title>{props.title}</title></Head>
      <div className="max-w-2xl mx-auto px-5 py-6">
        <h1 className="font-heading font-extrabold text-xl text-ink">{props.title}</h1>
        <p className="text-sm text-gray-600 mt-1 leading-relaxed">{props.description}</p>

        {/* Single-inspection preview. */}
        <div className="mt-5 border border-gray-200 rounded-lg bg-white p-4">
          <h2 className="font-heading font-bold text-sm text-ink">Preview one inspection</h2>
          <p className="text-[12px] text-gray-500 mt-1">Paste an inspection record ID to regenerate just that one and open its new PDF.</p>
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <input
              value={oneId}
              onChange={(e) => setOneId(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') previewOne(); }}
              placeholder="Inspection record ID"
              className="text-sm px-3 py-2 rounded-lg border border-gray-300 flex-1 min-w-[200px] font-mono"
            />
            <button type="button" disabled={oneBusy || !oneId.trim()} onClick={previewOne}
              className="text-sm font-heading font-semibold px-4 py-2 rounded-lg bg-brand text-white hover:bg-brand-dark disabled:opacity-40">
              {oneBusy ? 'Regenerating…' : 'Regenerate'}
            </button>
          </div>
          {oneErr && <div className="mt-3 text-xs text-red-600">{oneErr}</div>}
          {oneLink && (
            <div className="mt-3">
              <div className="text-xs text-emerald-700 font-semibold mb-1.5">✓ Regenerated — open to preview:</div>
              <a href={oneLink} target="_blank" rel="noopener noreferrer" className="text-sm text-brand hover:underline break-all">Open PDF</a>
            </div>
          )}
        </div>

        {ids === null ? (
          <div className="mt-6 text-sm text-gray-500">Loading inspections…</div>
        ) : (
          <>
            <div className="mt-5 flex items-center gap-3 flex-wrap">
              <span className="text-sm text-gray-700"><b>{total}</b> completed {noun} found.</span>
              <button type="button" disabled={running || total === 0} onClick={() => run(3)}
                className="text-sm font-heading font-semibold px-3 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-100 disabled:opacity-40">
                Run test (first 3)
              </button>
              <button type="button" disabled={running || total === 0} onClick={() => run()}
                className="text-sm font-heading font-semibold px-4 py-2 rounded-lg bg-brand text-white hover:bg-brand-dark disabled:opacity-40">
                Run all ({total})
              </button>
              {running && (
                <button type="button" onClick={() => { cancelRef.current = true; }}
                  className="text-sm font-heading font-semibold px-3 py-2 rounded-lg border border-red-300 text-red-700 hover:bg-red-50">
                  Stop
                </button>
              )}
              {!running && done > 0 && (
                <button type="button" onClick={downloadCsv}
                  className="text-sm font-heading font-semibold px-3 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-100">
                  Download CSV
                </button>
              )}
            </div>
            <p className="text-[12px] text-gray-400 mt-2">Runs {CONCURRENCY} at a time, auto-retries transient failures up to {MAX_RETRY}×. Keep this tab open while it runs.</p>

            {(running || done > 0) && (
              <div className="mt-5">
                <div className="h-2 rounded-full bg-gray-200 overflow-hidden">
                  <div className="h-full bg-brand transition-all" style={{ width: `${pct}%` }} />
                </div>
                <div className="text-xs text-gray-600 mt-2">
                  {done} done · <span className="text-emerald-700 font-semibold">{okCount} ok</span> · <span className="text-red-700 font-semibold">{failCount} failed</span>
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
                    <span className={`ml-auto ${l.ok ? 'text-gray-500' : 'text-red-600'}`}>{l.msg}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
