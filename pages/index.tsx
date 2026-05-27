import Link from 'next/link';
import Head from 'next/head';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import type { InspectionSummary } from '@/lib/types';
import { InspectionCard } from '@/components/InspectionCard';

interface MeUser { userId: string; email: string; name: string; }

type StatusFilter = 'all' | 'scheduled' | 'in_progress' | 'completed' | 'cancelled';

export default function Home() {
  const router = useRouter();
  const [hasLogo, setHasLogo] = useState(false);
  const [me, setMe] = useState<MeUser | null>(null);

  const [inspections, setInspections] = useState<InspectionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  useEffect(() => {
    const img = new window.Image();
    img.onload = () => setHasLogo(true);
    img.onerror = () => setHasLogo(false);
    img.src = '/logo.png';
  }, []);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((data) => { if (data.authenticated) setMe(data.user); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch('/api/inspections')
      .then((r) => r.json())
      .then((data) => {
        if (data.error) setError(data.error);
        else setInspections(data.inspections || []);
      })
      .catch((e) => setError(String(e.message || e)))
      .finally(() => setLoading(false));
  }, []);

  async function handleLogout() {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
    router.replace('/login');
  }

  // Apply search + status filter to the inspection list
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const wantStatus = statusFilter;
    return inspections.filter((i) => {
      // Search filter (matches against property address)
      if (q && !i.propertyAddressSnapshot.toLowerCase().includes(q)) return false;
      // Status filter
      if (wantStatus === 'all') return true;
      const s = (i.status || '').trim().toLowerCase();
      if (wantStatus === 'scheduled') return s === 'scheduled';
      if (wantStatus === 'in_progress') return s === 'in progress' || s === 'in-progress';
      if (wantStatus === 'completed') return s === 'completed' || s === 'complete' || s === 'submitted';
      if (wantStatus === 'cancelled') return s === 'cancelled' || s === 'canceled';
      return true;
    });
  }, [inspections, search, statusFilter]);

  // Count by status for filter chips
  const counts = useMemo(() => {
    const c = { all: inspections.length, scheduled: 0, in_progress: 0, completed: 0, cancelled: 0 };
    for (const i of inspections) {
      const s = (i.status || '').trim().toLowerCase();
      if (s === 'scheduled') c.scheduled++;
      else if (s === 'in progress' || s === 'in-progress') c.in_progress++;
      else if (s === 'completed' || s === 'complete' || s === 'submitted') c.completed++;
      else if (s === 'cancelled' || s === 'canceled') c.cancelled++;
    }
    return c;
  }, [inspections]);

  return (
    <>
      <Head>
        <title>ResiHome Inspection</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
      </Head>
      <main className="min-h-screen bg-gray-50">
        {/* Pink branded header */}
        <header className="bg-brand text-white">
          <div className="max-w-3xl mx-auto px-4 pt-4 pb-5">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div className="flex items-center gap-3 min-w-0">
                {hasLogo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src="/logo.png"
                    alt="ResiHome"
                    className="h-10 w-10 object-contain rounded-lg bg-white p-1 shadow"
                  />
                ) : (
                  <div className="h-10 w-10 flex items-center justify-center bg-white text-brand rounded-lg font-heading font-extrabold">
                    RH
                  </div>
                )}
                <div className="min-w-0">
                  <h1 className="font-heading font-extrabold text-lg tracking-tight">
                    ResiHome Inspections
                  </h1>
                  {me && (
                    <div className="text-xs text-white/80 truncate">Welcome, {me.name}</div>
                  )}
                </div>
              </div>
              <button
                onClick={handleLogout}
                className="text-xs font-heading font-semibold text-white/90 hover:text-white whitespace-nowrap"
              >
                Sign Out
              </button>
            </div>

            {/* + New Inspection button */}
            <Link
              href="/inspection/new"
              className="flex items-center gap-3 bg-white/15 hover:bg-white/25 rounded-xl px-4 py-3 transition active:scale-[0.99]"
            >
              <div className="w-9 h-9 bg-white rounded-lg flex items-center justify-center shrink-0">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="text-brand">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </div>
              <span className="font-heading font-bold text-base">New Inspection</span>
            </Link>
          </div>
        </header>

        {/* Search + Filters */}
        <div className="max-w-3xl mx-auto px-4 pt-4 pb-2">
          <div className="relative mb-3">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                 className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              placeholder="Search by address..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="focus-brand w-full pl-9 pr-3 py-2.5 text-sm border border-gray-300 rounded-lg bg-white"
            />
          </div>

          {/* Filter chips */}
          <div className="flex flex-wrap gap-1.5 mb-3">
            <FilterChip label={`All (${counts.all})`} active={statusFilter === 'all'} onClick={() => setStatusFilter('all')} />
            <FilterChip label={`Scheduled (${counts.scheduled})`} active={statusFilter === 'scheduled'} onClick={() => setStatusFilter('scheduled')} />
            <FilterChip label={`In Progress (${counts.in_progress})`} active={statusFilter === 'in_progress'} onClick={() => setStatusFilter('in_progress')} />
            <FilterChip label={`Completed (${counts.completed})`} active={statusFilter === 'completed'} onClick={() => setStatusFilter('completed')} />
            {counts.cancelled > 0 && (
              <FilterChip label={`Cancelled (${counts.cancelled})`} active={statusFilter === 'cancelled'} onClick={() => setStatusFilter('cancelled')} />
            )}
          </div>

          <div className="text-xs text-gray-500 font-heading mb-3">
            {loading ? 'Loading...' : `${filtered.length} of ${inspections.length} inspection${inspections.length === 1 ? '' : 's'}`}
          </div>
        </div>

        {/* Inspection list */}
        <div className="max-w-3xl mx-auto px-4 pb-12">
          {loading && (
            <div className="text-sm text-gray-500 text-center py-8">Loading inspections...</div>
          )}
          {error && !loading && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700 mb-3">
              Could not load inspections: {error}
            </div>
          )}
          {!loading && !error && filtered.length === 0 && (
            <div className="text-center py-12">
              <div className="text-sm text-gray-500 mb-2">
                {inspections.length === 0 ? 'No inspections yet.' : 'No matching inspections.'}
              </div>
              {inspections.length === 0 && (
                <div className="text-xs text-gray-400">
                  Tap "+ New Inspection" above to get started.
                </div>
              )}
            </div>
          )}
          {filtered.map((i) => (
            <InspectionCard key={i.recordId} inspection={i} />
          ))}
        </div>
      </main>
    </>
  );
}

interface ChipProps {
  label: string;
  active: boolean;
  onClick: () => void;
}

function FilterChip({ label, active, onClick }: ChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-xs font-heading font-semibold px-3 py-1.5 rounded-full border transition whitespace-nowrap ${
        active
          ? 'bg-brand text-white border-brand'
          : 'bg-white text-ink border-gray-300 hover:border-brand/50'
      }`}
    >
      {label}
    </button>
  );
}
