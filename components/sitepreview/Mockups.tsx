/**
 * components/sitepreview/Mockups.tsx — premium product "screenshots" rendered in
 * CSS/SVG (no external images) for the ResiWalk marketing site: browser/phone
 * device frames wrapping realistic app screens (inspection form, insights
 * dashboard, rate-card scoping, services scheduler, AI camera, rules engine) and
 * a Southeast markets map. Brand: pink #ff0060, teal #73e3df, ink.
 */
import React from 'react';

const PINK = '#ff0060';
const TEAL = '#73e3df';

/** macOS-style browser window. */
export function BrowserFrame({ url = 'app.resiwalk.com', children, className = '' }: { url?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl overflow-hidden bg-white ring-1 ring-black/5 shadow-2xl ${className}`}>
      <div className="flex items-center gap-2 px-4 h-10 bg-gray-100 border-b border-gray-200">
        <span className="w-3 h-3 rounded-full bg-[#ff5f57]" /><span className="w-3 h-3 rounded-full bg-[#febc2e]" /><span className="w-3 h-3 rounded-full bg-[#28c840]" />
        <div className="ml-3 flex-1 h-6 rounded-md bg-white border border-gray-200 flex items-center px-3 text-[11px] text-gray-400">{url}</div>
      </div>
      <div className="bg-[#f7f8fa]">{children}</div>
    </div>
  );
}

/** Phone frame with notch. */
export function PhoneFrame({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`relative w-[260px] rounded-[2.2rem] bg-ink p-2.5 shadow-2xl ring-1 ring-black/10 ${className}`}>
      <div className="absolute left-1/2 -translate-x-1/2 top-2.5 w-24 h-5 bg-ink rounded-b-2xl z-10" />
      <div className="rounded-[1.7rem] overflow-hidden bg-white">{children}</div>
    </div>
  );
}

function Bars({ data, className = '' }: { data: number[]; className?: string }) {
  return (
    <div className={`flex items-end gap-1.5 ${className}`}>
      {data.map((h, i) => (
        <div key={i} className="flex-1 rounded-t" style={{ height: `${h}%`, background: `linear-gradient(to top, ${PINK}, ${TEAL})` }} />
      ))}
    </div>
  );
}

/** Insights dashboard screen (in a browser frame). */
export function InsightsScreen() {
  return (
    <BrowserFrame url="app.resiwalk.com/insights">
      <div className="p-4 grid grid-cols-[64px_1fr] gap-3 text-ink">
        <div className="hidden sm:flex flex-col gap-3 pt-1">
          {['grid', 'chart', 'home', 'gear'].map((k, i) => (
            <div key={k} className={`w-9 h-9 rounded-lg flex items-center justify-center ${i === 1 ? 'bg-[#ff0060] text-white' : 'bg-gray-100 text-gray-400'}`}>
              <span className="w-4 h-4 rounded-sm border-2 border-current" />
            </div>
          ))}
        </div>
        <div className="min-w-0">
          <div className="flex items-center justify-between mb-3">
            <div className="font-heading font-extrabold text-sm">ResiWalk Insights</div>
            <div className="flex gap-1.5">{['GA', 'FL', 'NC'].map((r) => <span key={r} className="text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{r}</span>)}</div>
          </div>
          <div className="grid grid-cols-4 gap-2 mb-3">
            {[['Pass rate', '96.4%'], ['Avg scope', '$1,284'], ['Completed', '1,208'], ['On-time', '98%']].map(([l, v], i) => (
              <div key={l} className="rounded-lg bg-white ring-1 ring-gray-100 p-2.5">
                <div className={`font-heading font-extrabold text-[15px] ${i % 2 ? 'text-[#0f172a]' : 'text-[#ff0060]'}`}>{v}</div>
                <div className="text-[9px] text-gray-400 leading-tight mt-0.5">{l}</div>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-[1.6fr_1fr] gap-3">
            <div className="rounded-lg bg-white ring-1 ring-gray-100 p-3">
              <div className="text-[10px] text-gray-400 mb-2">Completed inspections · trailing 12</div>
              <Bars data={[38, 52, 45, 63, 58, 72, 68, 80, 76, 88, 84, 95]} className="h-20" />
            </div>
            <div className="rounded-lg bg-white ring-1 ring-gray-100 p-3">
              <div className="text-[10px] text-gray-400 mb-2">Scope cost by category</div>
              {[['Paint', 72, PINK], ['Flooring', 54, TEAL], ['Clean', 40, PINK], ['Landscape', 28, TEAL]].map(([l, w, c]) => (
                <div key={l as string} className="mb-1.5">
                  <div className="flex justify-between text-[9px] text-gray-500"><span>{l}</span></div>
                  <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden"><div style={{ width: `${w}%`, background: c as string }} className="h-full rounded-full" /></div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </BrowserFrame>
  );
}

/** Real-world rate-card scoping panel (browser). */
export function RateCardScreen() {
  const lines: [string, string, string][] = [
    ['Replace carpet & pad — Living Room', '480 SF', '$842.00'],
    ['Interior paint — whole home', '2BR / 2BA', '$1,960.00'],
    ['Repair mailbox post', '1 EA', '$118.50'],
    ['Deep clean — turn', '1 EA', '$285.00'],
  ];
  return (
    <BrowserFrame url="app.resiwalk.com/scope">
      <div className="p-4 text-ink">
        <div className="flex items-center justify-between mb-3">
          <div className="font-heading font-extrabold text-sm">Scope Rate Card</div>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#73e3df]/25 text-[#0e7c77] font-semibold">Region: GA · Atlanta</span>
        </div>
        <div className="rounded-lg bg-white ring-1 ring-gray-100 overflow-hidden">
          {lines.map(([n, q, v], i) => (
            <div key={n} className={`flex items-center justify-between px-3 py-2.5 text-[12px] ${i ? 'border-t border-gray-100' : ''}`}>
              <span className="text-ink/80 truncate pr-2">{n}</span>
              <span className="flex items-center gap-3 shrink-0"><span className="text-[10px] text-gray-400">{q}</span><span className="font-heading font-bold">{v}</span></span>
            </div>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          {[['Vendor', '$2,671'], ['Client', '$3,205'], ['Tenant', '$1,120']].map(([l, v], i) => (
            <div key={l} className={`rounded-lg p-2.5 ${i === 1 ? 'bg-[#ff0060]/10' : 'bg-gray-50'}`}>
              <div className={`font-heading font-extrabold text-sm ${i === 1 ? 'text-[#ff0060]' : 'text-ink'}`}>{v}</div>
              <div className="text-[9px] text-gray-400">{l} total</div>
            </div>
          ))}
        </div>
      </div>
    </BrowserFrame>
  );
}

/** Services scheduler (browser). */
export function ServicesScreen() {
  const rows: [string, string, string, string][] = [
    ['Grass cut', 'Biweekly', 'GreenPro LLC', 'Scheduled'],
    ['Pool service', 'Weekly', 'AquaCare', 'Dispatched'],
    ['Turn clean', 'On turn', 'SparkleCo', 'Invoiced'],
    ['Gutter clean', 'Quarterly', 'PeakClean', 'Assigned'],
  ];
  const tone: Record<string, string> = { Scheduled: 'bg-[#73e3df]/25 text-[#0e7c77]', Dispatched: 'bg-[#ff0060]/10 text-[#ff0060]', Invoiced: 'bg-emerald-100 text-emerald-700', Assigned: 'bg-gray-100 text-gray-600' };
  return (
    <BrowserFrame url="app.resiwalk.com/services">
      <div className="p-4 text-ink">
        <div className="font-heading font-extrabold text-sm mb-3">Recurring Services</div>
        <div className="rounded-lg bg-white ring-1 ring-gray-100 overflow-hidden">
          {rows.map(([svc, cad, vendor, st], i) => (
            <div key={svc} className={`grid grid-cols-[1.2fr_.8fr_1fr_auto] items-center gap-2 px-3 py-2.5 text-[11px] ${i ? 'border-t border-gray-100' : ''}`}>
              <span className="font-semibold text-ink/85">{svc}</span>
              <span className="text-gray-400">{cad}</span>
              <span className="text-gray-500 truncate">{vendor}</span>
              <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full ${tone[st]}`}>{st}</span>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between rounded-lg bg-ink text-white px-3 py-2.5">
          <span className="text-[11px]">This month · 3,412 services</span>
          <span className="text-[11px] font-heading font-bold text-[#73e3df]">98% on-time</span>
        </div>
      </div>
    </BrowserFrame>
  );
}

/** Phone: inspection in progress with AI capture chip. */
export function InspectionPhone() {
  return (
    <PhoneFrame>
      <div className="text-ink">
        <div className="h-11 bg-[#ff0060] flex items-center justify-center text-white text-[12px] font-heading font-bold">Scope · 1408 Oak Hill Trl</div>
        <div className="p-3 space-y-2">
          <div className="rounded-lg bg-gray-50 ring-1 ring-gray-100 p-2.5">
            <div className="text-[10px] text-gray-400 mb-1">Living Room</div>
            <div className="text-[12px] font-semibold">Carpet — replace & pad</div>
            <div className="mt-1 flex items-center justify-between"><span className="text-[10px] text-gray-400">480 SF</span><span className="text-[12px] font-heading font-bold text-[#ff0060]">$842.00</span></div>
          </div>
          <div className="rounded-lg overflow-hidden ring-1 ring-gray-100">
            <div className="h-20 bg-gradient-to-br from-gray-200 to-gray-300 relative">
              <div className="absolute inset-x-2 bottom-2 rounded-md bg-black/70 text-white text-[9px] px-2 py-1 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-[#73e3df]" /> AI: water stain — suggest drywall + paint
              </div>
            </div>
          </div>
          <button className="w-full h-9 rounded-lg bg-ink text-white text-[11px] font-heading font-bold">Add line · confirm AI</button>
          <div className="flex items-center justify-between text-[9px] text-gray-400 px-0.5"><span>● GPS stamped</span><span>Synced</span></div>
        </div>
      </div>
    </PhoneFrame>
  );
}

/** AI camera overlay card (standalone). */
export function AICameraCard() {
  return (
    <div className="rounded-2xl overflow-hidden ring-1 ring-black/5 shadow-xl bg-ink">
      <div className="h-44 bg-gradient-to-br from-slate-700 to-slate-900 relative">
        <div className="absolute inset-4 border-2 border-dashed border-white/25 rounded-lg" />
        <div className="absolute left-4 right-4 bottom-4 rounded-lg bg-white/95 p-3">
          <div className="flex items-center gap-2 text-[11px] font-heading font-bold text-ink"><span className="w-2 h-2 rounded-full bg-[#ff0060]" /> Detected: ceiling water stain</div>
          <div className="mt-1 text-[11px] text-ink/60">Suggested: drywall repair + prime & paint · confidence 0.94</div>
          <div className="mt-2 flex gap-2"><span className="text-[10px] px-2 py-1 rounded bg-[#ff0060] text-white font-bold">Confirm</span><span className="text-[10px] px-2 py-1 rounded bg-gray-100 text-gray-500">Adjust</span></div>
        </div>
      </div>
    </div>
  );
}

/** Rules engine flow (standalone). */
export function RulesFlow() {
  return (
    <div className="rounded-2xl bg-white ring-1 ring-gray-100 shadow-xl p-5 text-[12px]">
      <div className="font-heading font-extrabold text-ink mb-3 text-sm">Approval routing · when scope &gt; NTE</div>
      <div className="space-y-2">
        <div className="rounded-lg bg-gray-50 ring-1 ring-gray-100 px-3 py-2.5 flex items-center justify-between"><span>≤ Region NTE</span><span className="text-[10px] font-bold text-[#0e7c77] bg-[#73e3df]/25 px-2 py-0.5 rounded-full">tag PM + Sr. PM</span></div>
        <div className="pl-4 text-gray-300">↓</div>
        <div className="rounded-lg bg-gray-50 ring-1 ring-gray-100 px-3 py-2.5 flex items-center justify-between"><span>≤ RM ceiling</span><span className="text-[10px] font-bold text-gray-600 bg-gray-100 px-2 py-0.5 rounded-full">tag RM</span></div>
        <div className="pl-4 text-gray-300">↓</div>
        <div className="rounded-lg bg-[#ff0060]/10 px-3 py-2.5 flex items-center justify-between"><span className="text-[#ff0060] font-semibold">Above ceiling</span><span className="text-[10px] font-bold text-white bg-[#ff0060] px-2 py-0.5 rounded-full">escalate → directors</span></div>
      </div>
    </div>
  );
}

/** Stylized Southeast markets map with pins. */
export function MarketsMap() {
  const pins = [
    { x: 30, y: 34, l: 'Atlanta' }, { x: 47, y: 26, l: 'Charlotte' }, { x: 40, y: 20, l: 'Greenville' },
    { x: 58, y: 42, l: 'Savannah' }, { x: 62, y: 62, l: 'Orlando' }, { x: 55, y: 70, l: 'Tampa' },
    { x: 20, y: 20, l: 'Huntsville' }, { x: 70, y: 78, l: 'Miami' },
  ];
  return (
    <div className="relative rounded-2xl bg-gradient-to-br from-ink to-[#1a1a24] ring-1 ring-white/10 shadow-2xl p-6 h-full min-h-[300px] overflow-hidden">
      <div aria-hidden className="absolute inset-0 opacity-[0.08]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, #fff 1px, transparent 0)', backgroundSize: '22px 22px' }} />
      <div className="relative text-white">
        <div className="text-[11px] uppercase tracking-widest text-[#73e3df] font-heading font-bold">Coverage</div>
        <div className="mt-1 font-heading font-extrabold text-xl">15 Southeast markets</div>
        <div className="relative mt-4 h-52">
          {pins.map((p) => (
            <div key={p.l} className="absolute -translate-x-1/2 -translate-y-1/2 group" style={{ left: `${p.x}%`, top: `${p.y}%` }}>
              <span className="block w-2.5 h-2.5 rounded-full bg-[#ff0060] shadow-[0_0_0_4px_rgba(255,0,96,0.25)]" />
              <span className="absolute left-4 top-1/2 -translate-y-1/2 whitespace-nowrap text-[10px] text-white/70">{p.l}</span>
            </div>
          ))}
          {/* faint connecting lines */}
          <svg className="absolute inset-0 w-full h-full" aria-hidden><line x1="30%" y1="34%" x2="47%" y2="26%" stroke={TEAL} strokeWidth="1" opacity="0.25" /><line x1="30%" y1="34%" x2="62%" y2="62%" stroke={TEAL} strokeWidth="1" opacity="0.25" /><line x1="62%" y1="62%" x2="55%" y2="70%" stroke={TEAL} strokeWidth="1" opacity="0.25" /></svg>
        </div>
      </div>
    </div>
  );
}
