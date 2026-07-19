import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import type { GetServerSideProps } from 'next';
import type { NextApiRequest } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { resolveServiceViewerAsync, servicesViewerAllowed } from '@/lib/services/scopeServer';
import { isInternalEmail } from '@/lib/userAccess';
import { worktypeLabel, subtypeLabel, defaultRateFor, type Worktype } from '@/lib/services/worktypes';
import { grassTierAmount, DEFAULT_GRASS_TIERS } from '@/lib/services/grassPricing';
import { DEFAULT_SERVICE_FORMS, formKey, type ServiceQuestion } from '@/lib/services/serviceForms';
import { SERVICE_STATUS_STYLE, serviceStatusText, easternTodayISO, type ServiceStatus, type ServiceRecord } from '@/lib/services/model';
import { serviceVisibleTo } from '@/lib/services/scope';
import { fetchServiceWorkOrder, fetchPropertyLockInfo, readServiceForms } from '@/lib/hubspot';
import { isViewingAsVendor, setViewAsVendor } from '@/lib/services/viewAs';
import type { AuditEvent } from '@/lib/auditLog';
import { CameraCapture } from '@/components/CameraCapture';
import { PhotoThumb } from '@/components/PhotoThumb';
import { PhotoLightbox } from '@/components/PhotoLightbox';
import { UnlockButton, lockRingFromProperty, type LockRing } from '@/components/UnlockButton';
import { FitText } from '@/components/FitText';
import ServicePager from '@/components/ServicePager';
import { AiSparkle } from '@/components/AiSparkle';
import { AutoGrowTextarea } from '@/components/AutoGrowTextarea';
import { DatePicker } from '@/components/DatePicker';
import { capturePhotoOrQueue, submitServiceOrQueue, initServiceSync, hasPendingSubmit, onServiceSync, toDurableRef, rehydrateRef } from '@/lib/services/offlineServices';

interface ServiceView {
  id: string; live: boolean;
  worktype: Worktype; subtype: string; scope: 'property' | 'community';
  address: string; locality: string; vendor: string | null; dueDate: string;
  petStations: boolean; status: string; propertyRecordId: string; isBidItem: boolean;
  estimatedAt: string;
  vendorCost: number | null; markupPct: number | null; clientCost: number | null;
  vendorCostAdjustment: number | null; adjustmentReason: string;
  grassTiers: { standard: number; overgrown: number; heavy: number };
  description: string;
  aiVerdict: string; aiNotes: string;
  reviewDecision: string; reviewNotes: string; reviewedBy: string;
  answers: Record<string, any>;
  before: string[]; after: string[]; petBefore: string[]; petAfter: string[];
  // Community grass-cut billing split: a master carries a covered-property snapshot
  // + per-property rate; a child points back to its master via masterServiceId.
  isMaster: boolean; coveredCount: number | null; perRate: number | null;
  forBilling: string; masterServiceId: string; splitAt: string;
}

const EDITABLE = new Set(['', 'estimated', 'assigned']);
// Standardized to mirror the inspection template: a section header is a black
// bold title on a light-PINK (brand-tinted) band across the top of its white card,
// matching the Scope Rate Card + Q&A inspection section headers; question labels
// within a section are black bold (photo group labels stay grey-uppercase).
const SECTION_HEAD = '-mx-4 -mt-4 mb-4 px-4 py-2.5 bg-brand/5 border-b border-brand/20 rounded-t-2xl font-heading font-bold text-lg text-ink';
const Q_LABEL = 'block text-sm font-heading font-bold text-ink mb-1.5';
const splitUrls = (v: any): string[] => String(v || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
const num = (v: any): number | null => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const normDate = (v: any): string => {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (/^\d{10,}$/.test(s)) return new Date(Number(s)).toISOString().slice(0, 10);
  return s.slice(0, 10);
};
// Display a YYYY-MM-DD date as M-D-YY (e.g. 2026-07-13 → 7-13-26).
const fmtMDY = (iso: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${Number(m[2])}-${Number(m[3])}-${m[1].slice(2)}` : iso;
};

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getSessionFromRequest(ctx.req as unknown as NextApiRequest).catch(() => null);
  const ok = await servicesViewerAllowed(session?.vendor ? session?.email : (session?.realEmail || session?.email)).catch(() => false);
  if (!ok) return { redirect: { destination: '/', permanent: false } };
  // "View as Vendor" (cookie) forces the external vendor experience app-wide, so
  // internal previewers see exactly what a vendor sees on the record too.
  // A real vendor login OR an internal "View as Vendor" preview both count as
  // the vendor experience — a vendor is NEVER internal (no settings gear, no
  // client pricing), even on an internal-domain email.
  const asVendor = isViewingAsVendor(ctx.req) || !!session?.vendor;
  const isInternal = isInternalEmail(session?.email) && !asVendor;
  const id = String(ctx.params?.id || '');

  let svc: ServiceView | null = null;
  let svcVendorEmail: string | null = null;  // for the vendor-ownership guard below
  if (/^\d+$/.test(id)) {
    const rec = await fetchServiceWorkOrder(id).catch(() => null);
    if (rec) {
      const p = rec.props;
      svcVendorEmail = String(p.vendor_email || '').trim() || null;
      svc = {
        id: rec.id, live: true,
        worktype: (p.worktype || 'landscaping') as Worktype, subtype: p.subtype || '',
        scope: p.scope === 'community' ? 'community' : 'property',
        address: p.address_snapshot || p.service_name || '(Service)', locality: p.locality_snapshot || '',
        vendor: p.vendor_name || null, dueDate: normDate(p.due_date),
        petStations: p.pet_stations === 'true', status: p.status || 'assigned',
        propertyRecordId: p.property_id_ref || '', isBidItem: p.is_bid_item === 'true',
        estimatedAt: normDate(p.hs_createdate),
        description: p.service_description || '',
        vendorCost: num(p.vendor_cost), markupPct: num(p.markup_pct), clientCost: num(p.client_cost),
        vendorCostAdjustment: num(p.vendor_cost_adjustment), adjustmentReason: p.vendor_cost_adjustment_reason || '',
        grassTiers: {
          standard: num(p.grass_rate_standard) ?? DEFAULT_GRASS_TIERS.standard,
          overgrown: num(p.grass_rate_overgrown) ?? DEFAULT_GRASS_TIERS.overgrown,
          heavy: num(p.grass_rate_heavy) ?? DEFAULT_GRASS_TIERS.heavy,
        },
        aiVerdict: p.ai_verdict || '', aiNotes: p.ai_notes || '',
        reviewDecision: p.review_decision || '', reviewNotes: p.review_notes || '', reviewedBy: p.reviewed_by || '',
        answers: (() => { try { return JSON.parse(p.answers_json || '{}'); } catch { return {}; } })(),
        before: splitUrls(p.before_photo_urls), after: splitUrls(p.after_photo_urls),
        petBefore: splitUrls(p.pet_before_photo_urls), petAfter: splitUrls(p.pet_after_photo_urls),
        isMaster: p.scope === 'community' && p.worktype === 'landscaping' && p.subtype === 'cut' && !String(p.master_service_id || '').trim() && !!String(p.covered_property_ids || '').trim(),
        coveredCount: num(p.covered_property_count), perRate: num(p.per_property_rate),
        forBilling: p.for_billing || '', masterServiceId: String(p.master_service_id || '').trim(), splitAt: normDate(p.split_at),
      };
    }
  }
  // A non-numeric (or unknown) id has no real Service Work Order → back to the list.
  if (!svc) return { redirect: { destination: '/services', permanent: false } };
  // Vendor-ownership guard: a vendor (real login OR "View as Vendor" preview) may
  // only open a service assigned to them — a direct URL to someone else's service
  // bounces back to the list. Internal admins (canSeeAll) are unrestricted.
  const viewer = await resolveServiceViewerAsync(session, ctx.req);
  if (!viewer.canSeeAll && !serviceVisibleTo({ vendor: svc.vendor, vendorEmail: svcVendorEmail } as ServiceRecord, viewer)) {
    return { redirect: { destination: '/services', permanent: false } };
  }
  const savedForms = await readServiceForms().catch(() => null);
  const formSet: Record<string, any[]> = { ...DEFAULT_SERVICE_FORMS, ...(savedForms || {}) };
  const form = (formSet[formKey(svc.worktype, svc.subtype)] || [])
    .filter((q: any) => q.enabled)
    // Community grass cuts are a per-contract visit, not a per-home cut — the
    // "Grass Height at Arrival" tier doesn't apply, so drop it for community scope.
    .filter((q: any) => !(svc.scope === 'community' && isGrassHeightQuestion(q)));

  // For property-scope live services, pull the property brief (bed/bath/sqft/
  // region) for the header's second line, and — for CLEANING at a non-"Tenant
  // Leased" (vacant) home — the Rently unlock button + online/offline ring.
  let unlock: { propertyId: string; address: string; ring: LockRing } | null = null;
  let propMeta: { bedrooms: number | null; bathrooms: number | null; sqft: number | null; region: string } | null = null;
  if (svc.live && svc.scope === 'property' && svc.propertyRecordId) {
    const info = await fetchPropertyLockInfo(svc.propertyRecordId).catch(() => null);
    if (info) {
      propMeta = { bedrooms: info.bedrooms, bathrooms: info.bathrooms, sqft: info.squareFootage, region: info.region };
      if (svc.worktype === 'cleaning' && info.status && info.status !== 'Tenant Leased') {
        unlock = { propertyId: svc.propertyRecordId, address: svc.address, ring: lockRingFromProperty(info.deviceType, info.hubStatus, info.lockStatus) };
      }
    }
  }
  return { props: { svc, form, isInternal, unlock, propMeta, asVendor, isVendor: !!session?.vendor } };
};

const money = (n: number | null | undefined) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ── Camera-backed photo group (recycles the 1099 in-camera + gallery experience) ──
function CameraPhotos({ label, required, urls, onChange, address, propertyRecordId, upload }: {
  label: string; required?: boolean; urls: string[]; onChange: (next: string[]) => void; address: string; propertyRecordId: string;
  upload: (file: File) => Promise<string>;
}) {
  const [open, setOpen] = useState(false);
  // The add-photo tile signals state: PINK while the required first photo is still
  // missing, then YELLOW once at least one is added (further photos are optional).
  // Optional groups (no `required`) are yellow from the start.
  const needsFirst = !!required && urls.length === 0;
  const addTileCls = needsFirst
    ? 'border-brand text-brand hover:bg-brand/5'
    : 'border-amber-400 text-amber-500 hover:bg-amber-50';
  return (
    <div>
      <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1.5">{label}{required && <span className="text-brand"> *</span>}</div>
      <div className="flex flex-wrap gap-2">
        {urls.map((u, i) => (
          <div key={`${u}-${i}`} className="relative w-20 h-20 rounded-lg overflow-hidden border border-gray-300 bg-gray-100">
            <PhotoThumb url={u} alt={`${label} ${i + 1}`} className="w-full h-full object-cover" />
            {u.startsWith('blob:') && <span className="absolute bottom-0.5 left-0.5 text-[9px] font-bold text-white bg-black/55 rounded px-1">syncing</span>}
            <button type="button" onClick={() => onChange(urls.filter((_, j) => j !== i))}
              className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-black/60 text-white text-xs leading-none grid place-items-center" aria-label="Remove photo">×</button>
          </div>
        ))}
        <button type="button" onClick={() => setOpen(true)} aria-label={`Add ${label}${needsFirst ? ' (required)' : ' (optional)'}`}
          className={`w-20 h-20 rounded-lg border-2 border-dashed flex items-center justify-center text-2xl transition-colors ${addTileCls}`}>+</button>
      </div>
      <CameraCapture isOpen={open} onClose={() => setOpen(false)} uploadPhoto={upload}
        addressSnapshot={address} propertyRecordId={propertyRecordId || undefined}
        onComplete={(newUrls) => { setOpen(false); const add = newUrls.filter((u) => u && !urls.includes(u)); if (add.length) onChange([...urls, ...add]); }} />
    </div>
  );
}

// Format an ISO date (YYYY-MM-DD) as M-D-YY (e.g. 2026-07-12 → 7-12-26); any
// non-date string passes through unchanged. Used for date answer values.
function mdyIfDate(v: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec((v || '').trim());
  return m ? `${Number(m[2])}-${Number(m[3])}-${m[1].slice(2)}` : v;
}

function PhotoGrid({ label, urls, onOpen }: { label: string; urls: string[]; onOpen: (index: number) => void }) {
  if (!urls.length) return null;
  return (
    <div>
      <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1.5">{label}</div>
      <div className="flex flex-wrap gap-2">
        {urls.map((u, i) => (
          <button key={`${u}-${i}`} type="button" onClick={() => onOpen(i)}
            className="w-20 h-20 rounded-lg overflow-hidden border border-gray-300 bg-gray-100 cursor-zoom-in">
            <PhotoThumb url={u} alt={`${label} ${i + 1}`} className="w-full h-full object-cover" />
          </button>
        ))}
      </div>
    </div>
  );
}

// Render the AI review notes cleanly: a lead paragraph, a subtle "Issues"
// subheading, then the concerns as a spaced bullet list (small gap between each
// so it's easy to scan) — instead of one dense run-on block.
function AiNotes({ text }: { text: string }) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const out: React.ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (!bullets.length) return;
    const items = bullets;
    out.push(
      <ul key={`u${out.length}`} className="space-y-1.5">
        {items.map((b, i) => (
          <li key={i} className="flex gap-2 text-[13px] text-gray-600 leading-snug"><span className="text-brand shrink-0">•</span><span>{b}</span></li>
        ))}
      </ul>,
    );
    bullets = [];
  };
  for (const line of lines) {
    if (/^[•\-*]\s*/.test(line)) { bullets.push(line.replace(/^[•\-*]\s*/, '')); continue; }
    flush();
    if (/:$/.test(line) && line.length < 40) out.push(<div key={`h${out.length}`} className="text-[12px] font-bold uppercase tracking-wide text-gray-400 pt-1">{line.replace(/:$/, '')}</div>);
    else out.push(<p key={`p${out.length}`} className="text-[13px] text-gray-600 leading-relaxed">{line}</p>);
  }
  flush();
  return <div className="space-y-2">{out}</div>;
}

// Shared collapse/expand-all signal: every CollapsibleSection under the provider
// syncs its open state to the signal whenever the token bumps (initial render's
// token 0 is a no-op, so each section's defaultOpen is still respected). Lets the
// record view toggle all sections at once, like the inspection template.
const SectionCollapseCtx = createContext<{ open: boolean; token: number } | null>(null);

// A white card whose grey header band toggles the body open/closed — mirrors the
// collapsible sections in the inspection template.
function CollapsibleSection({ title, subtitle, right, defaultOpen = true, bodyClass = 'space-y-4', children }: {
  title: React.ReactNode; subtitle?: string; right?: React.ReactNode; defaultOpen?: boolean; bodyClass?: string; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const signal = useContext(SectionCollapseCtx);
  const lastToken = useRef(0);
  useEffect(() => {
    if (signal && signal.token !== lastToken.current) {
      lastToken.current = signal.token;
      setOpen(signal.open);
    }
  }, [signal]);
  return (
    <section className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 px-4 py-2.5 bg-brand/5 border-b border-brand/20 text-left">
        <div className="min-w-0">
          <div className="font-heading font-bold text-lg text-ink">{title}</div>
          {subtitle && <p className="text-[12px] font-normal text-gray-500 mt-0.5">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {right}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={`text-gray-400 transition-transform ${open ? '' : '-rotate-90'}`}><polyline points="6 9 12 15 18 9" /></svg>
        </div>
      </button>
      {open && <div className={`p-4 ${bodyClass}`}>{children}</div>}
    </section>
  );
}

// ── Community grass-cut MASTER: covered-property list ──
// The crew/vendor sees the street-address list of every home this one visit
// bills for (read-only). An internal reviewer, before the master splits, can
// add ANY community property or drop covered ones — the price recomputes down
// (count × per-property rate). Photos stay on the master; children reference it.
interface CoveredProp { id: string; address: string; locality: string; rrqc: boolean; status: string }
// Sort by leading house number (smallest → largest), then street text — so the
// list reads like a route, not an ASCII sort ("2" before "10").
const houseNum = (a: string): number => { const m = /^\s*(\d+)/.exec(a || ''); return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER; };
const byAddr = (x: CoveredProp, y: CoveredProp): number => (houseNum(x.address) - houseNum(y.address)) || x.address.localeCompare(y.address);
function MasterCoverage({ svc, isInternal }: { svc: ServiceView; isInternal: boolean }) {
  const router = useRouter();
  const split = svc.forBilling === 'false' || !!svc.splitAt;
  const canEdit = isInternal && svc.live && !split && ['assigned', 'submitted', 'review'].includes(svc.status);
  const [covered, setCovered] = useState<CoveredProp[]>([]);
  const [available, setAvailable] = useState<CoveredProp[]>([]);
  const [loading, setLoading] = useState(svc.live);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState('');
  const perRate = svc.perRate ?? 0;

  useEffect(() => {
    if (!svc.live) { setLoading(false); return; }
    let alive = true;
    setLoading(true);
    fetch(`/api/services/${encodeURIComponent(svc.id)}/covered`)
      .then((r) => r.json())
      .then((d) => { if (!alive) return; if (d.error) { setErr(d.error); return; } setCovered([...(d.covered || [])].sort(byAddr)); setAvailable([...(d.available || [])].sort(byAddr)); })
      .catch(() => { if (alive) setErr('Could not load covered properties.'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [svc.id, svc.live]);

  const drop = (id: string) => {
    if (covered.length <= 1) return;   // at least one must remain
    const p = covered.find((x) => x.id === id); if (!p) return;
    setCovered((c) => c.filter((x) => x.id !== id));
    setAvailable((a) => [p, ...a].sort(byAddr));
    setDirty(true);
  };
  const add = (id: string) => {
    const p = available.find((x) => x.id === id); if (!p) return;
    setAvailable((a) => a.filter((x) => x.id !== id));
    setCovered((c) => [...c, p].sort(byAddr));
    setDirty(true);
  };
  const save = async () => {
    setSaving(true); setErr('');
    try {
      const r = await fetch(`/api/services/${encodeURIComponent(svc.id)}/covered`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyIds: covered.map((c) => c.id) }),
      });
      const d = await r.json();
      if (!r.ok) { setErr(d.error || 'Save failed.'); return; }
      setDirty(false);
      router.replace(router.asPath).catch(() => {});   // reflect the new count + pricing (ignore same-URL invariant)
    } catch { setErr('Save failed.'); }
    finally { setSaving(false); }
  };

  const count = svc.live ? covered.length : (svc.coveredCount ?? 0);
  const liveTotal = Math.round(count * perRate * 100) / 100;
  const filtered = available.filter((a) => !q.trim() || `${a.address} ${a.locality}`.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <CollapsibleSection
      title="Covered Homes"
      defaultOpen={false}
      subtitle={split ? 'Split into per-property billing lines — final.' : `One visit, billed as ${count} individual cut${count === 1 ? '' : 's'}.`}
      right={<span className="text-[12px] font-heading font-bold text-brand tabular-nums">{count} home{count === 1 ? '' : 's'}</span>}
    >
      {loading ? (
        <div className="text-[13px] text-gray-400">Loading covered homes…</div>
      ) : (
        <>
          {isInternal && (
            <div className="flex items-center justify-between text-[12px] text-gray-500 -mt-1 mb-1">
              <span>Per-property rate <span className="font-semibold text-ink tabular-nums">{money(perRate)}</span></span>
              <span>Master total <span className="font-semibold text-ink tabular-nums">{money(svc.live ? liveTotal : (svc.vendorCost ?? liveTotal))}</span></span>
            </div>
          )}
          <ul className="divide-y divide-gray-100 border border-gray-100 rounded-xl overflow-hidden">
            {(svc.live ? covered : []).map((c) => (
              <li key={c.id} className="flex items-center gap-2 px-3 py-2 text-[13px]">
                <span className="flex-1 min-w-0">
                  <span className="text-ink truncate">{c.address}</span>
                  {c.locality && <span className="block text-[11px] text-gray-400 truncate">{c.locality}</span>}
                </span>
                {!c.rrqc && <span className="text-[10px] font-bold uppercase tracking-wide text-amber-600 shrink-0" title="No RRQC pass date">added</span>}
                {canEdit && (
                  <button type="button" onClick={() => drop(c.id)} disabled={covered.length <= 1}
                    aria-label={`Drop ${c.address}`} className="text-gray-400 hover:text-red-500 disabled:opacity-30 text-[16px] leading-none px-1 shrink-0">×</button>
                )}
              </li>
            ))}
            {svc.live && covered.length === 0 && <li className="px-3 py-2 text-[13px] text-gray-400">No covered homes.</li>}
            {!svc.live && <li className="px-3 py-2 text-[13px] text-gray-400">{count} home{count === 1 ? '' : 's'} (sample record).</li>}
          </ul>

          {canEdit && (
            <div className="mt-3">
              {!adding ? (
                <button type="button" onClick={() => setAdding(true)}
                  className="text-[12px] font-semibold text-brand border border-brand/40 rounded-lg px-2.5 py-1 bg-white hover:bg-brand/5">+ Add property</button>
              ) : (
                <div className="border border-gray-200 rounded-xl overflow-hidden">
                  <div className="p-2 border-b border-gray-100 flex items-center gap-2">
                    <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search community properties…"
                      className="flex-1 text-[13px] px-2.5 py-1.5 border border-gray-300 rounded-lg text-ink focus:outline-none focus:border-brand" />
                    <button type="button" onClick={() => { setAdding(false); setQ(''); }} className="text-[12px] font-semibold text-gray-500 px-1">Done</button>
                  </div>
                  <div className="max-h-52 overflow-y-auto py-1">
                    {filtered.map((a) => (
                      <button key={a.id} type="button" onClick={() => add(a.id)} className="w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-gray-50 text-left">
                        <span className="text-brand font-bold shrink-0">+</span>
                        <span className="flex-1 min-w-0"><span className="text-ink truncate">{a.address}</span>{a.locality && <span className="block text-[11px] text-gray-400 truncate">{a.locality}</span>}</span>
                        {!a.rrqc && <span className="text-[10px] font-bold uppercase tracking-wide text-amber-600 shrink-0" title="No RRQC pass date">no rrqc</span>}
                      </button>
                    ))}
                    {filtered.length === 0 && <div className="px-3 py-4 text-center text-[12px] text-gray-400">No other community properties.</div>}
                  </div>
                </div>
              )}
              {dirty && (
                <div className="mt-3 flex items-center gap-3">
                  <button type="button" onClick={save} disabled={saving}
                    className="text-[13px] font-heading font-bold text-white bg-brand rounded-lg px-4 py-1.5 disabled:opacity-50">{saving ? 'Saving…' : `Save — ${count} home${count === 1 ? '' : 's'} · ${money(liveTotal)}`}</button>
                  <span className="text-[12px] text-gray-400">Unsaved changes</span>
                </div>
              )}
            </div>
          )}
          {err && <p className="text-[12px] text-red-600 mt-2">{err}</p>}
        </>
      )}
    </CollapsibleSection>
  );
}

interface DecisionPayload { decision: 'approve' | 'modify' | 'reject'; vendorCost: number; markupPct: number; dueDays: number; notes: string; reissue: boolean; reissueDays: number; reissueNote: string; }

// Shared reviewer decision panel — used for BOTH the completion review (kind
// 'review' → Completed) and the estimated bid review (kind 'bid' → Assigned, with
// a days-until-due). Three options in one row (Approve / Modify / Reject) with
// short one-line hints; Modify shows a borderless mini-table of New / Original /
// Difference across Vendor · Markup · Client. All decisions require a note.
function DecisionPanel({ kind, orig, busy, error, onSubmit, allowReissue = false }: {
  kind: 'review' | 'bid';
  orig: { vendor: number; markup: number; client: number };
  busy: boolean; error: string;
  onSubmit: (p: DecisionPayload) => void;
  allowReissue?: boolean;   // Re-Issue only offered when the service wasn't completed
}) {
  const [decision, setDecision] = useState<'' | 'approve' | 'modify' | 'reject'>('');
  const [vc, setVc] = useState(orig.vendor ? orig.vendor.toFixed(2) : '0.00');
  const [mk, setMk] = useState(String(orig.markup || 0));
  const [days, setDays] = useState('5');
  const [notes, setNotes] = useState('');
  // Re-Issue (review only): spin up a fresh service with the same requirements,
  // property/community, and vendor — due in N days — with an optional note for
  // the vendor. The original still closes out per the decision above.
  const [reissue, setReissue] = useState(false);
  const [reissueDays, setReissueDays] = useState('5');
  const [reissueNote, setReissueNote] = useState('');
  const [open, setOpen] = useState(true);   // the panel is collapsible
  const money = (n: number) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmt2 = (v: string) => { const n = Number(v); return v.trim() !== '' && Number.isFinite(n) ? n.toFixed(2) : v; };
  const inputCls = 'w-full text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:border-brand';

  const needsDays = kind === 'bid' && (decision === 'approve' || decision === 'modify');
  const newVendor = decision === 'modify' ? Number(vc || '0') : orig.vendor;
  const newMarkup = decision === 'modify' ? Number(mk || '0') : orig.markup;
  const newClient = (kind === 'review' && decision === 'reject') ? 0 : Math.round(newVendor * (1 + newMarkup / 100) * 100) / 100;
  const target = kind === 'bid' ? 'Assigned' : 'Completed';
  const hints = kind === 'bid'
    ? { approve: 'Assign as-is', modify: 'Edit pricing', reject: 'Cancel bid' }
    : { approve: 'Complete as-is', modify: 'Edit pricing', reject: 'Deny — $0' };
  const reissueOk = !reissue || Number(reissueDays) > 0;
  const canSubmit = !!decision && !!notes.trim() && (!needsDays || Number(days) > 0) && reissueOk && !busy;

  const diffCls = (d: number) => d > 0 ? 'text-emerald-600' : d < 0 ? 'text-red-600' : 'text-gray-400';
  const signMoney = (d: number) => `${d > 0 ? '+' : d < 0 ? '−' : ''}$${Math.abs(d).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const signPct = (d: number) => d === 0 ? '0%' : `${d > 0 ? '+' : '−'}${Math.abs(d)}%`;

  const options = [
    ['approve', 'Approve', hints.approve, 'emerald'],
    ['modify', 'Modify', hints.modify, 'amber'],
    ['reject', 'Reject', hints.reject, 'red'],
  ] as const;
  const submitLabel = (decision === 'reject' ? (kind === 'bid' ? 'Reject → Canceled' : 'Reject → Completed')
    : decision === 'modify' ? `Save Changes → ${target}`
    : decision === 'approve' ? `Approve → ${target}`
    : 'Choose a decision above') + (decision && kind === 'review' && reissue ? ' · Re-Issue' : '');

  const cell = 'text-[12px] tabular-nums';
  return (
    <section className="bg-white border-2 border-brand/30 rounded-2xl p-4 space-y-3">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className={`${SECTION_HEAD} ${open ? '' : '!mb-0'} w-[calc(100%+2rem)] flex items-center justify-between gap-2 text-left`}>
        <span>Decision</span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {open && (<>
      <div className="grid grid-cols-3 gap-2">
        {options.map(([val, label, hint, tone]) => {
          const on = decision === val;
          const onCls = tone === 'red' ? 'bg-red-600 text-white border-red-600' : tone === 'amber' ? 'bg-amber-500 text-white border-amber-500' : 'bg-emerald-600 text-white border-emerald-600';
          return (
            <button key={val} type="button" onClick={() => setDecision(val)}
              className={`rounded-xl py-2 px-1 border text-center transition ${on ? onCls : 'bg-white text-gray-700 border-gray-300 hover:border-brand/50'}`}>
              <div className="font-heading font-bold text-sm">{label}</div>
              <div className={`text-[10px] leading-tight mt-0.5 ${on ? 'text-white/85' : 'text-gray-400'}`}>{hint}</div>
            </button>
          );
        })}
      </div>

      {/* Modify → borderless mini-table: New (editable) / Original / Difference. */}
      {decision === 'modify' && (
        <div className="border-t border-gray-100 pt-3">
          <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-2">Revised pricing</div>
          <div className="grid grid-cols-[64px_1fr_1fr_1fr] gap-x-2 gap-y-1.5 items-center">
            <div />
            <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 text-center">Vendor</div>
            <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 text-center">Markup</div>
            <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 text-center">Client</div>

            <div className="text-[12px] text-gray-500">New</div>
            <div className="relative"><span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-xs">$</span>
              <input type="number" inputMode="decimal" value={vc} onChange={(e) => setVc(e.target.value)} onBlur={() => setVc(fmt2(vc))}
                className="w-full text-[13px] border border-gray-300 rounded-lg pl-5 pr-1.5 py-1.5 bg-white focus:outline-none focus:border-brand text-center tabular-nums" /></div>
            <div className="relative"><input type="number" inputMode="decimal" value={mk} onChange={(e) => setMk(e.target.value)}
                className="w-full text-[13px] border border-gray-300 rounded-lg pl-2 pr-4 py-1.5 bg-white focus:outline-none focus:border-brand text-center tabular-nums" /><span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 text-xs">%</span></div>
            <div className="text-center text-[13px] font-bold text-ink tabular-nums">{money(newClient)}</div>

            <div className="text-[12px] text-gray-400">Original</div>
            <div className={`${cell} text-gray-400 text-center`}>{money(orig.vendor)}</div>
            <div className={`${cell} text-gray-400 text-center`}>{orig.markup}%</div>
            <div className={`${cell} text-gray-400 text-center`}>{money(orig.client)}</div>

            <div className="text-[12px] text-gray-400">Difference</div>
            <div className={`${cell} text-center ${diffCls(newVendor - orig.vendor)}`}>{signMoney(newVendor - orig.vendor)}</div>
            <div className={`${cell} text-center ${diffCls(newMarkup - orig.markup)}`}>{signPct(newMarkup - orig.markup)}</div>
            <div className={`${cell} text-center ${diffCls(newClient - orig.client)}`}>{signMoney(newClient - orig.client)}</div>
          </div>
        </div>
      )}

      {decision === 'approve' && (
        <div className="border-t border-gray-100 pt-3 text-[13px] text-gray-500">
          Keeps current pricing — Vendor <b className="text-ink tabular-nums">{money(orig.vendor)}</b>{kind === 'bid' ? '' : <> · Client <b className="text-ink tabular-nums">{money(orig.client)}</b></>}.
        </div>
      )}
      {decision === 'reject' && (
        <div className="border-t border-gray-100 pt-3 text-[13px] text-red-700 font-semibold">
          {kind === 'bid' ? 'This bid will be Canceled.' : 'Vendor payout will be set to $0 and the service closed out.'}
        </div>
      )}

      {needsDays && (
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-gray-500">Days to Complete <span className="text-brand">*</span></span>
          <input type="number" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)}
            className="w-16 text-sm border border-gray-300 rounded-lg px-2 py-2 bg-white focus:outline-none focus:border-brand" />
        </div>
      )}

      {/* Re-Issue Service — review only, and only when the service was marked NOT
          completed (a completed service has nothing to redo). The original closes
          out per the decision; a fresh service (same requirements) is created. */}
      {kind === 'review' && allowReissue && (
        <div className="border-t border-gray-100 pt-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13px] font-heading font-semibold text-ink">Re-Issue Service?</span>
            <div className="inline-flex rounded-lg border border-gray-300 bg-gray-100 p-0.5 text-[13px] font-heading font-semibold">
              <button type="button" onClick={() => setReissue(true)} className={`px-4 py-1.5 rounded-md ${reissue ? 'bg-white text-brand shadow-sm' : 'text-gray-600'}`}>Yes</button>
              <button type="button" onClick={() => setReissue(false)} className={`px-4 py-1.5 rounded-md ${!reissue ? 'bg-white text-ink shadow-sm' : 'text-gray-600'}`}>No</button>
            </div>
          </div>
          {reissue ? (
            <div className="mt-3 space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-[13px] text-gray-500">Days to Complete <span className="text-brand">*</span></span>
                <input type="number" inputMode="numeric" value={reissueDays} onChange={(e) => setReissueDays(e.target.value)}
                  className="w-16 text-sm border border-gray-300 rounded-lg px-2 py-2 bg-white focus:outline-none focus:border-brand" />
              </div>
              <div>
                <label className="block text-[12px] font-bold uppercase tracking-wide text-gray-400 mb-1.5">Note for the vendor <span className="text-gray-300 normal-case">(optional)</span></label>
                <AutoGrowTextarea value={reissueNote} onChange={(e) => setReissueNote(e.target.value)} minPx={52} className={inputCls}
                  placeholder="Shown at the top of the new request for the vendor…" />
              </div>
              <p className="text-[12px] text-gray-500">A new service with the original requirements — same property, community, and vendor — will be created, due in {Number(reissueDays) > 0 ? Number(reissueDays) : '…'} day{Number(reissueDays) === 1 ? '' : 's'}.</p>
            </div>
          ) : (
            <p className="mt-2 text-[12px] text-gray-500">The service closes out as-is — no new service is created.</p>
          )}
        </div>
      )}

      {/* Notes — below the options; required for every decision. */}
      <div>
        <label className="block text-[12px] font-bold uppercase tracking-wide text-gray-400 mb-1.5">Decision note <span className="text-brand">*</span></label>
        <AutoGrowTextarea value={notes} onChange={(e) => setNotes(e.target.value)} minPx={64} className={inputCls}
          placeholder="Required — the reason for this decision (visible on the record)…" />
      </div>

      <button type="button" disabled={!canSubmit}
        onClick={() => canSubmit && onSubmit({ decision: decision as DecisionPayload['decision'], vendorCost: Number(vc || '0'), markupPct: Number(mk || '0'), dueDays: Number(days || '0'), notes, reissue: kind === 'review' && allowReissue && reissue, reissueDays: Number(reissueDays || '0'), reissueNote })}
        className={`w-full rounded-xl py-3 font-heading font-bold text-sm ${
          !canSubmit ? 'bg-gray-200 text-gray-400'
            : decision === 'reject' ? 'bg-red-600 text-white' : decision === 'modify' ? 'bg-amber-500 text-white' : 'bg-emerald-600 text-white'}`}>
        {busy ? '…' : submitLabel}
      </button>
      {decision && !notes.trim() && <div className="text-[12px] text-gray-400 text-center -mt-1">A decision note is required to finalize.</div>}
      {needsDays && !(Number(days) > 0) && <div className="text-[12px] text-gray-400 text-center -mt-1">Enter the days to complete.</div>}
      {kind === 'review' && reissue && !reissueOk && <div className="text-[12px] text-gray-400 text-center -mt-1">Enter the days to complete the re-issued service.</div>}
      {error && <div className="text-center text-xs text-red-600">{error}</div>}
      </>)}
    </section>
  );
}

// The Bill Trip Fee question — by stable id, or by label if it was renamed in the
// Form Builder. Matches the submit-side pricing resolver (keep them in lockstep).
const isTripFeeQuestion = (q: ServiceQuestion) => q.id === 'bill_trip_fee' || /trip\s*fee/i.test(q.label);
const isGrassHeightQuestion = (q: ServiceQuestion) => q.id === 'grass_height' || /grass\s*height/i.test(q.label);
// Overgrown / Heavy tiers bill above the base grass-cut rate.
const isHigherGrassTier = (v: unknown) => {
  const h = String(v || '').toLowerCase();
  return h.includes('overgrown') || h.includes('heavy') || h.includes('6-12') || h.includes('6–12') || h.includes('over 12') || h.includes('12"+') || h.includes('12+');
};
// Grass-height tier → hint color (green Standard, yellow Overgrown, red Heavy).
const grassTier = (label: string): 'emerald' | 'amber' | 'rose' => {
  const h = label.toLowerCase();
  if (h.includes('heavy') || h.includes('over 12') || h.includes('12"+') || h.includes('12+')) return 'rose';
  if (h.includes('overgrown') || h.includes('6-12') || h.includes('6–12') || h.includes('6 - 12')) return 'amber';
  return 'emerald';
};
// Split "Standard (<6 in)" → { main: 'Standard', sub: '(<6 in)' } for the 2-line label.
const splitGrassLabel = (label: string): { main: string; sub: string } => {
  const m = label.match(/^(.*?)\s*(\(.*\))\s*$/);
  return m ? { main: m[1].trim(), sub: m[2].trim() } : { main: label, sub: '' };
};
const GRASS_TIER_BORDER: Record<'emerald' | 'amber' | 'rose', string> = {
  emerald: 'bg-white border-emerald-400 text-emerald-700',
  amber: 'bg-white border-amber-400 text-amber-700',
  rose: 'bg-white border-rose-400 text-rose-700',
};
// Selected state keeps the tier's own color — a tinted interior fill + stronger
// border/ring — instead of overriding with the pink brand fill.
const GRASS_TIER_FILL: Record<'emerald' | 'amber' | 'rose', string> = {
  emerald: 'bg-emerald-100 border-emerald-500 text-emerald-800 ring-1 ring-emerald-400',
  amber: 'bg-amber-100 border-amber-500 text-amber-800 ring-1 ring-amber-400',
  rose: 'bg-rose-100 border-rose-500 text-rose-800 ring-1 ring-rose-400',
};

// One-line, work-type-specific reminder for the Photos section (shown as its
// subtitle, like the Bid Item section).
const photoGuidance = (_worktype: string, _subtype: string): string =>
  'Show photo evidence of the full service performed.';

export default function ServiceDetail({ svc, form, isInternal, unlock, propMeta, asVendor, isVendor }: { svc: ServiceView; form: ServiceQuestion[]; isInternal: boolean; unlock: { propertyId: string; address: string; ring: LockRing } | null; propMeta: { bedrooms: number | null; bathrooms: number | null; sqft: number | null; region: string } | null; asVendor: boolean; isVendor: boolean }) {
  const router = useRouter();
  // Bid items are never crew-completed here — they go straight to internal bid review.
  const editable = EDITABLE.has(svc.status) && !svc.isBidItem;
  // Past-due (open statuses only) — turns the header Due date red, like the home list.
  // Past-due against the REAL today for live records (sample preview keeps its
  // fixed reference date). Strict "<" so a service due TODAY is still on-time.
  const todayISO = easternTodayISO();
  const overdue = ['estimated', 'assigned', 'submitted', 'review'].includes(svc.status) && !!svc.dueDate && svc.dueDate < todayISO;
  // Resting display for a $ input: pad to 2 decimals on blur (e.g. "250" → "250.00").
  const fmt2 = (v: string): string => { const n = Number(v); return v.trim() !== '' && Number.isFinite(n) ? n.toFixed(2) : v; };
  const underReview = svc.status === 'review';
  const canReview = isInternal && underReview;
  const canBidReview = isInternal && svc.isBidItem && svc.status === 'estimated';

  // ── Completion (editable) state ──
  // Seed from the server-saved DRAFT (answers_json + photo urls the autosave
  // endpoint persisted) so an in-progress completion restores on ANY device, not
  // just the one it was typed on. The localStorage draft (below) overlays this
  // with the most-recent same-device edits.
  const [answers, setAnswers] = useState<Record<string, any>>(() => (editable ? svc.answers || {} : {}));
  const [before, setBefore] = useState<string[]>(() => (editable ? svc.before || [] : []));
  const [after, setAfter] = useState<string[]>(() => (editable ? svc.after || [] : []));
  const [petBefore, setPetBefore] = useState<string[]>(() => (editable ? svc.petBefore || [] : []));
  const [petAfter, setPetAfter] = useState<string[]>(() => (editable ? svc.petAfter || [] : []));
  const [submitting, setSubmitting] = useState(false);
  const [doneStatus, setDoneStatus] = useState<string>('');   // '' | submitted | queued | completed
  const [reissueMsg, setReissueMsg] = useState<string>('');   // set when a review re-issues the service
  const [error, setError] = useState('');
  const [pendingQueued, setPendingQueued] = useState(false);
  const setAns = (id: string, v: any) => setAnswers((a) => {
    const next: Record<string, any> = { ...a, [id]: v };
    // Changing a parent answer hides its dependent questions — clear those hidden
    // answers (and their note/photo) so they don't persist unseen or keep driving
    // pricing/routing. Parents precede dependents in the form, so one ordered
    // pass cascades correctly.
    for (const q of form) {
      if (q.showWhen && next[q.showWhen.qid] !== q.showWhen.value) {
        delete next[q.id];
        delete next[`${q.id}__note`];
        delete next[`${q.id}__photos`];
      }
    }
    return next;
  });

  // Additional-work bid capture: when Yes, description + cost + photos are required.
  // On submit this spawns a new Estimated "Bid Item" service for internal review.
  const [bidWanted, setBidWanted] = useState(false);
  const [bidDesc, setBidDesc] = useState('');
  const [bidCost, setBidCost] = useState('');
  const [bidPhotos, setBidPhotos] = useState<string[]>([]);
  const bidValid = !bidWanted || (!!bidDesc.trim() && !!bidCost.trim() && Number(bidCost) > 0 && bidPhotos.length > 0);

  // Kick offline sync (photos + any queued submit) on mount and reconnect; flag a
  // completion that's already queued offline for this service.
  useEffect(() => {
    initServiceSync();
    let alive = true;
    hasPendingSubmit(svc.id).then((p) => { if (alive) setPendingQueued(p); }).catch(() => {});
    // When a queued photo finishes uploading, swap its draft blob: URL for the hosted URL.
    const off = onServiceSync(({ url, draftUrl }) => {
      if (!draftUrl) return;
      const swap = (arr: string[]) => arr.map((u) => (u === draftUrl ? url : u));
      setBefore(swap); setAfter(swap); setPetBefore(swap); setPetAfter(swap);
    });
    return () => { alive = false; off(); };
  }, [svc.id]);
  const uploadFor = useMemo(() => (file: File) => capturePhotoOrQueue(svc.id, file), [svc.id]);

  // ── Draft autosave: persist the in-progress completion (answers/photos/bid) as
  // you go so nothing is lost if you leave and come back — no waiting for Submit.
  // TWO layers: (1) localStorage for instant same-device restore + offline, and
  // (2) a debounced SERVER save (answers_json + hosted photo urls, no status
  // change) so the draft also survives a device switch / app reinstall and is
  // visible server-side. Only hosted photo URLs are kept (blob: drafts die on
  // reload). Cleared once the completion is submitted/queued. ──
  const DRAFT_KEY = `resiwalk.svc.draft.${svc.id}`;
  const hydrated = useRef(false);
  const stopSave = useRef(false);            // set once submitted — no more autosave
  const lastPersisted = useRef('');          // snapshot last written (skip no-op saves)

  // Latest draft snapshot (hosted photo urls only), in a ref so the teardown
  // handlers always flush the CURRENT values (never a stale closure).
  // For localStorage: keep un-uploaded photos as durable ref:<localId> tokens (NOT
  // dropped) so a photo captured offline survives an app reload before it uploads —
  // rehydrated from IndexedDB bytes on load. Hosted URLs pass through unchanged.
  const toDurable = (arr: string[]) => arr.map(toDurableRef);
  // For the SERVER autosave: hosted URLs only (the server can't resolve a device-
  // local ref: or a blob:).
  const hostedOnly = (arr: string[]) => (arr || []).filter((u) => /^https?:\/\//i.test(u));
  const draftRef = useRef<any>({});
  draftRef.current = {
    answers, before: toDurable(before), after: toDurable(after),
    petBefore: toDurable(petBefore), petAfter: toDurable(petAfter),
    bidWanted, bidDesc, bidCost, bidPhotos: toDurable(bidPhotos),
  };
  const writeLocal = () => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draftRef.current)); } catch { /* quota / private mode */ } };
  // Persist the draft to the Work Order (no status change). `beacon` uses
  // sendBeacon for page-teardown (the async fetch wouldn't finish in time).
  const serverSave = (beacon = false): void => {
    if (!editable || !svc.live || stopSave.current) return;
    const d = draftRef.current;
    const body = JSON.stringify({ answers: d.answers, before: hostedOnly(d.before), after: hostedOnly(d.after), petBefore: hostedOnly(d.petBefore), petAfter: hostedOnly(d.petAfter) });
    const url = `/api/services/${encodeURIComponent(svc.id)}/autosave`;
    try {
      if (beacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      } else {
        void fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => { /* best-effort */ });
      }
    } catch { /* best-effort — localStorage still covers this device */ }
  };
  const serverSaveRef = useRef(serverSave);
  serverSaveRef.current = serverSave;
  const flushDraft = (beacon = false) => { if (editable && !stopSave.current) { writeLocal(); serverSaveRef.current(beacon); } };
  const clearDraft = () => { stopSave.current = true; try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ } };

  // (Re-)seed on record change — the pager reuses this component instance, so
  // state must be reset to THIS order's draft (localStorage same-device draft wins
  // over the server-seeded values), not left holding the previous order's answers.
  useEffect(() => {
    let d: any = null;
    try { const raw = localStorage.getItem(DRAFT_KEY); if (raw) d = JSON.parse(raw); } catch { /* corrupt draft */ }
    if (editable) {
      const seed = {
        answers: d?.answers && typeof d.answers === 'object' ? d.answers : (svc.answers || {}),
        before: Array.isArray(d?.before) ? d.before : (svc.before || []),
        after: Array.isArray(d?.after) ? d.after : (svc.after || []),
        petBefore: Array.isArray(d?.petBefore) ? d.petBefore : (svc.petBefore || []),
        petAfter: Array.isArray(d?.petAfter) ? d.petAfter : (svc.petAfter || []),
        bidWanted: typeof d?.bidWanted === 'boolean' ? d.bidWanted : false,
        bidDesc: typeof d?.bidDesc === 'string' ? d.bidDesc : '',
        bidCost: typeof d?.bidCost === 'string' ? d.bidCost : '',
        bidPhotos: Array.isArray(d?.bidPhotos) ? d.bidPhotos : [],
      };
      setAnswers(seed.answers); setBefore(seed.before); setAfter(seed.after);
      setPetBefore(seed.petBefore); setPetAfter(seed.petAfter);
      setBidWanted(seed.bidWanted); setBidDesc(seed.bidDesc); setBidCost(seed.bidCost); setBidPhotos(seed.bidPhotos);
      // Baseline the persisted snapshot so opening a record doesn't fire a needless save.
      lastPersisted.current = JSON.stringify(seed);
      // Restore any durable ref:<localId> tokens (photos captured offline before
      // this reload) to displayable URLs — hosted if they've since uploaded, else a
      // fresh object URL from the IndexedDB bytes. Async + best-effort; a dropped
      // token (bytes truly gone) is filtered out rather than shown broken.
      const hasRefs = (a: string[]) => a.some((u) => typeof u === 'string' && u.startsWith('ref:'));
      const restore = async (arr: string[], set: (v: string[]) => void) => {
        if (!hasRefs(arr)) return;
        const out = (await Promise.all(arr.map((u) => (u.startsWith('ref:') ? rehydrateRef(u) : Promise.resolve(u))))).filter((u): u is string => !!u);
        set(out);
      };
      void restore(seed.before, setBefore); void restore(seed.after, setAfter);
      void restore(seed.petBefore, setPetBefore); void restore(seed.petAfter, setPetAfter);
      void restore(seed.bidPhotos, setBidPhotos);
    }
    stopSave.current = false;
    hydrated.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svc.id]);

  // Debounced persist — only when the draft actually changed (skips the open re-seed).
  useEffect(() => {
    if (!hydrated.current || !editable) return;
    const t = setTimeout(() => {
      const cur = JSON.stringify(draftRef.current);
      if (cur === lastPersisted.current) return;
      lastPersisted.current = cur;
      writeLocal();
      serverSaveRef.current(false);
    }, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answers, before, after, petBefore, petAfter, bidWanted, bidDesc, bidCost, bidPhotos, editable]);

  // Flush on teardown so an edit made within the debounce window is never lost:
  // tab hidden / pagehide (app-switch, close) → sendBeacon; unmount (back) →
  // keepalive fetch. Pager navigation reuses the component (no unmount) and is
  // handled explicitly at the ServicePager call site.
  useEffect(() => {
    if (!editable) return;
    const onHidden = () => { if (document.visibilityState === 'hidden') flushDraft(true); };
    const onTeardown = () => flushDraft(true);
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', onTeardown);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onTeardown);
      if (hydrated.current) flushDraft(true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable]);

  // A question is visible unless its showWhen condition isn't met.
  const isVisible = (q: ServiceQuestion) => !q.showWhen || answers[q.showWhen.qid] === q.showWhen.value;
  // Per-answer requirements: a chosen answer can require a note and/or a photo
  // (configured per answer choice in the Form Builder). Notes/photos are stored
  // in the answers blob under derived keys so they persist + submit generically.
  const noteKey = (id: string) => `${id}__note`;
  const photosKey = (id: string) => `${id}__photos`;
  const selectedValues = (q: ServiceQuestion): string[] => {
    const v = answers[q.id];
    if (q.type === 'multi') return Array.isArray(v) ? v.map(String) : [];
    return v != null && v !== '' ? [String(v)] : [];
  };
  const reqFor = (q: ServiceQuestion, kind: 'note' | 'photo') => !!q.answerReqs && selectedValues(q).some((val) => !!q.answerReqs?.[val]?.[kind]);
  const noteRequired = (q: ServiceQuestion) => reqFor(q, 'note');
  const photoRequired = (q: ServiceQuestion) => reqFor(q, 'photo');
  const noteMissing = (q: ServiceQuestion) => noteRequired(q) && !String(answers[noteKey(q.id)] || '').trim();
  const photoMissing = (q: ServiceQuestion) => photoRequired(q) && !(Array.isArray(answers[photosKey(q.id)]) && answers[photosKey(q.id)].length > 0);

  // Default any visible date question flagged defaultToday to today (editable).
  useEffect(() => {
    for (const q of form) {
      if (q.type === 'date' && q.defaultToday && isVisible(q) && !answers[q.id]) {
        setAns(q.id, easternTodayISO());
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answers.svc_completed, form]);

  const requiredMissing = useMemo(() => form.some((q) => {
    if (!isVisible(q)) return false;
    if (noteMissing(q) || photoMissing(q)) return true;   // per-answer note/photo not yet supplied
    if (!q.required) return false;
    const v = answers[q.id];
    if (q.type === 'multi') return !Array.isArray(v) || v.length === 0;
    return v === undefined || v === '' || v === null;
  }), [form, answers]);
  // Before + after photos are ALWAYS required — even when the service wasn't
  // completed or access failed — to verify the vendor's effort on site.
  const photosOk = before.length > 0 && after.length > 0;
  const ready = !requiredMissing && photosOk && bidValid && !submitting;

  const submit = async () => {
    setSubmitting(true); setError('');
    try {
      const bid = bidWanted && bidValid ? { description: bidDesc.trim(), vendorCost: Number(bidCost), photos: bidPhotos } : undefined;
      const res = await submitServiceOrQueue(svc.id, { answers, before, after, petBefore, petAfter, bid, submittedAt: new Date().toISOString() });
      clearDraft();   // completion captured (sent or durably queued) — draft no longer needed
      setDoneStatus(res.status === 'sent' ? 'submitted' : 'queued');
    } catch { setError('Couldn’t save. Try again.'); }
    finally { setSubmitting(false); }
  };

  // ── Review / bid decisions (shared DecisionPanel) ──
  // Both use the SAME three options (Approve / Modify / Reject), all requiring a
  // note. Completion review (status=review) closes to Completed; bid review
  // (estimated bid item) moves Approve/Modify to Assigned (both need days-until-
  // due) and Reject to Canceled.
  const origCost = svc.vendorCost ?? 0;
  const markupPct = svc.markupPct ?? 0;
  const origClient = svc.clientCost ?? Math.round(origCost * (1 + markupPct / 100) * 100) / 100;
  const [deciding, setDeciding] = useState(false);

  // Was the service marked NOT completed? (svc_completed=No, an answered Bill Trip
  // Fee, or "able to access"=No). Only then does Re-Issue make sense in review.
  const svcNotCompleted = useMemo(() => {
    const a = svc.answers || {};
    const byLabel = (re: RegExp) => { const q = form.find((x) => re.test(x.label)); return q ? a[q.id] : undefined; };
    const completed = a['svc_completed'] ?? byLabel(/service\s*completed/i);
    const access = byLabel(/able to access|access the property/i);
    const bill = a['bill_trip_fee'] ?? byLabel(/trip\s*fee/i);
    return String(completed) === 'no' || String(access) === 'no' || bill === 'yes' || bill === 'no';
  }, [svc.answers, form]);

  const submitReview = async (p: DecisionPayload) => {
    setDeciding(true); setError('');
    try {
      const body: any = { decision: p.decision, notes: p.notes };
      if (p.decision === 'modify') { body.vendorCost = p.vendorCost; body.markupPct = p.markupPct; }
      if (p.reissue) { body.reissue = true; body.reissueDays = p.reissueDays; body.reissueNote = p.reissueNote; }
      const r = await fetch(`/api/services/${encodeURIComponent(svc.id)}/review-decision`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Could not save decision.'); return; }
      if (p.reissue) {
        setReissueMsg(d.reissued && d.reissuedId
          ? 'A new service was created with the original requirements and assignment.'
          : d.reissueError
            ? `The service closed out, but the re-issue couldn’t be created: ${d.reissueError}`
            : 'A new service was created with the original requirements and assignment.');
      }
      // Community grass-cut master → confirm the per-property billing split.
      if (typeof d.split === 'number' && d.split > 0) {
        setReissueMsg(`Split into ${d.split} per-property billing line${d.split === 1 ? '' : 's'}.`);
      }
      setDoneStatus('completed');
    } catch { setError('Couldn’t reach the server. Try again.'); }
    finally { setDeciding(false); }
  };

  const submitBid = async (p: DecisionPayload) => {
    setDeciding(true); setError('');
    try {
      const body: any = { decision: p.decision, notes: p.notes };
      if (p.decision !== 'reject') { body.vendorCost = p.vendorCost; body.markupPct = p.markupPct; body.dueDays = p.dueDays; }
      const r = await fetch(`/api/services/${encodeURIComponent(svc.id)}/bid-decision`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Could not save decision.'); return; }
      setDoneStatus('decided');
    } catch { setError('Couldn’t reach the server. Try again.'); }
    finally { setDeciding(false); }
  };

  const inputCls = 'w-full text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:border-brand';
  const chip = (t: string, cls: string) => <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full ${cls}`}>{t}</span>;

  // Photo gallery (read-only lightbox): Before / After / Pet groups you can toggle
  // between and swipe through — same viewer inspections use.
  const gallery = useMemo(() => {
    const groups: { id: string; name: string }[] = [];
    const map: Record<string, string[]> = {};
    const add = (id: string, name: string, urls: string[]) => { if (urls.length) { groups.push({ id, name }); map[id] = urls; } };
    add('before', svc.isBidItem ? 'Bid photos' : 'Before', svc.before); add('after', 'After', svc.after);
    add('petBefore', 'Pet — Before', svc.petBefore); add('petAfter', 'Pet — After', svc.petAfter);
    // Per-question answer photos — each becomes its own navigable lightbox group,
    // so tapping one opens the same viewer (swipe / download / return) as the
    // Before/After groups instead of a raw new browser tab.
    for (const q of (form || [])) {
      const ph = (svc.answers as any)?.[`${q.id}__photos`];
      if (Array.isArray(ph) && ph.length) add(`q:${q.id}`, q.label, ph);
    }
    return { groups, map };
  }, [svc, form]);
  const [lightbox, setLightbox] = useState<{ groupId: string; index: number } | null>(null);

  // ── Collapse / expand all sections (record view) — mirrors the inspection
  // template. `allOpen` tracks the button's next action; bumping the token forces
  // every CollapsibleSection under the provider to that state.
  const [collapseSignal, setCollapseSignal] = useState({ open: true, token: 0 });
  const [allSectionsOpen, setAllSectionsOpen] = useState(true);
  const toggleAllSections = () => {
    const open = !allSectionsOpen;
    setAllSectionsOpen(open);
    setCollapseSignal((s) => ({ open, token: s.token + 1 }));
  };

  // ── Settings (internal): audit log + reassign vendor ──
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[] | null>(null);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [reassignVendor, setReassignVendor] = useState(svc.vendor || '');
  const [reassignQuery, setReassignQuery] = useState('');
  // Live assignable vendors from the approved Companies list (internal reassign).
  const [vendorNames, setVendorNames] = useState<string[]>(svc.vendor ? [svc.vendor] : []);
  useEffect(() => {
    if (!isInternal) return;
    let alive = true;
    fetch('/api/services/vendors').then((r) => r.json()).then((d) => {
      if (!alive || !Array.isArray(d?.vendors)) return;
      const names = d.vendors.map((v: any) => String(v.name)).filter(Boolean);
      // Keep the current vendor selectable even if not in the approved list.
      setVendorNames(svc.vendor && !names.includes(svc.vendor) ? [svc.vendor, ...names] : names);
    }).catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isInternal]);
  const [reassigning, setReassigning] = useState(false);
  const [settingsMsg, setSettingsMsg] = useState('');
  const canReassign = isInternal && svc.live && !['completed', 'canceled'].includes(svc.status);
  // Internal users can push a service's due date out (vendor feedback, etc.), but
  // only BEFORE the vendor submits — once it's submitted/review/completed the due
  // window is settled.
  const canEditDue = isInternal && svc.live && ['estimated', 'assigned'].includes(svc.status);
  const [dueOpen, setDueOpen] = useState(false);
  const [newDue, setNewDue] = useState(svc.dueDate || '');
  const [dueReason, setDueReason] = useState('');
  const [savingDue, setSavingDue] = useState(false);

  const openAudit = async () => {
    setSettingsOpen(false); setAuditOpen(true); setAuditEvents(null);
    try {
      const r = await fetch(`/api/services/${encodeURIComponent(svc.id)}/audit`);
      const d = await r.json();
      setAuditEvents(Array.isArray(d.events) ? d.events : []);
    } catch { setAuditEvents([]); }
  };
  const doReassign = async () => {
    if (!reassignVendor || reassignVendor === svc.vendor) { setReassignOpen(false); return; }
    setReassigning(true); setSettingsMsg('');
    try {
      const r = await fetch(`/api/services/${encodeURIComponent(svc.id)}/reassign`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vendorName: reassignVendor }),
      });
      const d = await r.json();
      if (!r.ok) { setSettingsMsg(d.error || 'Could not reassign.'); return; }
      setReassignOpen(false);
      router.replace(router.asPath, undefined, { scroll: false }).catch(() => {});   // refresh the record
    } catch { setSettingsMsg('Couldn’t reach the server. Try again.'); }
    finally { setReassigning(false); }
  };
  const doChangeDue = async () => {
    if (!newDue || newDue === svc.dueDate) { setDueOpen(false); return; }
    setSavingDue(true); setSettingsMsg('');
    try {
      const r = await fetch(`/api/services/${encodeURIComponent(svc.id)}/due-date`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dueDate: newDue, reason: dueReason.trim() }),
      });
      const d = await r.json();
      if (!r.ok) { setSettingsMsg(d.error || 'Could not change the due date.'); return; }
      setDueOpen(false); setDueReason('');
      router.replace(router.asPath, undefined, { scroll: false }).catch(() => {});   // refresh with the new due date
    } catch { setSettingsMsg('Couldn’t reach the server. Try again.'); }
    finally { setSavingDue(false); }
  };

  // Cost Detail — its own section (after Photos). Vendor Cost is visible to all;
  // Markup % and Client Cost are internal-only (vendors never see them). A
  // reviewer deciding sees the live New/Original/Difference in the DecisionPanel's
  // mini-table below, so this stays the plain saved figures.
  const costDetail = svc.vendorCost != null ? (
    <CollapsibleSection title="Cost Detail" bodyClass="space-y-1 text-[13px]">
      <div className="flex justify-between"><span className="text-gray-500">Vendor Cost</span><span className="font-semibold text-ink tabular-nums">{money(svc.vendorCost)}</span></div>
      {isInternal && svc.markupPct != null && <div className="flex justify-between"><span className="text-gray-500">Markup</span><span className="font-semibold text-ink tabular-nums">{svc.markupPct}%</span></div>}
      {isInternal && svc.clientCost != null && <div className="flex justify-between"><span className="text-gray-500">Client Cost</span><span className="font-semibold text-ink tabular-nums">{money(svc.clientCost)}</span></div>}
    </CollapsibleSection>
  ) : null;

  // While the crew is completing the form, the Cost Detail reflects what the
  // answers will actually bill — mirroring the submit-side pricing so the number
  // matches before and after submission. Bill Trip Fee = Yes → $35 trip fee,
  // No → $0; grass-cut is priced by height (−25% if the back yard was skipped);
  // otherwise the assigned rate stands.
  const liveCost = useMemo(() => {
    const orig = svc.vendorCost ?? 0;
    const markup = svc.markupPct ?? 0;
    const answerFor = (idHint: string, labelRe: RegExp) => {
      if (answers[idHint] != null && answers[idHint] !== '') return answers[idHint];
      const q = form.find((x) => labelRe.test(x.label));
      return q ? answers[q.id] : undefined;
    };
    const billAns = answerFor('bill_trip_fee', /trip\s*fee/i);
    const completedAns = answerFor('svc_completed', /service\s*completed/i);
    const heightAns = answerFor('grass_height', /grass\s*height/i);
    const billTrip = billAns === 'yes' || billAns === true;
    const billAnswered = billTrip || billAns === 'no' || billAns === false;
    const notCompleted = String(completedAns) === 'no';
    let vendor = orig;
    let reason = '';
    // Property-scoped cost rules only. Community services keep their assigned
    // cost here — their own cost logic is coming later.
    if (svc.scope === 'property') {
      if (notCompleted || billAnswered) {
        vendor = billTrip ? (defaultRateFor('trip_fee', 'base_trip_fee') ?? 0) : 0;
        reason = billTrip ? 'Not completed — trip fee' : 'Not completed — no charge';
      } else if (svc.worktype === 'landscaping' && svc.subtype === 'cut') {
        vendor = grassTierAmount(String(heightAns || ''), svc.grassTiers);
      }
    }
    const client = Number.isFinite(markup) ? Math.round(vendor * (1 + markup / 100) * 100) / 100 : vendor;
    return { vendor, client, markup, reason, changed: Math.round(vendor * 100) !== Math.round(orig * 100) };
  }, [answers, form, svc.vendorCost, svc.markupPct, svc.worktype, svc.subtype, svc.scope]);

  const editableCostDetail = svc.vendorCost != null ? (
    <CollapsibleSection title="Cost Detail" bodyClass="space-y-1 text-[13px]">
      <div className="flex justify-between"><span className="text-gray-500">Vendor Cost</span><span className="font-semibold text-ink tabular-nums">{money(liveCost.vendor)}</span></div>
      {isInternal && <div className="flex justify-between"><span className="text-gray-500">Markup</span><span className="font-semibold text-ink tabular-nums">{liveCost.markup}%</span></div>}
      {isInternal && <div className="flex justify-between"><span className="text-gray-500">Client Cost</span><span className="font-semibold text-ink tabular-nums">{money(liveCost.client)}</span></div>}
      {liveCost.changed && liveCost.reason && (
        <div className="text-[12px] text-amber-700 pt-1">{liveCost.reason} — was {money(svc.vendorCost)}.</div>
      )}
    </CollapsibleSection>
  ) : null;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="bg-white border-b-2 border-brand sticky top-0 z-30 shrink-0" style={{ paddingTop: 'min(env(safe-area-inset-top), 0.5rem)' }}>
        {/* Tier 1 — top bar: worktype · subtype, status chip, lock (if any), back.
            Keeping the chip + lock up here means they never crowd the info rows. */}
        <div className="max-w-2xl mx-auto px-3 pt-2 flex items-center gap-2">
          <div className="min-w-0 flex-1 leading-tight">
            <div className="text-[13px] font-heading font-bold text-ink truncate">{worktypeLabel(svc.worktype)}</div>
            <div className="text-[12px] font-heading font-semibold text-gray-500 truncate">{subtypeLabel(svc.worktype, svc.subtype)}</div>
          </div>
          <span className={`shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-heading font-semibold border ${SERVICE_STATUS_STYLE[(svc.status || 'assigned') as ServiceStatus] || SERVICE_STATUS_STYLE.assigned}`}>
            {serviceStatusText(svc.status || 'assigned', isInternal)}
            {isInternal && svc.status === 'submitted' && <AiSparkle className="w-3 h-3" />}
          </span>
          {isInternal && svc.live && (
            <div className="relative shrink-0">
              <button type="button" onClick={() => setSettingsOpen((o) => !o)} aria-label="Service settings" aria-expanded={settingsOpen}
                className="w-7 h-7 grid place-items-center text-gray-400 hover:text-ink">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
              </button>
              {settingsOpen && (<><div className="fixed inset-0 z-30" onClick={() => setSettingsOpen(false)} />
                <div className="absolute right-0 mt-1 w-44 bg-white rounded-xl shadow-lg border border-gray-200 z-40 overflow-hidden text-ink">
                  <div className="px-4 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">Admin</div>
                  <button type="button" onClick={openAudit} className="w-full text-left px-4 py-2.5 text-sm hover:bg-gray-50">Audit Log</button>
                  {canReassign && <button type="button" onClick={() => { setSettingsOpen(false); setReassignVendor(svc.vendor || ''); setReassignQuery(''); setSettingsMsg(''); setReassignOpen(true); }} className="w-full text-left px-4 py-2.5 text-sm hover:bg-gray-50 border-t border-gray-100">Reassign Vendor</button>}
                  {canEditDue && <button type="button" onClick={() => { setSettingsOpen(false); setNewDue(svc.dueDate || ''); setSettingsMsg(''); setDueOpen(true); }} className="w-full text-left px-4 py-2.5 text-sm hover:bg-gray-50 border-t border-gray-100">Change Due Date</button>}
                </div></>)}
            </div>
          )}
          <ServicePager currentId={svc.id} onNavigate={(id) => { if (id === svc.id) return; flushDraft(true); router.replace(`/services/${id}`).catch(() => {}); }} />
          {unlock && <UnlockButton propertyId={unlock.propertyId} address={unlock.address} lockRing={unlock.ring} className="w-7 h-7 shrink-0" />}
          <Link href="/services" aria-label="Back to Services" className="shrink-0 text-gray-400 hover:text-ink">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>
          </Link>
        </div>
        {/* Tier 2 — info: logo + full address + (property) bed/bath·sqft·region + vendor·due. */}
        <div className="max-w-2xl mx-auto px-3 pt-1 pb-2.5 flex items-center gap-2.5">
          <Link href="/services" aria-label="Services home" className="shrink-0">
            <img src="/favicon.svg" alt="ResiWalk" className="h-9 w-9 object-contain" />
          </Link>
          <div className="min-w-0 flex-1 space-y-0.5">
            <FitText text={`${svc.address}${svc.locality ? `, ${svc.locality}` : ''}`} className="font-heading font-extrabold text-ink" max={17} min={11} />
            {svc.scope === 'property' && propMeta && (propMeta.bedrooms || propMeta.bathrooms || propMeta.sqft || propMeta.region) && (
              <div className="text-xs text-gray-500 leading-tight truncate">{[
                (propMeta.bedrooms || propMeta.bathrooms) ? `${propMeta.bedrooms ?? '?'} Bed / ${propMeta.bathrooms ?? '?'} Bath` : '',
                propMeta.sqft ? `${propMeta.sqft.toLocaleString()} sqft` : '',
                propMeta.region || '',
              ].filter(Boolean).join(' · ')}</div>
            )}
            <div className="text-xs text-gray-500 leading-tight truncate">
              {svc.vendor || 'Unassigned'}
              {svc.status === 'estimated'
                ? <> · <span className="font-semibold text-gray-600">Estimated{(svc.estimatedAt || svc.dueDate) ? ` ${fmtMDY(svc.estimatedAt || svc.dueDate)}` : ''}</span></>
                : svc.dueDate && <> · <span className={overdue ? 'text-red-600 font-semibold' : ''}>Due {fmtMDY(svc.dueDate)}</span></>}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto w-full px-4 py-4 flex-1 space-y-4">
        {asVendor && !isVendor && (
          <div className="flex items-center justify-between gap-2 bg-purple-600 text-white rounded-xl px-3 py-2 text-[12px] font-heading font-semibold">
            <span>Viewing as Vendor</span>
            <button type="button" onClick={() => { setViewAsVendor(false); window.location.href = '/services'; }} className="underline shrink-0">Exit</button>
          </div>
        )}
        {doneStatus === 'submitted' ? (
          <div className="bg-white border border-emerald-300 rounded-2xl p-6 text-center mt-6">
            <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-700 grid place-items-center text-2xl mx-auto mb-3">✓</div>
            <div className="font-heading font-extrabold text-lg text-ink">Submitted — Under Review</div>
            <p className="text-sm text-gray-500 mt-1">Thanks — your completion has been submitted. Our review team will verify the photos and details and process it shortly. You’ll see it move to <b>Completed</b> once it’s approved.</p>
            <Link href="/services" className="inline-block mt-4 bg-brand text-white font-heading font-bold text-sm rounded-xl px-5 py-2.5">Back to Services</Link>
          </div>
        ) : doneStatus === 'queued' ? (
          <div className="bg-white border border-amber-300 rounded-2xl p-6 text-center mt-6">
            <div className="w-12 h-12 rounded-full bg-amber-100 text-amber-700 grid place-items-center text-2xl mx-auto mb-3">⤓</div>
            <div className="font-heading font-extrabold text-lg text-ink">Saved offline</div>
            <p className="text-sm text-gray-500 mt-1">You’re offline. This completion and its photos are saved on your device and will submit automatically the moment you’re back online — you can close the app.</p>
            <Link href="/services" className="inline-block mt-4 bg-brand text-white font-heading font-bold text-sm rounded-xl px-5 py-2.5">Back to Services</Link>
          </div>
        ) : doneStatus === 'decided' ? (
          <div className="bg-white border border-emerald-300 rounded-2xl p-6 text-center mt-6">
            <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-700 grid place-items-center text-2xl mx-auto mb-3">✓</div>
            <div className="font-heading font-extrabold text-lg text-ink">Decision recorded</div>
            <p className="text-sm text-gray-500 mt-1">The bid decision was saved. Approved bids move to <b>Assigned</b> and follow the normal cadence; rejected bids are <b>Canceled</b>.</p>
            <Link href="/services" className="inline-block mt-4 bg-brand text-white font-heading font-bold text-sm rounded-xl px-5 py-2.5">Back to Services</Link>
          </div>
        ) : doneStatus === 'completed' ? (
          <div className="bg-white border border-emerald-300 rounded-2xl p-6 text-center mt-6">
            <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-700 grid place-items-center text-2xl mx-auto mb-3">✓</div>
            <div className="font-heading font-extrabold text-lg text-ink">Completed</div>
            <p className="text-sm text-gray-500 mt-1">The decision was recorded and the service is closed out.</p>
            {reissueMsg && <p className="text-sm text-brand font-heading font-semibold mt-2">{reissueMsg}</p>}
            <Link href="/services" className="inline-block mt-4 bg-brand text-white font-heading font-bold text-sm rounded-xl px-5 py-2.5">Back to Services</Link>
          </div>
        ) : (
          <SectionCollapseCtx.Provider value={collapseSignal}>
            {/* PDFs (live records, once submitted). Vendor copy shows the Vendor Cost
                and is available to everyone; the Client copy shows the Client Cost and
                is internal-only, unlocked once the review is finalized (Completed). */}
            {!editable && svc.live && (
              <div className="flex flex-wrap items-center gap-4">
                <a href={`/api/services/${encodeURIComponent(svc.id)}/pdf?variant=vendor`} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-[13px] font-heading font-bold text-brand">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
                  Vendor PDF
                </a>
                {isInternal && svc.status === 'completed' && (
                  <a href={`/api/services/${encodeURIComponent(svc.id)}/pdf?variant=client`} target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-[13px] font-heading font-bold text-brand">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
                    Client PDF
                  </a>
                )}
              </div>
            )}

            {pendingQueued && editable && (
              <div className="bg-amber-50 border border-amber-200 rounded-2xl p-3 text-[13px] text-amber-800">
                A completion for this service is saved offline and will submit automatically when you’re back online. No need to re-enter it.
              </div>
            )}

            {/* Office instructions / service brief — always at the TOP for every
                status (re-issued services carry the reviewer's note here). Bid
                items render their own "Bid request" block instead. */}
            {svc.description.trim() && !svc.isBidItem && (
              <section className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
                <div className="text-[11px] font-bold uppercase tracking-wide text-amber-700 mb-1">Service Order Description</div>
                <p className="text-[13px] text-ink whitespace-pre-line">{svc.description}</p>
              </section>
            )}

            {/* Collapse / expand ALL sections at once — mirrors the inspection
                template's control. Sits just above the section stack. */}
            <div className="flex justify-end">
              <button
                type="button"
                onClick={toggleAllSections}
                className="inline-flex items-center gap-1 text-xs font-heading font-semibold text-gray-500 hover:text-gray-800 transition-colors"
                title={allSectionsOpen ? 'Collapse all sections' : 'Expand all sections'}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                     className={`transition-transform ${allSectionsOpen ? '' : 'rotate-180'}`}>
                  <polyline points="18 15 12 9 6 15" />
                </svg>
                {allSectionsOpen ? 'Collapse all' : 'Expand all'}
              </button>
            </div>

            {/* Community grass-cut master: the covered-home list, SECOND (below the
                description). Crew sees it; reviewer curates it before split.
                Collapsed by default. Shown in every status. */}
            {svc.isMaster && <MasterCoverage svc={svc} isInternal={isInternal} />}

            {/* A per-property billing line split off a community master. */}
            {svc.masterServiceId && (
              <div className="bg-gray-50 border border-gray-200 rounded-2xl p-3 text-[13px] text-gray-600 flex items-center justify-between gap-3">
                <span>Per-property billing line from a community grass cut. Photos are on the master.</span>
                <Link href={`/services/${encodeURIComponent(svc.masterServiceId)}`} className="font-heading font-bold text-brand shrink-0">View master →</Link>
              </div>
            )}

            {editable ? (
              /* ── Editable completion form (assigned crew) ── */
              <>
                <CollapsibleSection title="Completion Checklist">
                  {form.length === 0 && <div className="text-[13px] text-gray-400">No completion form is configured for this service type yet.</div>}
                  {form.filter(isVisible).map((q) => (
                    <div key={q.id}>
                      <label className={Q_LABEL}>{q.label}{q.required && <span className="text-brand"> *</span>}</label>
                      {q.type === 'yesno' && (
                        <>
                          <div className="flex gap-2">
                            {(['yes', 'no'] as const).map((v) => (
                              <button key={v} type="button" onClick={() => setAns(q.id, answers[q.id] === v ? '' : v)}
                                className={`px-4 py-1.5 rounded-full border text-[13px] font-heading font-semibold ${answers[q.id] === v ? 'bg-brand text-white border-brand' : 'bg-white text-gray-700 border-gray-300'}`}>{v === 'yes' ? 'Yes' : 'No'}</button>
                            ))}
                          </div>
                          {/* Bill Trip Fee — explain the billing outcome of the chosen answer. */}
                          {isTripFeeQuestion(q) && (answers[q.id] === 'yes' || answers[q.id] === 'no') && (
                            <div className={`mt-2 text-[12px] font-heading font-semibold rounded-lg px-3 py-2 border ${answers[q.id] === 'yes' ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-gray-50 border-gray-200 text-gray-600'}`}>
                              {answers[q.id] === 'yes'
                                ? 'Service updates for a $35 trip fee, then routes to review to close out.'
                                : 'Service will close out with no billing.'}
                            </div>
                          )}
                        </>
                      )}
                      {q.type === 'single' && (
                        <>
                          {isGrassHeightQuestion(q) ? (
                            <div className="grid grid-cols-3 gap-2">
                              {(q.options || []).map((o) => {
                                const selected = answers[q.id] === o.label;
                                const anySelected = !!answers[q.id];
                                const { main, sub } = splitGrassLabel(o.label);
                                // Before any pick: every tier shows its own color. After a
                                // pick: the chosen tier keeps its color (tinted fill), and
                                // the un-picked ones grey out so the selection stands out.
                                const cls = selected
                                  ? GRASS_TIER_FILL[grassTier(o.label)]
                                  : anySelected
                                    ? 'bg-white text-gray-400 border-gray-200'
                                    : GRASS_TIER_BORDER[grassTier(o.label)];
                                return (
                                  <button key={o.id} type="button" onClick={() => setAns(q.id, answers[q.id] === o.label ? '' : o.label)}
                                    className={`px-2 py-2 rounded-xl border-2 text-[13px] font-heading font-bold text-center leading-tight ${cls}`}>
                                    <div>{main}</div>
                                    {sub && <div className="text-[11px] font-semibold opacity-80 mt-0.5">{sub}</div>}
                                  </button>
                                );
                              })}
                            </div>
                          ) : (
                            <div className={`gap-2 ${(q.options || []).length === 3 ? 'grid grid-cols-3' : 'flex flex-wrap'}`}>
                              {(q.options || []).map((o) => (
                                <button key={o.id} type="button" onClick={() => setAns(q.id, answers[q.id] === o.label ? '' : o.label)}
                                  className={`px-3 py-1.5 rounded-xl border text-[13px] font-heading font-semibold text-center leading-tight ${answers[q.id] === o.label ? 'bg-brand text-white border-brand' : 'bg-white text-gray-700 border-gray-300'}`}>{o.label}</button>
                              ))}
                            </div>
                          )}
                          {isGrassHeightQuestion(q) && isHigherGrassTier(answers[q.id]) && (
                            <div className="mt-2 text-[12px] font-heading font-semibold rounded-lg px-3 py-2 border bg-amber-50 border-amber-200 text-amber-800">
                              * Higher grass tier — the increased payout is pending review of the photos.
                            </div>
                          )}
                        </>
                      )}
                      {q.type === 'multi' && (
                        <div className={`gap-2 ${(q.options || []).length === 3 ? 'grid grid-cols-3' : 'flex flex-wrap'}`}>
                          {(q.options || []).map((o) => {
                            const sel: string[] = Array.isArray(answers[q.id]) ? answers[q.id] : [];
                            const on = sel.includes(o.label);
                            return (
                              <button key={o.id} type="button"
                                onClick={() => setAns(q.id, on ? sel.filter((x) => x !== o.label) : [...sel, o.label])}
                                className={`px-3 py-1.5 rounded-xl border text-[13px] font-heading font-semibold text-center leading-tight ${on ? 'bg-brand text-white border-brand' : 'bg-white text-gray-700 border-gray-300'}`}>{o.label}</button>
                            );
                          })}
                        </div>
                      )}
                      {q.type === 'text' && (
                        <AutoGrowTextarea value={answers[q.id] || ''} onChange={(e) => setAns(q.id, e.target.value)} className={inputCls} placeholder={q.required ? '' : 'Optional'} />
                      )}
                      {q.type === 'number' && (
                        <input type="number" inputMode="decimal" value={answers[q.id] || ''} onChange={(e) => setAns(q.id, e.target.value)} className={inputCls} />
                      )}
                      {q.type === 'date' && (
                        <div className="w-44 max-w-full">
                          <DatePicker value={answers[q.id] || ''} onChange={(v) => setAns(q.id, v)} className={`${inputCls} flex items-center justify-between`} />
                        </div>
                      )}
                      {/* Per-answer requirements: the chosen answer asks for a note / photo. */}
                      {noteRequired(q) && (
                        <div className="mt-2">
                          <label className="block text-[12px] font-bold uppercase tracking-wide text-gray-400 mb-1">Add a note <span className="text-brand">*</span></label>
                          <AutoGrowTextarea value={answers[noteKey(q.id)] || ''} onChange={(e) => setAns(noteKey(q.id), e.target.value)} minPx={52} className={inputCls} placeholder="Required for this answer…" />
                        </div>
                      )}
                      {photoRequired(q) && (
                        <div className="mt-2">
                          <CameraPhotos label="Photo for this answer" required urls={Array.isArray(answers[photosKey(q.id)]) ? answers[photosKey(q.id)] : []}
                            onChange={(next) => setAns(photosKey(q.id), next)} address={svc.address} propertyRecordId={svc.propertyRecordId} upload={uploadFor} />
                        </div>
                      )}
                    </div>
                  ))}
                </CollapsibleSection>

                <CollapsibleSection title="Photos" subtitle={photoGuidance(svc.worktype, svc.subtype)}>
                  <CameraPhotos label="Before photos" required urls={before} onChange={setBefore} address={svc.address} propertyRecordId={svc.propertyRecordId} upload={uploadFor} />
                  <CameraPhotos label="After photos" required urls={after} onChange={setAfter} address={svc.address} propertyRecordId={svc.propertyRecordId} upload={uploadFor} />
                  {svc.petStations && (
                    <div className="border-t border-gray-100 pt-4 space-y-4">
                      <div className="text-[12px] font-bold uppercase tracking-wide text-brand">Pet Stations</div>
                      <CameraPhotos label="Pet station — before" urls={petBefore} onChange={setPetBefore} address={svc.address} propertyRecordId={svc.propertyRecordId} upload={uploadFor} />
                      <CameraPhotos label="Pet station — after" urls={petAfter} onChange={setPetAfter} address={svc.address} propertyRecordId={svc.propertyRecordId} upload={uploadFor} />
                    </div>
                  )}
                </CollapsibleSection>

                {/* Additional-work bid — spawns an Estimated "Bid Item" for review. */}
                <CollapsibleSection title="Submit Bid Item?" subtitle="Flag extra work that needs its own bid." defaultOpen={false} bodyClass="space-y-3">
                  <div className="flex gap-2">
                    {([['no', 'No'], ['yes', 'Yes — submit a bid']] as const).map(([v, label]) => (
                      <button key={v} type="button" onClick={() => setBidWanted(v === 'yes')}
                        className={`px-4 py-2 rounded-full border text-[13px] font-heading font-semibold ${(bidWanted ? 'yes' : 'no') === v ? 'bg-brand text-white border-brand' : 'bg-white text-gray-700 border-gray-300'}`}>{label}</button>
                    ))}
                  </div>
                  {bidWanted && (
                    <div className="space-y-3 border-t border-gray-100 pt-3">
                      <div>
                        <label className={Q_LABEL}>What’s the Additional Work? <span className="text-brand">*</span></label>
                        <AutoGrowTextarea value={bidDesc} onChange={(e) => setBidDesc(e.target.value)} minPx={64} className={inputCls} placeholder="Describe the extra work needed…" />
                      </div>
                      <div>
                        <label className={Q_LABEL}>Your Bid (Vendor Cost) <span className="text-brand">*</span></label>
                        <div className="relative w-40">
                          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                          <input type="number" inputMode="decimal" value={bidCost} onChange={(e) => setBidCost(e.target.value)} onBlur={() => setBidCost(fmt2(bidCost))} className="w-full text-sm border border-gray-300 rounded-lg pl-6 pr-2 py-2 bg-white focus:outline-none focus:border-brand" placeholder="0.00" />
                        </div>
                      </div>
                      <CameraPhotos label="Bid photos" required urls={bidPhotos} onChange={setBidPhotos} address={svc.address} propertyRecordId={svc.propertyRecordId} upload={uploadFor} />
                    </div>
                  )}
                </CollapsibleSection>

                {editableCostDetail}

                <button type="button" disabled={!ready} onClick={submit}
                  className={`w-full rounded-2xl py-3.5 font-heading font-bold text-sm ${ready ? 'bg-brand text-white' : 'bg-gray-200 text-gray-400'}`}>
                  {submitting ? "Submitting…" : "Submit Completion"}
                </button>
                {error && <div className="text-center text-xs text-red-600 -mt-2">{error}</div>}
                {!ready && !error && !submitting && <div className="text-center text-xs text-gray-400 -mt-2">Answer the required questions and add at least one before and one after photo to submit.</div>}
              </>
            ) : (
              /* ── Read-only view (submitted / review / completed / bid) ── */
              <>
                {svc.isBidItem && svc.description && (
                  <CollapsibleSection title="Bid request" bodyClass="">
                    <p className="text-[13px] text-gray-700 whitespace-pre-line">{svc.description}</p>
                    <p className="text-[12px] text-gray-400 mt-1.5">Submitted by {svc.vendor || 'the vendor'} while completing a {worktypeLabel(svc.worktype)} service.</p>
                  </CollapsibleSection>
                )}
                {isInternal && (svc.aiVerdict || svc.aiNotes) && (
                  <CollapsibleSection title="AI review" bodyClass=""
                    right={svc.aiVerdict ? chip(svc.aiVerdict === 'clean' ? 'Clean' : 'Needs review', svc.aiVerdict === 'clean' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700') : undefined}>
                    {svc.aiNotes && <AiNotes text={svc.aiNotes} />}
                  </CollapsibleSection>
                )}

                {Object.keys(svc.answers).length > 0 && (
                  <CollapsibleSection title="Answers" bodyClass="">
                    <dl className="space-y-2">
                      {form.map((q) => {
                        if (svc.answers[q.id] == null || svc.answers[q.id] === '') return null;
                        const note = String(svc.answers[`${q.id}__note`] || '');
                        return (
                          <div key={q.id} className="text-[13px]">
                            <div className="flex gap-2">
                              <dt className="text-gray-500 flex-1">{q.label}</dt>
                              <dd className="text-ink font-semibold text-right">
                                {Array.isArray(svc.answers[q.id]) ? svc.answers[q.id].map((x: any) => mdyIfDate(String(x))).join(', ') : mdyIfDate(String(svc.answers[q.id]))}
                                {note && <span className="block font-normal text-gray-500">{note}</span>}
                              </dd>
                            </div>
                          </div>
                        );
                      })}
                    </dl>
                  </CollapsibleSection>
                )}

                <CollapsibleSection title="Photos" subtitle="Tap a photo to enlarge">
                  <PhotoGrid label={svc.isBidItem ? 'Bid photos' : 'Before photos'} urls={svc.before} onOpen={(i) => setLightbox({ groupId: 'before', index: i })} />
                  {!svc.isBidItem && <PhotoGrid label="After photos" urls={svc.after} onOpen={(i) => setLightbox({ groupId: 'after', index: i })} />}
                  {!svc.isBidItem && <PhotoGrid label="Pet station — before" urls={svc.petBefore} onOpen={(i) => setLightbox({ groupId: 'petBefore', index: i })} />}
                  {!svc.isBidItem && <PhotoGrid label="Pet station — after" urls={svc.petAfter} onOpen={(i) => setLightbox({ groupId: 'petAfter', index: i })} />}
                  {/* Per-question answer photos as their own labeled sections in the
                      unified gallery — same tile size + full lightbox navigation. */}
                  {form.map((q) => {
                    const ph: string[] = Array.isArray(svc.answers[`${q.id}__photos`]) ? svc.answers[`${q.id}__photos`] : [];
                    return ph.length ? <PhotoGrid key={q.id} label={q.label} urls={ph} onOpen={(i) => setLightbox({ groupId: `q:${q.id}`, index: i })} /> : null;
                  })}
                  {gallery.groups.length === 0 && <div className="text-[13px] text-gray-400">No photos on this service.</div>}
                </CollapsibleSection>

                {costDetail}

                {canBidReview && (
                  <DecisionPanel kind="bid" orig={{ vendor: origCost, markup: markupPct, client: origClient }} busy={deciding} error={error} onSubmit={submitBid} />
                )}

                {svc.reviewDecision && (
                  <section className={`border rounded-2xl p-4 ${svc.reviewDecision === 'reject' ? 'bg-red-50 border-red-200' : 'bg-emerald-50 border-emerald-200'}`}>
                    <div className="font-heading font-bold text-[14px] text-ink">Review: {svc.reviewDecision === 'reject' ? 'Rejected' : svc.reviewDecision === 'modify' ? 'Modified' : 'Approved'}{svc.reviewedBy ? ` · ${svc.reviewedBy}` : ''}</div>
                    {svc.reviewNotes && <p className="text-[13px] text-gray-700 mt-1 whitespace-pre-line">{svc.reviewNotes}</p>}
                    {svc.reviewDecision === 'reject' && (
                      <p className="text-[13px] text-red-700 mt-1 font-semibold">Payment denied — vendor payout set to {money(svc.vendorCost)}.</p>
                    )}
                    {svc.reviewDecision === 'modify' && svc.vendorCostAdjustment != null && svc.vendorCostAdjustment !== 0 && (
                      <p className="text-[13px] text-emerald-700 mt-1 font-semibold">Payout adjusted by {money(Math.abs(svc.vendorCostAdjustment))} → vendor {money(svc.vendorCost)}.</p>
                    )}
                  </section>
                )}

                {canReview && (
                  <DecisionPanel kind="review" orig={{ vendor: origCost, markup: markupPct, client: origClient }} busy={deciding} error={error} onSubmit={submitReview} allowReissue={svcNotCompleted} />
                )}

                {!canReview && underReview && (
                  <div className="bg-amber-50 border border-amber-200 rounded-2xl p-3 text-[13px] text-amber-800">Under review by the ResiHome team.</div>
                )}
                {!editable && !underReview && svc.status === 'submitted' && (
                  <div className="bg-indigo-50 border border-indigo-200 rounded-2xl p-3 text-[13px] text-indigo-800">Submitted — awaiting AI review. This service is locked and can no longer be edited.</div>
                )}
              </>
            )}
          </SectionCollapseCtx.Provider>
        )}
      </main>

      {lightbox && gallery.groups.length > 0 && (
        <PhotoLightbox
          groups={gallery.groups}
          photosByGroup={gallery.map}
          initialGroupId={lightbox.groupId}
          initialIndex={lightbox.index}
          readOnly
          onClose={() => setLightbox(null)}
          onDelete={() => { /* read-only */ }}
          onReplace={() => { /* read-only */ }}
        />
      )}

      {/* Audit Log modal (internal) — the service's history, newest first. */}
      {auditOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setAuditOpen(false)}>
          <div className="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
              <div className="font-heading font-bold text-[15px] text-ink">Audit Log</div>
              <button type="button" onClick={() => setAuditOpen(false)} aria-label="Close" className="text-gray-400 hover:text-ink text-lg leading-none">✕</button>
            </div>
            <div className="overflow-y-auto px-4 py-3">
              {auditEvents === null ? (
                <div className="text-[13px] text-gray-400 py-6 text-center">Loading…</div>
              ) : auditEvents.length === 0 ? (
                <div className="text-[13px] text-gray-400 py-6 text-center">No recorded activity yet.</div>
              ) : (
                <ol className="space-y-3">
                  {auditEvents.map((e, i) => (
                    <li key={i} className="flex gap-3">
                      <div className="w-1.5 h-1.5 rounded-full bg-brand mt-1.5 shrink-0" />
                      <div className="min-w-0">
                        <div className="text-[13px] font-heading font-bold text-ink">{auditLabel(e.action)}</div>
                        {e.detail && <div className="text-[12px] text-gray-600 whitespace-pre-line">{e.detail}</div>}
                        <div className="text-[11px] text-gray-400 mt-0.5">
                          {auditWhen(e.ts)}{(e.actorName || e.actorEmail) ? ` · ${e.actorName || e.actorEmail}` : ''}
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Reassign Vendor modal (internal). */}
      {reassignOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setReassignOpen(false)}>
          <div className="bg-white w-full sm:max-w-sm sm:rounded-2xl rounded-t-2xl p-4 flex flex-col max-h-[85vh]" onClick={(e) => e.stopPropagation()}>
            <div className="font-heading font-bold text-[15px] text-ink shrink-0">Reassign Vendor</div>
            <p className="text-[13px] text-gray-500 mt-1 shrink-0">Currently <b className="text-ink">{svc.vendor || 'Unassigned'}</b>. Choose the vendor to take over this service.</p>
            <div className="relative mt-3 shrink-0">
              <input type="text" value={reassignQuery} onChange={(e) => setReassignQuery(e.target.value)} placeholder="Search vendors…"
                className="w-full text-sm border border-gray-300 rounded-lg pl-3 pr-9 py-2.5 bg-white focus:outline-none focus:border-brand" />
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
            </div>
            {/* Bounded, scrollable list so a long vendor roster scrolls INSIDE the
                sheet instead of pushing the actions off-screen. */}
            <div className="mt-2 flex-1 min-h-0 overflow-y-auto space-y-1.5 pr-0.5">
              {vendorNames
                .filter((name) => !reassignQuery.trim() || name.toLowerCase().includes(reassignQuery.trim().toLowerCase()))
                .map((name) => (
                  <button key={name} type="button" onClick={() => setReassignVendor(name)}
                    className={`w-full text-left px-3 py-2.5 rounded-xl border text-sm font-heading font-semibold ${reassignVendor === name ? 'bg-brand/5 border-brand text-brand' : 'bg-white border-gray-300 text-gray-700 hover:border-brand/50'}`}>
                    {name}{name === svc.vendor ? ' · current' : ''}
                  </button>
                ))}
              {vendorNames.filter((name) => !reassignQuery.trim() || name.toLowerCase().includes(reassignQuery.trim().toLowerCase())).length === 0 && (
                <div className="px-3 py-4 text-center text-[13px] text-gray-400">No vendors match “{reassignQuery.trim()}”.</div>
              )}
            </div>
            {settingsMsg && <div className="text-xs text-red-600 mt-2 shrink-0">{settingsMsg}</div>}
            <div className="flex gap-2 pt-3 shrink-0">
              <button type="button" onClick={() => setReassignOpen(false)} className="px-4 py-2.5 rounded-xl text-sm font-heading font-semibold bg-white text-gray-600 border border-gray-300">Cancel</button>
              <button type="button" disabled={reassigning || !reassignVendor || reassignVendor === svc.vendor} onClick={doReassign}
                className="flex-1 rounded-xl py-2.5 font-heading font-bold text-sm bg-brand text-white disabled:opacity-50">{reassigning ? '…' : 'Reassign'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Change Due Date modal (internal) — the calendar opens on the current due
          date; pick a new one and save to push it out. */}
      {dueOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setDueOpen(false)}>
          <div className="bg-white w-full max-w-sm rounded-2xl p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="font-heading font-bold text-[15px] text-ink">Change Due Date</div>
            <p className="text-[13px] text-gray-500 -mt-1">Currently due <b className="text-ink">{svc.dueDate ? fmtMDY(svc.dueDate) : '—'}</b>. Pick a new date to push it out.</p>
            <DatePicker value={newDue} onChange={setNewDue} className={`${inputCls} flex items-center justify-between`} ariaLabel="New due date" />
            <div>
              <label className="block text-[11px] font-heading font-semibold uppercase tracking-wide text-gray-400 mb-1">Reason <span className="normal-case font-normal text-gray-400">(logged to the audit trail)</span></label>
              <input type="text" value={dueReason} onChange={(e) => setDueReason(e.target.value)} placeholder="Why is this date changing?" className={inputCls} />
            </div>
            {settingsMsg && <div className="text-xs text-red-600">{settingsMsg}</div>}
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={() => { setDueOpen(false); setDueReason(''); }} className="px-4 py-2.5 rounded-xl text-sm font-heading font-semibold bg-white text-gray-600 border border-gray-300">Cancel</button>
              <button type="button" disabled={savingDue || !newDue || newDue === svc.dueDate} onClick={doChangeDue}
                className="flex-1 rounded-xl py-2.5 font-heading font-bold text-sm bg-brand text-white disabled:opacity-50">{savingDue ? '…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Audit event → human label + timestamp (M-D-YY h:mm AM).
function auditLabel(action: string): string {
  return ({
    submit: 'Submitted', ai_review: 'AI Review', review: 'Reviewed', bid: 'Bid Decision',
    reassign: 'Vendor Reassigned', cancel: 'Canceled', edit: 'Edited', create: 'Created',
  } as Record<string, string>)[action] || action;
}
function auditWhen(ts: string): string {
  const d = new Date(ts);
  if (isNaN(+d)) return ts;
  const h = d.getHours(); const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM'; const h12 = h % 12 || 12;
  return `${d.getMonth() + 1}-${d.getDate()}-${String(d.getFullYear()).slice(2)} ${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}
