import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { GetServerSideProps } from 'next';
import type { NextApiRequest } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isInternalEmail } from '@/lib/userAccess';
import { ListPicker } from '@/components/ListPicker';
import { PriceField } from '@/components/PriceField';
import { WORKTYPES, descriptionFor, subtypesFor, defaultRateFor } from '@/lib/services/worktypes';
import { sanitizeNum, clientFrom } from '@/lib/services/pricing';
import { SAMPLE_PROPERTIES, SAMPLE_COMMUNITIES, SAMPLE_VENDORS } from '@/lib/services/sampleData';

const DEFAULT_MARKUP = '20';

// Internal users (@resihome / @resicap / …) only; also flag+admin gated.
export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getSessionFromRequest(ctx.req as unknown as NextApiRequest).catch(() => null);
  const ok = await servicesEnabled(session?.email).catch(() => false);
  if (!ok || !isInternalEmail(session?.email)) return { redirect: { destination: '/services', permanent: false } };
  return { props: {} };
};

export default function NewService() {
  const [worktype, setWorktype] = useState('');
  const [subtype, setSubtype] = useState('');
  const [description, setDescription] = useState('');
  const [vendorCost, setVendorCost] = useState('');
  const [markupPct, setMarkupPct] = useState(DEFAULT_MARKUP);
  const [clientCost, setClientCost] = useState('');
  const [scope, setScope] = useState<'property' | 'community'>('property');
  const [target, setTarget] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [vendor, setVendor] = useState('');
  const [created, setCreated] = useState(false);

  // Prefill the editable description + pricing defaults from the worktype+subtype
  // whenever either changes (mirrors Section 1 of the Rules Engine).
  useEffect(() => {
    if (!worktype) { setDescription(''); setVendorCost(''); setMarkupPct(DEFAULT_MARKUP); setClientCost(''); return; }
    setDescription(descriptionFor(worktype, subtype));
    const rate = defaultRateFor(worktype, subtype);
    const vc = rate != null ? String(rate) : '';
    setVendorCost(vc); setMarkupPct(DEFAULT_MARKUP); setClientCost(clientFrom(vc, DEFAULT_MARKUP));
  }, [worktype, subtype]);

  // Cross-computed pricing: editing vendor cost or markup recomputes client cost;
  // editing client cost back-solves the markup (so all three stay editable & consistent).
  const onVendorCost = (v: string) => { const vc = sanitizeNum(v); setVendorCost(vc); setClientCost(clientFrom(vc, markupPct)); };
  const onMarkup = (v: string) => { const mk = sanitizeNum(v); setMarkupPct(mk); setClientCost(clientFrom(vendorCost, mk)); };
  const onClientCost = (v: string) => {
    const cc = sanitizeNum(v); setClientCost(cc);
    const vc = parseFloat(vendorCost || '0');
    if (vc > 0) setMarkupPct((((parseFloat(cc || '0') / vc) - 1) * 100).toFixed(2));
  };

  const worktypeOptions = useMemo(() => WORKTYPES.filter((w) => w.scopes.includes(scope)).map((w) => ({ value: w.id, label: w.label })), [scope]);
  const subtypeOptions = useMemo(() => subtypesFor(worktype).map((s) => ({ value: s.id, label: s.label })), [worktype]);
  const targetOptions = useMemo(() => scope === 'property'
    ? SAMPLE_PROPERTIES.map((p) => ({ value: p.id, label: p.address, sublabel: p.locality }))
    : SAMPLE_COMMUNITIES.map((c) => ({ value: c.name, label: c.name, sublabel: c.locality })), [scope]);
  const vendorOptions = SAMPLE_VENDORS.map((v) => ({ value: v, label: v }));

  const lbl = 'block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1.5';
  const trig = 'w-full flex items-center justify-between gap-2 text-sm border border-gray-300 rounded-lg px-3 py-2.5 bg-white text-ink';
  const ready = !!worktype && !!subtype && !!target && !!dueDate && !!vendor;
  const targetLabel = scope === 'property' ? (SAMPLE_PROPERTIES.find((p) => p.id === target)?.address || '') : target;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Header — matches the app's pink header (logo + title). */}
      <header className="bg-brand text-white sticky top-0 z-20" style={{ paddingTop: 'min(env(safe-area-inset-top), 0.5rem)' }}>
        <div className="max-w-2xl mx-auto px-4 pt-2 pb-2.5 flex items-center gap-3">
          <Link href="/services" className="inline-flex items-center text-white/90 hover:text-white shrink-0" aria-label="Back to Services">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
          </Link>
          <img src="/app-icon.svg" alt="ResiWalk" className="h-9 w-9 object-cover shrink-0" />
          <h1 className="font-heading font-extrabold text-lg tracking-tight">New Service</h1>
          <span className="text-[9px] font-bold uppercase tracking-wider bg-white/20 px-1.5 py-0.5 rounded">Sample</span>
        </div>
      </header>

      <main className="max-w-2xl mx-auto w-full px-4 py-4 flex-1">
        {created ? (
          <div className="bg-white border border-emerald-300 rounded-2xl p-6 text-center">
            <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-700 grid place-items-center text-2xl mx-auto mb-3">✓</div>
            <div className="font-heading font-extrabold text-lg text-ink">Service created</div>
            <p className="text-sm text-gray-500 mt-1">Assigned to <b>{vendor}</b>, due {dueDate}{clientCost ? <>, client cost <b>${clientCost}</b></> : null}. (Preview — nothing saved.)</p>
            <div className="flex gap-2 justify-center mt-4">
              <button onClick={() => { setCreated(false); setWorktype(''); setSubtype(''); setTarget(''); setDueDate(''); setVendor(''); }} className="border border-gray-300 bg-white rounded-xl px-4 py-2 font-heading font-bold text-sm">Create another</button>
              <Link href="/services" className="bg-brand text-white rounded-xl px-5 py-2 font-heading font-bold text-sm">Back to Services</Link>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <section className="bg-white border border-gray-200 rounded-2xl p-4 space-y-4">
              {/* 1 — Work type + subtype */}
              <div>
                <label className={lbl}>Work type</label>
                <ListPicker value={worktype} options={worktypeOptions} onChange={(v) => { setWorktype(v); setSubtype(subtypesFor(v)[0]?.id || ''); }} ariaLabel="Select a work type" placeholder="Select a work type…" className={trig} />
              </div>
              <div>
                <label className={lbl}>Subtype</label>
                <ListPicker value={subtype} options={subtypeOptions} onChange={setSubtype} ariaLabel="Select a subtype" placeholder="Select a subtype…" className={trig} />
              </div>

              {/* Description — pre-filled from the work type + subtype default; editable (blank until a work type is chosen). */}
              <div>
                <label className={lbl}>Service Description</label>
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
                  className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2.5 bg-white text-ink focus:outline-none focus:border-brand" />
              </div>

              {/* Cost Detail — matches the Rules Engine section. */}
              <div className="border-t border-gray-100 pt-4">
                <label className={lbl}>Cost Detail</label>
                <div className="flex flex-nowrap items-end justify-center gap-4 sm:justify-start">
                  <PriceField label="Vendor Cost" adorn="$" minDecimals={2} colClass="shrink-0 w-24" value={vendorCost} onChange={onVendorCost} />
                  <PriceField label="Markup %" adorn="%" side="right" minDecimals={1} colClass="shrink-0 w-24" value={markupPct} onChange={onMarkup} />
                  <PriceField label="Client Cost" adorn="$" highlight minDecimals={2} colClass="shrink-0 w-24" value={clientCost} onChange={onClientCost} />
                </div>
              </div>

              {/* 2 — Coverage type */}
              <div>
                <label className={lbl}>Coverage type</label>
                <div className="inline-flex rounded-lg border border-gray-300 bg-gray-100 p-0.5 text-[13px] font-heading font-semibold">
                  <button onClick={() => { setScope('property'); setTarget(''); }} className={`px-4 py-1.5 rounded-md ${scope === 'property' ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-600'}`}>Property</button>
                  <button onClick={() => { setScope('community'); setTarget(''); }} className={`px-4 py-1.5 rounded-md ${scope === 'community' ? 'bg-white text-purple-700 shadow-sm' : 'text-gray-600'}`}>Community</button>
                </div>
              </div>

              {/* 3 — Property address / Community (subdivision + city, ST ZIP) */}
              <div>
                <label className={lbl}>{scope === 'property' ? 'Property address' : 'Community'}</label>
                <ListPicker value={target} options={targetOptions} onChange={setTarget}
                  ariaLabel={scope === 'property' ? 'Select a property' : 'Select a community'}
                  placeholder={scope === 'property' ? 'Select a property…' : 'Select a community…'} className={trig} />
              </div>

              {/* 4 — Due date + Vendor */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={lbl}>Due date</label>
                  <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2.5 bg-white text-ink focus:outline-none focus:border-brand" />
                </div>
                <div>
                  <label className={lbl}>Vendor assignment</label>
                  <ListPicker value={vendor} options={vendorOptions} onChange={setVendor} ariaLabel="Select a vendor" placeholder="Select a vendor…" className={trig} />
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
