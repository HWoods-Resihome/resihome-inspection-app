/**
 * /admin/regenerate-pdfs  (admin only)
 *
 * Retrofits the photo-gallery links into existing completed-scope PDFs by
 * re-finalizing each inspection. Re-finalize only regenerates the PDFs (no
 * email / ticket / xlsx / SFTP), so this is safe to run.
 *
 * Runs from the browser as the logged-in admin so each finalize call carries
 * the session + request origin (needed for the signed gallery links). Sequential
 * with a small delay to stay polite to HubSpot; shows live progress.
 */
import { useEffect, useRef, useState } from 'react';
import Head from 'next/head';

type LogLine = { id: string; ok: boolean; msg: string };

export default function RegeneratePdfsPage() {
  const [ids, setIds] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [okCount, setOkCount] = useState(0);
  const [failCount, setFailCount] = useState(0);
  const [log, setLog] = useState<LogLine[]>([]);
  const cancelRef = useRef(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/admin/regenerate-pdfs', { cache: 'no-store' });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        setIds(d.ids || []);
      } catch (e: any) {
        setError(String(e?.message || e));
      }
    })();
  }, []);

  async function run(limit?: number) {
    if (!ids || running) return;
    const list = typeof limit === 'number' ? ids.slice(0, limit) : ids;
    setRunning(true);
    cancelRef.current = false;
    setDone(0); setOkCount(0); setFailCount(0); setLog([]);
    for (let i = 0; i < list.length; i++) {
      if (cancelRef.current) break;
      const id = list[i];
      try {
        const r = await fetch(`/api/inspections/${id}/finalize`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
        });
        const d = await r.json().catch(() => ({}));
        if (r.ok) { setOkCount((n) => n + 1); setLog((l) => [{ id, ok: true, msg: 'PDFs regenerated' }, ...l].slice(0, 200)); }
        else { setFailCount((n) => n + 1); setLog((l) => [{ id, ok: false, msg: d.error || `HTTP ${r.status}` }, ...l].slice(0, 200)); }
      } catch (e: any) {
        setFailCount((n) => n + 1);
        setLog((l) => [{ id, ok: false, msg: String(e?.message || e).slice(0, 160) }, ...l].slice(0, 200));
      }
      setDone((n) => n + 1);
      await new Promise((res) => setTimeout(res, 400)); // be polite to HubSpot
    }
    setRunning(false);
  }

  if (error) {
    return <div className="min-h-screen flex items-center justify-center text-sm text-red-600 p-6">{error}</div>;
  }

  const total = ids?.length ?? 0;
  const pct = total ? Math.round((done / total) * 100) : 0;

  return (
    <div className="min-h-screen bg-gray-50">
      <Head><title>Regenerate PDFs</title></Head>
      <div className="max-w-2xl mx-auto px-5 py-6">
        <h1 className="font-heading font-extrabold text-xl text-ink">Regenerate Completed PDFs</h1>
        <p className="text-sm text-gray-600 mt-1 leading-relaxed">
          Re-finalizes every completed scope inspection to add the browsable photo gallery to its PDFs.
          Re-finalize only regenerates the PDFs — no email, ticket, xlsx, or SFTP. Keep this tab open
          while it runs.
        </p>

        {ids === null ? (
          <div className="mt-6 text-sm text-gray-500">Loading completed inspections…</div>
        ) : (
          <>
            <div className="mt-5 flex items-center gap-3 flex-wrap">
              <span className="text-sm text-gray-700"><b>{total}</b> completed scope inspections found.</span>
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
            </div>

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
