import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { GetServerSideProps } from 'next';
import type { NextApiRequest } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isInternalEmail } from '@/lib/userAccess';
import { WORKTYPES } from '@/lib/services/worktypes';
import { SAMPLE_PROPERTIES, SAMPLE_COMMUNITIES, SAMPLE_VENDORS } from '@/lib/services/sampleData';

// Internal users (@resihome / @resicap / …) only — creating a manual service is an
// internal action. Also flag+admin gated like the rest of /services.
export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getSessionFromRequest(ctx.req as unknown as NextApiRequest).catch(() => null);
  const ok = await servicesEnabled(session?.email).catch(() => false);
  if (!ok || !isInternalEmail(session?.email)) return { redirect: { destination: '/services', permanent: false } };
  return { props: {} };
};

export default function NewService() {
  const [worktype, setWorktype] = useState('');
  const [scope, setScope] = useState<'property' | 'community'>('property');
  const [target, setTarget] = useState('');   // property id or community name
  const [dueDate, setDueDate] = useState('');
  const [vendor, setVendor] = useState('');
  const [created, setCreated] = useState(false);

  const worktypeOptions = useMemo(() => WORKTYPES.filter((w) => w.scopes.includes(scope)), [scope]);
  const ctl = 'w-full text-sm border border-gray-300 rounded-lg px-3 py-2.5 bg-white text-ink focus:outline-none focus:border-brand';
  const lbl = 'block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1.5';

  const ready = !!worktype && !!target && !!dueDate && !!vendor;
  const targetLabel = scope === 'property'
    ? (SAMPLE_PROPERTIES.find((p) => p.id === target)?.address || '')
    : target;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="bg-brand text-white sticky top-0 z-20" style={{ paddingTop: 'min(env(safe-area-inset-top), 0.5rem)' }}>
        <div className="max-w-2xl mx-auto px-4 pt-2 pb-2.5 flex items-center gap-3">
          <Link href="/services" className="inline-flex items-center gap-1 text-white/90 hover:text-white text-sm font-semibold shrink-0">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>
            Services
          </Link>
          <div className="font-heading font-extrabold">New Service</div>
          <span className="text-[9px] font-bold uppercase tracking-wider bg-white/20 px-1.5 py-0.5 rounded">Sample</span>
        </div>
      </header>

      <main className="max-w-2xl mx-auto w-full px-4 py-4 flex-1">
        {created ? (
          <div className="bg-white border border-emerald-300 rounded-2xl p-6 text-center">
            <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-700 grid place-items-center text-2xl mx-auto mb-3">✓</div>
            <div className="font-heading font-extrabold text-lg text-ink">Service created</div>
            <p className="text-sm text-gray-500 mt-1">Assigned to <b>{vendor}</b>, due {dueDate}. (Preview — nothing saved.)</p>
            <div className="flex gap-2 justify-center mt-4">
              <button onClick={() => { setCreated(false); setWorktype(''); setTarget(''); setDueDate(''); setVendor(''); }} className="border border-gray-300 bg-white rounded-xl px-4 py-2 font-heading font-bold text-sm">Create another</button>
              <Link href="/services" className="bg-brand text-white rounded-xl px-5 py-2 font-heading font-bold text-sm">Back to Services</Link>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <section className="bg-white border border-gray-200 rounded-2xl p-4 space-y-4">
              <div className="field">
                <label className={lbl}>Coverage type</label>
                <div className="inline-flex rounded-lg border border-gray-300 bg-gray-100 p-0.5 text-[13px] font-heading font-semibold">
                  <button onClick={() => { setScope('property'); setTarget(''); setWorktype(''); }} className={`px-4 py-1.5 rounded-md ${scope === 'property' ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-600'}`}>Property</button>
                  <button onClick={() => { setScope('community'); setTarget(''); setWorktype(''); }} className={`px-4 py-1.5 rounded-md ${scope === 'community' ? 'bg-white text-purple-700 shadow-sm' : 'text-gray-600'}`}>Community</button>
                </div>
              </div>

              <div className="field">
                <label className={lbl}>Work type</label>
                <select value={worktype} onChange={(e) => setWorktype(e.target.value)} className={ctl}>
                  <option value="">Select a work type…</option>
                  {worktypeOptions.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
                </select>
              </div>

              <div className="field">
                <label className={lbl}>{scope === 'property' ? 'Property address' : 'Community name'}</label>
                <select value={target} onChange={(e) => setTarget(e.target.value)} className={ctl}>
                  <option value="">{scope === 'property' ? 'Select a property…' : 'Select a community…'}</option>
                  {scope === 'property'
                    ? SAMPLE_PROPERTIES.map((p) => <option key={p.id} value={p.id}>{p.address} — {p.locality}</option>)
                    : SAMPLE_COMMUNITIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="field">
                  <label className={lbl}>Due date</label>
                  <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={ctl} />
                </div>
                <div className="field">
                  <label className={lbl}>Vendor assignment</label>
                  <select value={vendor} onChange={(e) => setVendor(e.target.value)} className={ctl}>
                    <option value="">Select a vendor…</option>
                    {SAMPLE_VENDORS.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </div>
              </div>
            </section>

            <button type="button" disabled={!ready} onClick={() => setCreated(true)}
              className={`w-full rounded-2xl py-3.5 font-heading font-bold text-sm ${ready ? 'bg-brand text-white' : 'bg-gray-200 text-gray-400'}`}>
              Create Service{targetLabel ? ` — ${targetLabel}` : ''}
            </button>
            {!ready && <div className="text-center text-xs text-gray-400 -mt-2">Fill in every field to create the service.</div>}
          </div>
        )}
      </main>
    </div>
  );
}
