/**
 * /sitepreview — ResiWalk marketing / product site (PREVIEW).
 *
 * Enterprise, product-led marketing page in the spirit of CompanyCam / HappyCo:
 * device-framed product screenshots (rendered in CSS/SVG), real ResiHome data
 * points, categorized integrations with brand logos, workflow, markets map,
 * testimonial, and a contact form that emails the ResiWalk team. Public + noindex
 * while it lives under /sitepreview. Brand: pink #ff0060, teal #73e3df.
 */
import { useState, useEffect, type ReactNode } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { SiteNav, SiteFooter, Reveal } from '@/components/sitepreview/Chrome';
import {
  BrowserFrame, PhoneFrame, InsightsScreen, RateCardScreen, ServicesScreen,
  InspectionPhone, AICameraCard, RulesFlow, MarketsMap,
} from '@/components/sitepreview/Mockups';
import { HubSpotMark, DriveMark, CalendarMark, SlackMark, GoogleMark, WordMark } from '@/components/sitepreview/Logos';

type IconProps = { className?: string };
const I = {
  clipboard: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={p.className}><rect x="8" y="3" width="8" height="4" rx="1"/><path d="M9 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3"/><path d="M9 12l2 2 4-4"/></svg>,
  dollar: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>,
  brain: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M9 3a3 3 0 0 0-3 3 3 3 0 0 0-1 5.8A3 3 0 0 0 7 17a3 3 0 0 0 5 1 3 3 0 0 0 5-1 3 3 0 0 0 2-5.2A3 3 0 0 0 18 6a3 3 0 0 0-3-3 3 3 0 0 0-3 1.5A3 3 0 0 0 9 3z"/></svg>,
  calendar: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={p.className}><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/></svg>,
  flow: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={p.className}><rect x="3" y="3" width="7" height="5" rx="1"/><rect x="14" y="16" width="7" height="5" rx="1"/><path d="M6.5 8v4a3 3 0 0 0 3 3h5"/></svg>,
  chart: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M4 20V4M4 20h16M8 16l3-4 3 3 5-7"/></svg>,
  check: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M20 6L9 17l-5-5"/></svg>,
  bolt: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></svg>,
  shield: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M12 3l8 3v5c0 5-3.4 8.5-8 10-4.6-1.5-8-5-8-10V6l8-3z"/><path d="M9 12l2 2 4-4"/></svg>,
  cloud: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.2 9.3 4 4 0 0 0 7 19z"/></svg>,
  play: (p: IconProps) => <svg viewBox="0 0 24 24" fill="currentColor" className={p.className}><path d="M8 5v14l11-7z"/></svg>,
};

const FEATURES = [
  { id: 'inspections', icon: I.clipboard, tag: 'Field Inspections', title: 'A full suite of inspections, offline-ready', body: 'Scope Rate Card, 1099 Leasing-Agent, Turn Re-Inspect QC, Vacancy/Occupancy, Community, and New-Construction RRQC — one app your field teams actually enjoy. Captures work offline in dead zones and syncs the instant signal returns, every photo GPS- and time-stamped.', points: ['Six configurable templates, one platform', 'Fully offline; auto-syncs on reconnect', 'GPS + timestamp evidence on every photo'], visual: <InspectionPhone />, visualWide: false },
  { id: 'pricing', icon: I.dollar, tag: 'Pricing & Scoping', title: 'Real-world pricing, computed on site', body: 'Every line item is priced against live regional rate cards as the inspector scopes — labor, materials, regional adjustments, markup, and tenant bill-back resolved instantly. No spreadsheets, no back-office re-pricing, and consistent, defensible numbers every time.', points: ['Region-aware labor & material rates', 'Instant vendor / client / tenant splits', 'One source of truth for cost'], visual: <RateCardScreen />, visualWide: true },
  { id: 'ai', icon: I.brain, tag: 'AI Reviews', title: 'AI reviews + a self-learning knowledge base', body: 'On-device camera and voice AI suggest the right line items and catch issues in the moment, while a knowledge base absorbs every human override to get sharper over time — your standards, encoded and always improving.', points: ['Photo & voice AI line-item capture', 'Learns from every reviewer override', 'Your playbook, enforced automatically'], visual: <AICameraCard />, visualWide: false },
  { id: 'services', icon: I.calendar, tag: 'Services & Vendors', title: 'Scheduled services, vendors & billing', body: 'Bring recurring services in-house — grass, cleans, pools — with a scheduling engine, vendor dispatch and rotation, field-evidenced completion, and clean vendor & client billing end to end. Replace the middlemen without losing the controls.', points: ['Recurring scheduling & vendor rotation', 'Field-evidenced completion', 'Vendor + client invoicing built in'], visual: <ServicesScreen />, visualWide: true },
  { id: 'rules', icon: I.flow, tag: 'Rules Engine', title: 'An integrated, no-code rules engine', body: 'Codify how your business actually runs: NTE-based approval routing by dollar and region, condition-driven automations, escalation ladders, and service triggers — all configurable and fully auditable.', points: ['NTE-based approval routing', 'Condition-driven automations', 'Every decision auditable'], visual: <RulesFlow />, visualWide: false },
  { id: 'insights', icon: I.chart, tag: 'Insights', title: 'A full-service insights command center', body: 'Live analytics across inspections, pass/fail trends, scope cost, inspector performance, AI acceptance, and service throughput — banked daily and sliced by region, program, and person. Exec-ready and always current.', points: ['Region, program & inspector breakdowns', 'Trend history banked automatically', 'Real-time, decision-ready'], visual: <InsightsScreen />, visualWide: true },
];

const INTEGRATIONS: { name: string; category: string; desc: string; logo: ReactNode }[] = [
  { name: 'HubSpot', category: 'CRM', desc: 'Properties, listings, tickets & workflows — your system of record.', logo: <HubSpotMark className="w-8 h-8" /> },
  { name: 'Google Drive', category: 'Storage', desc: 'Reports, evidence & documents synced where your teams work.', logo: <DriveMark className="w-8 h-8" /> },
  { name: 'Google Calendar', category: 'Scheduling', desc: 'Service scheduling & dispatch on the right calendars.', logo: <CalendarMark className="w-8 h-8" /> },
  { name: 'Google Workspace', category: 'Identity / SSO', desc: 'Single sign-on and identity for your staff.', logo: <GoogleMark className="w-8 h-8" /> },
  { name: 'Slack', category: 'Communication', desc: 'Approvals, dispatch alerts & a conversational assistant.', logo: <SlackMark className="w-8 h-8" /> },
  { name: 'RentCast', category: 'Market Data', desc: 'Live market comps to inform listing & scoping.', logo: <span className="w-8 h-8 rounded-lg bg-[#0f172a] flex items-center justify-center text-[11px] text-white font-extrabold">RC</span> },
  { name: 'Maintenance / MM', category: 'Work Orders', desc: 'Two-way work-order & ticket sync with your MM stack.', logo: <span className="w-8 h-8 rounded-lg bg-[#ff0060]/10 flex items-center justify-center"><I.cloud className="w-5 h-5 text-[#ff0060]" /></span> },
];

const PLANS: { name: string; who: string; featured?: boolean; points: string[] }[] = [
  { name: 'Growth', who: 'Emerging portfolios getting field ops under control.', points: ['Core inspection templates', 'Real-world rate-card pricing', 'Offline field app + evidence', 'Standard integrations', 'Email support'] },
  { name: 'Professional', who: 'Scaling operators standardizing across markets.', featured: true, points: ['Everything in Growth', 'AI reviews + knowledge base', 'Scheduled services & vendor billing', 'Rules engine + approval routing', 'Insights dashboard', 'Priority support'] },
  { name: 'Enterprise', who: 'National portfolios that need it all, governed.', points: ['Everything in Professional', 'SSO & role-based access', 'Custom templates & workflows', 'Dedicated success manager', 'SLA & onboarding services', 'API & custom integrations'] },
];

const SECURITY: { icon: (p: IconProps) => JSX.Element; title: string; body: string }[] = [
  { icon: I.shield, title: 'Role-based access & audit trails', body: 'Every action attributed and logged — who did what, and when.' },
  { icon: I.cloud, title: 'Your data, your system of record', body: 'Syncs to your HubSpot and Drive — you own it, always.' },
  { icon: I.bolt, title: 'SSO via Google Workspace', body: 'One identity for your staff; provision and revoke centrally.' },
  { icon: I.check, title: 'Evidence integrity', body: 'GPS- and time-stamped photos make findings defensible.' },
];

export default function SitePreview() {
  return (
    <>
      <Head>
        <title>ResiWalk — Property inspections, services & vendor management for SFR &amp; BTR</title>
        <meta name="description" content="ResiWalk is the full-suite property inspection, vendor management, and services platform — real-world pricing, AI reviews, scheduled services, vendor billing, a self-learning knowledge base, an integrated rules engine, and a live insights dashboard. Built by industry veterans for SFR & BTR." />
        <meta name="robots" content="noindex" />
        <meta property="og:title" content="ResiWalk — the property operations platform for SFR & BTR" />
        <meta property="og:description" content="Inspections, real-world pricing, AI reviews, scheduled services, vendor billing, rules engine, and insights — one platform." />
      </Head>

      <div className="min-h-screen bg-white text-ink font-body antialiased overflow-x-hidden">
        <SiteNav />
        <StickyDemoBar />

        {/* ============ HERO ============ */}
        <section className="relative pt-28 lg:pt-36 pb-16 lg:pb-24">
          <HeroBackground />
          <div className="relative max-w-7xl mx-auto px-5 lg:px-8 grid lg:grid-cols-[1fr_1.15fr] gap-14 lg:gap-10 items-center">
            <div>
              <Reveal>
                <span className="inline-flex items-center gap-2 rounded-full bg-white/70 backdrop-blur ring-1 ring-black/5 text-brand px-3.5 py-1.5 text-xs font-heading font-bold tracking-wide uppercase shadow-sm">
                  <I.bolt className="w-3.5 h-3.5" /> The property operations platform
                </span>
              </Reveal>
              <Reveal delay={60}>
                <h1 className="mt-5 font-heading font-extrabold text-4xl sm:text-5xl lg:text-[3.6rem] leading-[1.03] text-ink">
                  Every property walk,<br /><span className="bg-gradient-to-r from-brand to-brand-deeper bg-clip-text text-transparent">priced, dispatched &amp; measured.</span>
                </h1>
              </Reveal>
              <Reveal delay={120}>
                <p className="mt-6 text-lg text-ink/70 leading-relaxed max-w-xl">
                  ResiWalk unifies inspections, real-world pricing &amp; scoping, AI reviews, scheduled services, vendor billing, a self-learning knowledge base, a rules engine, and live insights — one platform, built by industry veterans for SFR &amp; BTR.
                </p>
              </Reveal>
              <Reveal delay={180}>
                <div className="mt-8 flex flex-wrap items-center gap-3">
                  <Link href="#contact" className="inline-flex items-center h-12 px-7 rounded-full bg-brand text-white font-heading font-bold hover:bg-brand-dark transition-colors shadow-lg shadow-brand/25">Book a demo</Link>
                  <Link href="#showcase" className="inline-flex items-center gap-2 h-12 px-6 rounded-full bg-white ring-1 ring-black/10 text-ink font-heading font-bold hover:ring-brand hover:text-brand transition-colors"><I.play className="w-4 h-4" /> Watch it work</Link>
                </div>
              </Reveal>
              <Reveal delay={240}>
                <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-ink/60">
                  <span className="inline-flex items-center gap-1.5"><I.check className="w-4 h-4 text-accent-dark" /> From first walk to final invoice</span>
                  <span className="inline-flex items-center gap-1.5"><I.check className="w-4 h-4 text-accent-dark" /> Priced on-site against live rate cards</span>
                </div>
              </Reveal>
            </div>

            {/* hero product composition — a large dashboard with the phone as a
                deliberate foreground accent (fills the column; phone reads as
                intentional, not shrunk). */}
            <Reveal delay={140}>
              <div className="relative pl-2 sm:pl-16 lg:pl-20 pb-10 sm:pb-4">
                <div className="drop-shadow-2xl"><InsightsScreen /></div>
                {/* phone overlapping front-left */}
                <div className="absolute -bottom-2 sm:bottom-2 -left-1 sm:left-0 z-20">
                  <InspectionPhone width={214} />
                </div>
                {/* floating AI chip */}
                <div className="hidden md:flex absolute top-8 -right-4 z-20 items-center gap-2 rounded-xl bg-white shadow-2xl ring-1 ring-black/5 px-3.5 py-2.5">
                  <span className="w-2 h-2 rounded-full bg-brand animate-pulse" />
                  <span className="text-[12px] font-heading font-semibold text-ink">AI: water stain → drywall + paint</span>
                </div>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ============ INSIGHTS TICKER ============ */}
        <section className="border-y border-gray-100 bg-white py-6">
          <p className="text-center text-xs font-heading font-bold uppercase tracking-widest text-ink/40 mb-5">Live across the platform</p>
          <InsightsMarquee />
        </section>

        {/* ============ SHOWCASE (video + one platform) ============ */}
        <section id="showcase" className="py-20 lg:py-28 bg-gray-50">
          <div className="max-w-7xl mx-auto px-5 lg:px-8">
            <Reveal>
              <div className="max-w-3xl mx-auto text-center">
                <span className="text-brand font-heading font-bold text-sm uppercase tracking-wide">One platform</span>
                <h2 className="mt-3 font-heading font-extrabold text-3xl lg:text-4xl text-ink leading-tight">Replace a stack of disconnected tools</h2>
                <p className="mt-4 text-lg text-ink/70">From the first walk to the final invoice, ResiWalk runs the entire property-operations lifecycle in one integrated system.</p>
              </div>
            </Reveal>
            <Reveal delay={100}>
              <div className="mt-12 max-w-4xl mx-auto rounded-2xl overflow-hidden shadow-2xl ring-1 ring-black/5 bg-black">
                <video className="w-full h-auto block bg-black" style={{ aspectRatio: '16 / 9', objectFit: 'contain' }} controls playsInline preload="metadata">
                  <source src="/sitepreview/resiwalk-intro.mp4" type="video/mp4" />
                </video>
              </div>
            </Reveal>
            <div className="mt-12 grid md:grid-cols-3 gap-5 items-stretch">
              {[
                { n: 'Inspect', d: 'Walk each home once. Every room photo-documented and GPS-stamped — online or off.', icon: I.clipboard },
                { n: 'Price & scope', d: 'Line items priced instantly against live regional rate cards. No spreadsheets, no delay.', icon: I.dollar },
                { n: 'Dispatch & measure', d: 'Auto-route approvals, invoice vendors, and watch it all land in real-time insights.', icon: I.chart },
              ].map((s, i) => (
                <Reveal key={s.n} delay={i * 80} className="h-full">
                  <div className="relative h-full rounded-2xl bg-white ring-1 ring-gray-100 p-6 flex flex-col">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-brand/10 text-brand flex items-center justify-center"><s.icon className="w-5 h-5" /></div>
                      <div className="w-7 h-7 rounded-full bg-brand text-white font-heading font-bold text-[13px] flex items-center justify-center">{i + 1}</div>
                    </div>
                    <h3 className="mt-4 font-heading font-bold text-lg text-ink">{s.n}</h3>
                    <p className="mt-1.5 text-[15px] text-ink/65 leading-relaxed">{s.d}</p>
                    {i < 2 && <div aria-hidden className="hidden md:flex absolute top-1/2 -right-3 z-10 w-6 h-6 rounded-full bg-white ring-1 ring-gray-100 items-center justify-center text-brand"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></div>}
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ============ FEATURES ============ */}
        <section id="platform" className="py-20 lg:py-28">
          <div className="max-w-7xl mx-auto px-5 lg:px-8 space-y-20 lg:space-y-28">
            {FEATURES.map((f, i) => (
              <Reveal key={f.id}>
                <div id={f.id} className={`grid lg:grid-cols-2 gap-10 lg:gap-16 items-center`}>
                  <div className={i % 2 ? 'lg:order-2' : ''}>
                    <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-brand/10 text-brand mb-4"><f.icon className="w-6 h-6" /></div>
                    <span className="text-xs font-heading font-bold uppercase tracking-wide text-accent-dark">{f.tag}</span>
                    <h3 className="mt-1.5 font-heading font-extrabold text-2xl lg:text-[2rem] text-ink leading-tight">{f.title}</h3>
                    <p className="mt-4 text-ink/70 leading-relaxed text-[17px]">{f.body}</p>
                    <ul className="mt-6 space-y-3">
                      {f.points.map((pt) => (
                        <li key={pt} className="flex items-start gap-2.5 text-[15px] text-ink/80"><span className="mt-0.5 w-5 h-5 rounded-full bg-brand/10 text-brand flex items-center justify-center shrink-0"><I.check className="w-3.5 h-3.5" /></span> {pt}</li>
                      ))}
                    </ul>
                  </div>
                  <div className={`${i % 2 ? 'lg:order-1' : ''} flex justify-center`}>
                    <div className={f.visualWide ? 'w-full' : ''}>{f.visual}</div>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </section>

        {/* ============ INTEGRATIONS ============ */}
        <section id="integrations" className="py-20 lg:py-28 bg-gray-50">
          <div className="max-w-7xl mx-auto px-5 lg:px-8">
            <Reveal>
              <div className="text-center max-w-2xl mx-auto">
                <span className="text-brand font-heading font-bold text-sm uppercase tracking-wide">Integrations</span>
                <h2 className="mt-3 font-heading font-extrabold text-3xl lg:text-4xl text-ink">Connected to the tools you already run</h2>
                <p className="mt-4 text-lg text-ink/70">ResiWalk is the connective tissue of your operation — data flows cleanly across your CRM, storage, calendar, and comms, automatically.</p>
              </div>
            </Reveal>
            <div className="mt-12 grid sm:grid-cols-2 lg:grid-cols-3 gap-4 items-stretch">
              {INTEGRATIONS.map((it, i) => (
                <Reveal key={it.name} delay={(i % 3) * 60} className="h-full">
                  <div className="h-full flex flex-col rounded-2xl bg-white ring-1 ring-gray-100 p-6 hover:shadow-lg hover:-translate-y-0.5 transition-all">
                    <div className="flex items-center justify-between">
                      <div className="w-12 h-12 rounded-xl bg-gray-50 ring-1 ring-gray-100 flex items-center justify-center">{it.logo}</div>
                      <span className="text-[10px] font-heading font-bold uppercase tracking-wide text-ink/40 bg-gray-50 rounded-full px-2.5 py-1">{it.category}</span>
                    </div>
                    <h3 className="mt-4 font-heading font-bold text-lg text-ink">{it.name}</h3>
                    <p className="mt-1.5 text-[14px] text-ink/60 leading-relaxed">{it.desc}</p>
                  </div>
                </Reveal>
              ))}
              <Reveal delay={60} className="h-full">
                <Link href="#contact" className="h-full flex flex-col items-center justify-center text-center rounded-2xl border-2 border-dashed border-gray-200 p-6 hover:border-brand hover:text-brand transition-colors text-ink/50">
                  <span className="text-2xl font-heading font-extrabold">+</span>
                  <span className="mt-1 text-sm font-heading font-bold">API-first — build your own</span>
                  <span className="mt-1 text-[13px]">Tell us the next integration on your roadmap.</span>
                </Link>
              </Reveal>
            </div>
          </div>
        </section>

        {/* ============ MARKETS + INSIGHTS BAND ============ */}
        <section id="insights" className="py-20 lg:py-28">
          <div className="max-w-7xl mx-auto px-5 lg:px-8 grid lg:grid-cols-2 gap-10 lg:gap-16 items-center">
            <Reveal><MarketsMap /></Reveal>
            <Reveal delay={100}>
              <div>
                <span className="text-brand font-heading font-bold text-sm uppercase tracking-wide">Built for scale</span>
                <h2 className="mt-3 font-heading font-extrabold text-3xl lg:text-4xl text-ink leading-tight">One command center, every region</h2>
                <p className="mt-4 text-lg text-ink/70 leading-relaxed">Whether it&apos;s 600 doors or 60,000, ResiWalk keeps pricing consistent, dispatch fast, and leadership looking at the same verified numbers your field teams generate — across every market you operate.</p>
                <div className="mt-7 grid grid-cols-3 gap-3">
                  {[['2.6d → 0.1d', 'Scope-to-ticket'], ['98%', 'Services on-time'], ['91%', 'AI acceptance']].map((s) => (
                    <div key={s[1]} className="rounded-xl bg-gray-50 ring-1 ring-gray-100 p-4 text-center"><div className="font-heading font-extrabold text-xl text-brand">{s[0]}</div><div className="text-[11px] text-ink/50 mt-0.5">{s[1]}</div></div>
                  ))}
                </div>
                <div className="mt-7"><Link href="#contact" className="inline-flex items-center h-11 px-6 rounded-full bg-brand text-white font-heading font-bold hover:bg-brand-dark transition-colors">See your data live</Link></div>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ============ PRICING ============ */}
        <section id="pricing" className="py-20 lg:py-28 bg-gray-50">
          <div className="max-w-7xl mx-auto px-5 lg:px-8">
            <Reveal>
              <div className="text-center max-w-2xl mx-auto">
                <span className="text-brand font-heading font-bold text-sm uppercase tracking-wide">Pricing</span>
                <h2 className="mt-3 font-heading font-extrabold text-3xl lg:text-4xl text-ink">Pricing that scales with your portfolio</h2>
                <p className="mt-4 text-lg text-ink/70">Per-door, not per-seat — so your whole field team is in without a headcount penalty. Pick the tier that fits where you are today.</p>
              </div>
            </Reveal>
            <div className="mt-12 grid md:grid-cols-3 gap-6 items-stretch">
              {PLANS.map((p, i) => (
                <Reveal key={p.name} delay={i * 80} className="h-full">
                  <div className={`relative h-full flex flex-col rounded-3xl p-7 ${p.featured ? 'bg-ink text-white ring-2 ring-brand shadow-2xl lg:scale-[1.03]' : 'bg-white ring-1 ring-gray-100 shadow-sm'}`}>
                    {p.featured && <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-brand text-white text-[11px] font-heading font-bold px-3 py-1 rounded-full">Most popular</span>}
                    <h3 className={`font-heading font-extrabold text-xl ${p.featured ? 'text-white' : 'text-ink'}`}>{p.name}</h3>
                    <p className={`mt-1.5 text-[14px] leading-snug ${p.featured ? 'text-white/70' : 'text-ink/60'}`}>{p.who}</p>
                    <div className={`mt-5 pb-5 border-b ${p.featured ? 'border-white/15' : 'border-gray-100'}`}>
                      <span className={`font-heading font-extrabold text-3xl ${p.featured ? 'text-white' : 'text-ink'}`}>Custom</span>
                      <span className={`ml-1.5 text-sm ${p.featured ? 'text-white/50' : 'text-ink/45'}`}>/ per door</span>
                    </div>
                    <ul className="mt-5 space-y-3 flex-1">
                      {p.points.map((pt) => (
                        <li key={pt} className={`flex items-start gap-2.5 text-[14px] ${p.featured ? 'text-white/85' : 'text-ink/75'}`}>
                          <I.check className={`w-4 h-4 shrink-0 mt-0.5 ${p.featured ? 'text-accent' : 'text-brand'}`} /> {pt}
                        </li>
                      ))}
                    </ul>
                    <Link href="#contact" className={`mt-7 inline-flex items-center justify-center h-11 rounded-full font-heading font-bold transition-colors ${p.featured ? 'bg-brand text-white hover:bg-brand-dark' : 'bg-ink text-white hover:bg-gray-800'}`}>Book a demo</Link>
                  </div>
                </Reveal>
              ))}
            </div>
            <Reveal><p className="mt-8 text-center text-sm text-ink/45">Every plan includes unlimited photos, the offline field app, and evidence storage. Volume &amp; multi-brand pricing available.</p></Reveal>
          </div>
        </section>

        {/* ============ SECURITY / TRUST ============ */}
        <section className="py-20 lg:py-24 bg-white">
          <div className="max-w-7xl mx-auto px-5 lg:px-8">
            <Reveal>
              <div className="max-w-2xl">
                <span className="text-brand font-heading font-bold text-sm uppercase tracking-wide">Security &amp; governance</span>
                <h2 className="mt-3 font-heading font-extrabold text-3xl lg:text-4xl text-ink leading-tight">Built to enterprise standards</h2>
                <p className="mt-4 text-lg text-ink/70">The controls large operators require — access, attribution, data ownership, and integrity — baked in from day one.</p>
              </div>
            </Reveal>
            <div className="mt-10 grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
              {SECURITY.map((s, i) => (
                <Reveal key={s.title} delay={(i % 4) * 60} className="h-full">
                  <div className="h-full rounded-2xl bg-gray-50 ring-1 ring-gray-100 p-6">
                    <div className="w-11 h-11 rounded-xl bg-brand/10 text-brand flex items-center justify-center"><s.icon className="w-6 h-6" /></div>
                    <h3 className="mt-4 font-heading font-bold text-ink">{s.title}</h3>
                    <p className="mt-1.5 text-[14px] text-ink/60 leading-relaxed">{s.body}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ============ TESTIMONIAL ============ */}
        <section className="py-16 lg:py-20 bg-ink text-white relative overflow-hidden">
          <div aria-hidden className="absolute -top-24 -right-16 w-[30rem] h-[30rem] rounded-full bg-brand/30 blur-3xl" />
          <div className="relative max-w-4xl mx-auto px-5 lg:px-8 text-center">
            <Reveal>
              <div className="text-accent font-heading font-bold tracking-widest text-xs uppercase">Why teams switch</div>
              <blockquote className="mt-5 font-heading font-extrabold text-2xl lg:text-[2rem] leading-snug">
                &ldquo;We went from re-pricing scopes for days to dispatched, invoiced work the same afternoon — with the whole portfolio visible in one dashboard.&rdquo;
              </blockquote>
              <div className="mt-6 text-white/60 text-sm">Operations leadership · SFR &amp; BTR portfolio</div>
            </Reveal>
          </div>
        </section>

        {/* ============ VETERANS ============ */}
        <section className="relative pt-16 lg:pt-20 overflow-hidden">
          <div className="max-w-5xl mx-auto px-5 lg:px-8 text-center">
            <Reveal>
              <h2 className="font-heading font-extrabold text-2xl lg:text-3xl text-ink leading-snug">Designed, built, and managed by industry veterans —<br className="hidden sm:block" /> for the SFR &amp; BTR demands of today and tomorrow.</h2>
              <p className="mt-4 text-ink/60 text-lg max-w-2xl mx-auto">We&apos;ve run the portfolios, walked the homes, and chased the invoices. ResiWalk is the platform we always wished we had — now yours.</p>
            </Reveal>
          </div>
          <NeighborhoodBand />
        </section>

        {/* ============ CONTACT ============ */}
        <section id="contact" className="py-20 lg:py-28 bg-gray-50">
          <div className="max-w-6xl mx-auto px-5 lg:px-8 grid lg:grid-cols-[1fr_1.1fr] gap-12 items-start">
            <Reveal>
              <div>
                <span className="text-brand font-heading font-bold text-sm uppercase tracking-wide">Contact us</span>
                <h2 className="mt-3 font-heading font-extrabold text-3xl lg:text-4xl text-ink leading-tight">Let&apos;s walk your portfolio forward</h2>
                <p className="mt-4 text-lg text-ink/70 leading-relaxed">Tell us about your operation and we&apos;ll show you exactly how ResiWalk fits — inspections, pricing, services, and the analytics tying it all together.</p>
                <ul className="mt-6 space-y-3 text-[15px] text-ink/80">
                  {['A tailored walkthrough of the platform', 'Real pricing & scoping on your regions', 'A migration path from your current tools'].map((t) => (
                    <li key={t} className="flex items-center gap-2.5"><span className="w-5 h-5 rounded-full bg-brand/10 text-brand flex items-center justify-center"><I.check className="w-3.5 h-3.5" /></span> {t}</li>
                  ))}
                </ul>
              </div>
            </Reveal>
            <Reveal delay={120}><ContactForm /></Reveal>
          </div>
        </section>

        {/* ============ FINAL CTA ============ */}
        <section className="bg-gradient-to-br from-brand to-brand-deeper text-white">
          <div className="max-w-5xl mx-auto px-5 lg:px-8 py-16 lg:py-20 text-center">
            <Reveal>
              <h2 className="font-heading font-extrabold text-3xl lg:text-4xl">Ready to see ResiWalk in action?</h2>
              <p className="mt-4 text-white/85 text-lg max-w-2xl mx-auto">Give your teams the platform that turns every property walk into priced, dispatched, and measured work — automatically.</p>
              <div className="mt-8 flex flex-wrap justify-center gap-3">
                <Link href="#contact" className="inline-flex items-center h-12 px-8 rounded-full bg-white text-brand font-heading font-bold hover:bg-white/90 transition-colors">Book a demo</Link>
                <Link href="/login" className="inline-flex items-center h-12 px-8 rounded-full border border-white/40 text-white font-heading font-bold hover:bg-white/10 transition-colors">Log in</Link>
              </div>
            </Reveal>
          </div>
        </section>

        <SiteFooter />
      </div>
    </>
  );
}

/** Compact, auto-scrolling ticker of live-feel platform insights. Pauses on hover. */
function InsightsMarquee() {
  const items: [string, string, boolean][] = [
    ['96.4%', 'Inspection pass rate', false],
    ['1,208', 'Inspections this month', true],
    ['$1,284', 'Average scope', false],
    ['98%', 'Services on-time', true],
    ['26×', 'Faster scope-to-ticket', false],
    ['91%', 'AI suggestions accepted', true],
    ['15', 'Markets live', false],
    ['6', 'Inspection & service types', true],
    ['2.6d → same-day', 'Turnaround', false],
    ['100%', 'Priced on-site', true],
  ];
  const row = [...items, ...items]; // duplicated for a seamless loop
  return (
    <div className="marquee-mask relative overflow-hidden">
      <div className="marquee-track flex w-max gap-3 px-3">
        {row.map(([v, l, teal], i) => (
          <div key={i} className="flex items-center gap-2.5 rounded-full bg-gray-50 ring-1 ring-gray-100 pl-3 pr-4 py-2 shrink-0">
            <span className={`w-1.5 h-1.5 rounded-full ${teal ? 'bg-accent' : 'bg-brand'}`} />
            <span className="font-heading font-extrabold text-ink text-[15px] leading-none">{v}</span>
            <span className="text-[12px] text-ink/50 leading-none whitespace-nowrap">{l}</span>
          </div>
        ))}
      </div>
      <style jsx>{`
        .marquee-track { animation: mq 46s linear infinite; }
        .marquee-mask:hover .marquee-track { animation-play-state: paused; }
        .marquee-mask { -webkit-mask-image: linear-gradient(to right, transparent, #000 6%, #000 94%, transparent); mask-image: linear-gradient(to right, transparent, #000 6%, #000 94%, transparent); }
        @keyframes mq { from { transform: translateX(0); } to { transform: translateX(-50%); } }
        @media (prefers-reduced-motion: reduce) { .marquee-track { animation: none; } }
      `}</style>
    </div>
  );
}

/** Slim, dismissible "Book a demo" bar that slides up after the hero scrolls by. */
function StickyDemoBar() {
  const [show, setShow] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > 700);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  if (dismissed) return null;
  return (
    <div className={`fixed inset-x-0 bottom-0 z-40 transition-transform duration-300 ${show ? 'translate-y-0' : 'translate-y-full'}`}>
      <div className="mx-auto max-w-3xl m-3 rounded-2xl bg-ink/95 backdrop-blur text-white shadow-2xl ring-1 ring-white/10 px-5 py-3.5 flex items-center gap-4">
        <span className="hidden sm:block text-sm text-white/85 font-heading font-semibold">See ResiWalk run on your portfolio.</span>
        <div className="flex-1" />
        <Link href="#contact" className="inline-flex items-center h-10 px-5 rounded-full bg-brand text-white font-heading font-bold text-sm hover:bg-brand-dark transition-colors">Book a demo</Link>
        <button type="button" onClick={() => setDismissed(true)} aria-label="Dismiss" className="text-white/50 hover:text-white w-8 h-8 flex items-center justify-center">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M6 18L18 6"/></svg>
        </button>
      </div>
    </div>
  );
}

/** Original stylized "neighborhood" illustration band (SFR + BTR homes). */
function NeighborhoodBand() {
  return (
    <div aria-hidden className="mt-10 w-full overflow-hidden leading-[0]">
      <svg viewBox="0 0 1200 180" className="w-full h-auto block" preserveAspectRatio="xMidYEnd meet">
        <defs>
          <linearGradient id="nb-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff5f9" /><stop offset="1" stopColor="#ffe1ec" /></linearGradient>
        </defs>
        <rect width="1200" height="180" fill="url(#nb-sky)" />
        {[0, 170, 340, 510, 680, 850, 1020].map((x, i) => {
          const roof = i % 2 ? '#ff0060' : '#cc004d';
          const body = i % 3 === 0 ? '#ffffff' : '#fff0f5';
          const h = 78 + (i % 3) * 14;
          const y = 180 - h;
          return (
            <g key={x}>
              <rect x={x + 20} y={y} width="130" height={h} fill={body} stroke="#ffd0e0" strokeWidth="2" />
              <polygon points={`${x + 12},${y} ${x + 85},${y - 34} ${x + 158},${y}`} fill={roof} />
              <rect x={x + 40} y={y + 22} width="26" height="26" fill="#73e3df" opacity="0.7" />
              <rect x={x + 104} y={y + 22} width="26" height="26" fill="#73e3df" opacity="0.7" />
              <rect x={x + 70} y={y + h - 34} width="30" height="34" fill={roof} opacity="0.85" />
            </g>
          );
        })}
        <rect x="0" y="176" width="1200" height="4" fill="#ff0060" opacity="0.25" />
      </svg>
    </div>
  );
}

/** Layered mesh-gradient + dot-grid hero background. */
function HeroBackground() {
  return (
    <div aria-hidden className="absolute inset-0 -z-10 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-white via-white to-gray-50" />
      <div className="absolute -top-48 -right-40 w-[52rem] h-[52rem] rounded-full bg-brand/15 blur-3xl" />
      <div className="absolute top-24 -left-48 w-[42rem] h-[42rem] rounded-full bg-accent/25 blur-3xl" />
      <div className="absolute inset-0 opacity-[0.04]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, #0f172a 1px, transparent 0)', backgroundSize: '26px 26px' }} />
    </div>
  );
}

/** Contact form → /api/sitepreview/contact (emails the ResiWalk team). */
function ContactForm() {
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState('');
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus('sending'); setError('');
    const fd = new FormData(e.currentTarget);
    try {
      const r = await fetch('/api/sitepreview/contact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(fd.entries())) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error || 'Something went wrong. Please try again.'); setStatus('error'); return; }
      setStatus('sent');
    } catch (err: any) { setError(String(err?.message || err)); setStatus('error'); }
  }
  if (status === 'sent') {
    return (
      <div className="rounded-2xl bg-white ring-1 ring-gray-100 shadow-sm p-8 text-center">
        <div className="mx-auto w-14 h-14 rounded-full bg-brand/10 text-brand flex items-center justify-center"><I.check className="w-7 h-7" /></div>
        <h3 className="mt-4 font-heading font-extrabold text-xl text-ink">Thanks — we&apos;ll be in touch.</h3>
        <p className="mt-2 text-ink/60">Your message is on its way to the ResiWalk team. Expect a reply shortly.</p>
      </div>
    );
  }
  const input = 'w-full h-12 rounded-xl border border-gray-300 px-4 text-[15px] focus:border-brand focus:ring-2 focus:ring-brand/20 outline-none transition';
  return (
    <form onSubmit={onSubmit} className="rounded-2xl bg-white ring-1 ring-gray-100 shadow-lg p-6 lg:p-8 space-y-4">
      <input type="text" name="website" tabIndex={-1} autoComplete="off" className="hidden" aria-hidden />
      <div className="grid sm:grid-cols-2 gap-4">
        <div><label className="block text-sm font-heading font-semibold text-ink mb-1.5">Name*</label><input name="name" required className={input} placeholder="Jane Doe" /></div>
        <div><label className="block text-sm font-heading font-semibold text-ink mb-1.5">Company</label><input name="company" className={input} placeholder="Acme Residential" /></div>
      </div>
      <div className="grid sm:grid-cols-2 gap-4">
        <div><label className="block text-sm font-heading font-semibold text-ink mb-1.5">Email*</label><input name="email" type="email" required className={input} placeholder="jane@company.com" /></div>
        <div><label className="block text-sm font-heading font-semibold text-ink mb-1.5">Phone</label><input name="phone" className={input} placeholder="(555) 555-5555" /></div>
      </div>
      <div>
        <label className="block text-sm font-heading font-semibold text-ink mb-1.5">How can we help?*</label>
        <textarea name="message" required rows={4} className="w-full rounded-xl border border-gray-300 px-4 py-3 text-[15px] focus:border-brand focus:ring-2 focus:ring-brand/20 outline-none transition resize-y" placeholder="Tell us about your portfolio and what you're trying to solve…" />
      </div>
      {status === 'error' && <div className="text-sm text-brand font-semibold">{error}</div>}
      <button type="submit" disabled={status === 'sending'} className="w-full h-12 rounded-full bg-brand text-white font-heading font-bold hover:bg-brand-dark transition-colors disabled:bg-gray-300">{status === 'sending' ? 'Sending…' : 'Send message'}</button>
      <p className="text-xs text-ink/45 text-center">We&apos;ll only use your details to respond to this inquiry.</p>
    </form>
  );
}
