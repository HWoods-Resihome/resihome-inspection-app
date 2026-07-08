import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { GetServerSideProps } from 'next';
import type { NextApiRequest } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { WORKTYPES, worktypeLabel } from '@/lib/services/worktypes';
import {
  SAMPLE_SERVICES, SAMPLE_VENDORS, SAMPLE_STATUS_ORDER,
  type ServiceStatus,
} from '@/lib/services/sampleData';

// Gate: flag ON (off in production) AND app-admin. Hidden on resiwalk.com and
// from non-admins — a normal inspector who guesses the URL is bounced home.
export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getSessionFromRequest(ctx.req as unknown as NextApiRequest).catch(() => null);
  const ok = await servicesEnabled(session?.email).catch(() => false);
  if (!ok) return { redirect: { destination: '/', permanent: false } };
  return { props: {} };
};

const STATUS_LABEL: Record<ServiceStatus, string> = {
  scheduled: 'Scheduled', dispatched: 'Dispatched', in_progress: 'In Progress',
  submitted: 'Submitted', completed: 'Completed', cancelled: 'Cancelled',
};
const STATUS_STYLE: Record<ServiceStatus, string> = {
  scheduled: 'bg-gray-100 text-gray-700 border-gray-300',
  dispatched: 'bg-sky-100 text-sky-800 border-sky-300',
  in_progress: 'bg-amber-100 text-amber-800 border-amber-300',
  submitted: 'bg-purple-100 text-purple-800 border-purple-300',
  completed: 'bg-green-100 text-green-800 border-green-300',
  cancelled: 'bg-gray-100 text-gray-500 border-gray-300 line-through',
};

type SortField = 'due' | 'address' | 'worktype' | 'vendor' | 'status';
const SORT_OPTIONS: { value: SortField; label: string }[] = [
  { value: 'due', label: 'Due date' },
  { value: 'address', label: 'Address' },
  { value: 'worktype', label: 'Service type' },
  { value: 'vendor', label: 'Vendor' },
  { value: 'status', label: 'Status' },
];

function fmtDue(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return iso;
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${String(d.getUTCFullYear()).slice(-2)}`;
}

export default function ServicesHome() {
  const [status, setStatus] = useState<ServiceStatus | 'all'>('all');
  const [worktype, setWorktype] = useState<string>('all');
  const [vendor, setVendor] = useState<string>('all');
  const [sortField, setSortField] = useState<SortField>('due');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: SAMPLE_SERVICES.filter((s) => s.status !== 'cancelled').length };
    for (const st of SAMPLE_STATUS_ORDER) c[st] = SAMPLE_SERVICES.filter((s) => s.status === st).length;
    return c;
  }, []);

  const rows = useMemo(() => {
    let list = SAMPLE_SERVICES.filter((s) => s.status !== 'cancelled');
    if (status !== 'all') list = list.filter((s) => s.status === status);
    if (worktype !== 'all') list = list.filter((s) => s.worktype === worktype);
    if (vendor !== 'all') list = list.filter((s) => (s.vendor || '—') === vendor);
    const dir = sortDir === 'asc' ? 1 : -1;
    const key = (s: typeof list[number]) => {
      switch (sortField) {
        case 'due': return s.dueDate;
        case 'address': return s.address.toLowerCase();
        case 'worktype': return worktypeLabel(s.worktype);
        case 'vendor': return (s.vendor || '~').toLowerCase();
        case 'status': return String(SAMPLE_STATUS_ORDER.indexOf(s.status)).padStart(2, '0');
      }
    };
    return [...list].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) * dir);
  }, [status, worktype, vendor, sortField, sortDir]);

  const chip = (val: ServiceStatus | 'all', label: string) => (
    <button
      type="button"
      onClick={() => setStatus(val)}
      className={`flex-1 text-[11px] font-heading font-semibold px-2 py-1.5 rounded-full border transition whitespace-nowrap ${
        status === val ? 'bg-brand text-white border-brand' : 'bg-white text-ink border-gray-300 hover:border-brand/50'
      }`}
    >
      {label}{val === 'all' ? ` (${counts.all})` : counts[val] ? ` (${counts[val]})` : ''}
    </button>
  );

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header — mirrors the inspections home, with the Inspections↔Services
          toggle and the admin gear to the (admin-only) rules engine. */}
      <header className="sticky top-0 z-20 bg-white border-b border-gray-200">
        <div className="max-w-3xl mx-auto px-4 py-2.5 flex items-center gap-3">
          <img src="/favicon.svg" alt="ResiWalk" className="h-8 w-8 object-contain shrink-0" />
          <div className="min-w-0">
            <div className="font-heading font-extrabold text-ink leading-none">ResiWalk <span className="text-brand">Services</span></div>
            <div className="text-[11px] text-gray-500 leading-tight mt-0.5">Recurring field services</div>
          </div>
          <span className="ml-1 text-[9px] font-bold uppercase tracking-wider text-white bg-purple-600 px-1.5 py-0.5 rounded">Sample</span>
          <div className="flex-1" />
          {/* Inspections ↔ Services toggle */}
          <div className="inline-flex rounded-lg border border-gray-300 bg-gray-100 p-0.5 text-[12px] font-heading font-semibold">
            <Link href="/" className="px-3 py-1 rounded-md text-gray-600 hover:text-ink">Inspections</Link>
            <span className="px-3 py-1 rounded-md bg-white text-brand shadow-sm">Services</span>
          </div>
          <Link
            href="/services/rules"
            title="Rules Engine (admin)"
            aria-label="Rules Engine settings"
            className="shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-lg border border-gray-300 bg-white text-gray-600 hover:text-brand hover:border-brand/50 transition-colors"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
          </Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-3">
        <div className="mb-2 text-[11px] text-gray-500">
          Preview with <b className="text-gray-700">sample</b> services — the list connects to the real Services object in a later step.
        </div>

        {/* status chips */}
        <div className="space-y-1.5 mb-3">
          <div className="flex gap-1.5">
            {chip('all', 'All')}{chip('scheduled', 'Scheduled')}{chip('dispatched', 'Dispatched')}
          </div>
          <div className="flex gap-1.5">
            {chip('in_progress', 'In Progress')}{chip('submitted', 'Submitted')}{chip('completed', 'Completed')}
          </div>
        </div>

        {/* filter + sort row */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <select value={worktype} onChange={(e) => setWorktype(e.target.value)}
            className="text-[12px] font-heading font-semibold px-2 py-1.5 border border-gray-300 rounded-md bg-white text-ink">
            <option value="all">All service types</option>
            {WORKTYPES.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
          </select>
          <select value={vendor} onChange={(e) => setVendor(e.target.value)}
            className="text-[12px] font-heading font-semibold px-2 py-1.5 border border-gray-300 rounded-md bg-white text-ink">
            <option value="all">All vendors</option>
            {SAMPLE_VENDORS.map((v) => <option key={v} value={v}>{v}</option>)}
            <option value="—">Unassigned</option>
          </select>
          <div className="flex-1" />
          <select value={sortField} onChange={(e) => setSortField(e.target.value as SortField)}
            className="text-[12px] font-heading font-semibold px-2 py-1.5 border border-gray-300 rounded-md bg-white text-ink">
            {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>Sort: {o.label}</option>)}
          </select>
          <button type="button" onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
            title="Toggle sort direction"
            className="inline-flex items-center justify-center w-9 h-9 rounded-md border border-gray-300 bg-white text-gray-600 hover:text-brand hover:border-brand/50">
            {sortDir === 'asc' ? '↑' : '↓'}
          </button>
        </div>

        {/* list */}
        <div className="space-y-2">
          {rows.map((s) => (
            <div key={s.id} className="block bg-white border border-gray-200 rounded-xl px-4 py-3 hover:border-brand/40 transition-colors">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-heading font-bold text-ink truncate">{s.address}</span>
                    <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${s.scope === 'community' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>
                      {s.scope === 'community' ? 'Community' : 'SFR'}
                    </span>
                  </div>
                  <div className="text-[12px] text-gray-500 truncate">{s.locality}{s.community ? ` · ${s.community}` : ''}</div>
                  <div className="text-[12px] text-gray-600 mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
                    <span className="font-semibold text-ink">{worktypeLabel(s.worktype)}</span>
                    <span>{s.vendor || <span className="text-brand font-semibold">Unassigned</span>}</span>
                    <span>Due {fmtDue(s.dueDate)}</span>
                    <span className="text-gray-400">{s.portfolio}</span>
                  </div>
                </div>
                <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-heading font-semibold border shrink-0 ${STATUS_STYLE[s.status]}`}>
                  {STATUS_LABEL[s.status]}
                </span>
              </div>
            </div>
          ))}
          {rows.length === 0 && (
            <div className="text-center text-gray-500 text-sm py-12 border border-dashed border-gray-300 rounded-xl">
              No services match these filters.
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
