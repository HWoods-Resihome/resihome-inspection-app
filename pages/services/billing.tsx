import { useState } from 'react';
import { useRouter } from 'next/router';
import type { GetServerSideProps } from 'next';
import type { NextApiRequest } from 'next';
import { PageHeader } from '@/components/PageHeader';
import { DatePicker } from '@/components/DatePicker';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isInternalEmail } from '@/lib/userAccess';
import { isViewingAsVendor } from '@/lib/services/viewAs';
import { easternTodayISO } from '@/lib/services/sampleData';
import { buildBillingReport, type BillingReport } from '@/lib/services/billing';

// Default range = the current calendar month through today (a typical pay period).
const monthStart = (iso: string) => `${iso.slice(0, 7)}-01`;

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getSessionFromRequest(ctx.req as unknown as NextApiRequest).catch(() => null);
  const ok = await servicesEnabled(session?.email).catch(() => false);
  if (!ok) return { redirect: { destination: '/', permanent: false } };
  if (isViewingAsVendor(ctx.req) || !isInternalEmail(session?.email)) return { redirect: { destination: '/services', permanent: false } };

  const today = easternTodayISO();
  const from = String(ctx.query.from || monthStart(today)).slice(0, 10);
  const to = String(ctx.query.to || today).slice(0, 10);
  const report = await buildBillingReport(from, to).catch(() => null);
  return { props: { report, from, to, live: !!report } };
};

const money = (n: number) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtMDY = (iso: string): string => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${Number(m[2])}-${Number(m[3])}-${m[1].slice(2)}` : iso; };

export default function ServicesBilling({ report, from, to, live }: { report: BillingReport | null; from: string; to: string; live: boolean }) {
  const router = useRouter();
  const [f, setF] = useState(from);
  const [t, setT] = useState(to);
  const [busy, setBusy] = useState(false);

  const apply = (nf: string, nt: string) => {
    setBusy(true);
    router.push({ pathname: '/services/billing', query: { from: nf || '', to: nt || '' } }).finally(() => setBusy(false));
  };
  const exportUrl = (format: 'csv' | 'xlsx') =>
    `/api/services/billing/export?format=${format}&from=${encodeURIComponent(f)}&to=${encodeURIComponent(t)}`;

  const ctl = 'text-[13px] px-2.5 py-2 border border-gray-300 rounded-lg bg-white text-ink';

  return (
    <div className="min-h-screen bg-gray-50">
      <PageHeader title="Billing" backHref="/services" homeHref="/services" />
      <main className="max-w-2xl mx-auto px-4 py-4 space-y-4">
        {/* Date-range filter + exports */}
        <section className="bg-white border border-gray-200 rounded-2xl p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">From</div>
              <DatePicker value={f} onChange={setF} className={ctl} ariaLabel="From date" />
            </div>
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">To</div>
              <DatePicker value={t} onChange={setT} className={ctl} ariaLabel="To date" />
            </div>
            <button type="button" onClick={() => apply(f, t)} disabled={busy}
              className="text-[13px] font-heading font-bold text-white bg-brand rounded-lg px-4 py-2 disabled:opacity-50">{busy ? '…' : 'Apply'}</button>
          </div>
          {live && report && report.count > 0 && (
            <div className="flex flex-wrap gap-2 mt-3">
              <a href={exportUrl('csv')} className="text-[12px] font-heading font-bold text-brand border border-brand/40 rounded-lg px-3 py-1.5 bg-white hover:bg-brand/5">Export CSV</a>
              <a href={exportUrl('xlsx')} className="text-[12px] font-heading font-bold text-brand border border-brand/40 rounded-lg px-3 py-1.5 bg-white hover:bg-brand/5">Export Excel</a>
            </div>
          )}
        </section>

        {!live && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-[13px] text-amber-800">
            Services billing isn’t configured yet (the Service Work Order object isn’t connected).
          </div>
        )}

        {live && report && (
          <>
            {/* Grand-total summary */}
            <section className="bg-white border border-gray-200 rounded-2xl p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-heading font-extrabold text-2xl text-ink tabular-nums">{money(report.vendorTotal)}</div>
                  <div className="text-[12px] text-gray-500">Vendor cost · {report.count} line{report.count === 1 ? '' : 's'} · {fmtMDY(report.from) || 'start'} → {fmtMDY(report.to) || 'today'}</div>
                </div>
                <div className="text-right">
                  <div className="font-heading font-bold text-lg text-emerald-700 tabular-nums">{money(report.clientTotal)}</div>
                  <div className="text-[12px] text-gray-500">Client cost</div>
                </div>
              </div>
            </section>

            {report.count === 0 && (
              <div className="bg-white border border-gray-200 rounded-2xl p-6 text-center text-[13px] text-gray-400">No billable services completed in this range.</div>
            )}

            {report.groups.map((g) => (
              <section key={g.vendor} className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
                <div className="flex items-center justify-between gap-2 px-4 py-2.5 bg-gray-50 border-b border-gray-200">
                  <div className="font-heading font-bold text-[15px] text-ink truncate">{g.vendor}</div>
                  <div className="text-[13px] font-heading font-bold text-ink tabular-nums shrink-0">{money(g.vendorTotal)}</div>
                </div>
                <ul className="divide-y divide-gray-100">
                  {g.lines.map((l) => (
                    <li key={l.id} className="flex items-center gap-3 px-4 py-2.5">
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] text-ink truncate">
                          {l.address || l.community}
                          {l.fromMaster && <span className="ml-1.5 text-[10px] font-bold uppercase tracking-wide text-brand align-middle">cut</span>}
                        </div>
                        <div className="text-[11px] text-gray-400 truncate">{fmtMDY(l.completedAt)} · {l.worktypeLabel} · {l.subtypeLabel}{l.reviewDecision === 'reject' ? ' · rejected' : ''}</div>
                      </div>
                      <div className="text-[13px] font-semibold text-ink tabular-nums shrink-0">{money(l.vendorCost)}</div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </>
        )}
      </main>
    </div>
  );
}
