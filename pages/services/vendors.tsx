import Link from 'next/link';
import type { GetServerSideProps } from 'next';
import type { NextApiRequest } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getSessionFromRequest(ctx.req as unknown as NextApiRequest).catch(() => null);
  const ok = await servicesEnabled(session?.email).catch(() => false);
  if (!ok) return { redirect: { destination: '/', permanent: false } };
  return { props: {} };
};

export default function VendorAssignment() {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-brand text-white sticky top-0 z-20">
        <div className="max-w-3xl mx-auto px-4 py-2.5 flex items-center gap-3">
          <Link href="/services" className="inline-flex items-center gap-1 text-white/90 hover:text-white text-sm font-semibold shrink-0">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>
            Services
          </Link>
          <img src="/app-icon.svg" alt="ResiWalk" className="h-7 w-7 object-cover shrink-0" />
          <div className="font-heading font-extrabold">Vendor Assignment</div>
          <span className="text-[9px] font-bold uppercase tracking-wider bg-white/20 px-1.5 py-0.5 rounded">Admin</span>
        </div>
      </header>
      <main className="max-w-2xl mx-auto px-4 py-16 text-center">
        <div className="w-14 h-14 rounded-2xl bg-brand/10 text-brand grid place-items-center text-2xl mx-auto mb-4">🧭</div>
        <h1 className="font-heading font-extrabold text-2xl text-ink">Vendor Assignment</h1>
        <p className="text-gray-500 text-sm mt-2 max-w-md mx-auto">
          Coming soon. This is where vendors are matched to services by coverage
          (regions &amp; counties), capacity, and on-time performance — separate from
          the Rules Engine, which only creates the services.
        </p>
        <div className="inline-block mt-5 text-[11px] font-bold uppercase tracking-wider text-gray-400 border border-gray-300 rounded-full px-3 py-1">Coming Soon</div>
      </main>
    </div>
  );
}
