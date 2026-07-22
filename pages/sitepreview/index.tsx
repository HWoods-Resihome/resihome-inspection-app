/**
 * /sitepreview — ResiWalk marketing / product site (PREVIEW).
 *
 * Enterprise, product-led marketing page in the spirit of CompanyCam / HappyCo:
 * device-framed product screenshots (rendered in CSS/SVG), real ResiHome data
 * points, categorized integrations with brand logos, workflow, markets map,
 * testimonial, and a contact form that emails the ResiWalk team. Public + noindex
 * while it lives under /sitepreview. Brand: pink #ff0060, teal #73e3df.
 */
import { useState, type ReactNode } from 'react';
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

const INTEGRATION_GROUPS: { category: string; items: { name: string; desc: string; logo: ReactNode }[] }[] = [
  { category: 'CRM & System of Record', items: [
    { name: 'HubSpot', desc: 'Properties, listings, tickets & workflows — the system of record.', logo: <HubSpotMark className="w-8 h-8" /> },
  ] },
  { category: 'Storage & Documents', items: [
    { name: 'Google Drive', desc: 'Reports, evidence & documents synced where teams work.', logo: <DriveMark className="w-8 h-8" /> },
  ] },
  { category: 'Scheduling', items: [
    { name: 'Google Calendar', desc: 'Scheduling & dispatch on the right calendars.', logo: <CalendarMark className="w-8 h-8" /> },
    { name: 'Google Workspace', desc: 'Single sign-on and identity for your staff.', logo: <GoogleMark className="w-8 h-8" /> },
  ] },
  { category: 'Communication', items: [
    { name: 'Slack', desc: 'Real-time approvals, dispatch alerts & a conversational assistant.', logo: <SlackMark className="w-8 h-8" /> },
  ] },
  { category: 'Market Data & Maintenance', items: [
    { name: 'RentCast', desc: 'Live market comps to inform listing & scoping.', logo: <span className="w-8 h-8 rounded-lg bg-[#0f172a] flex items-center justify-center text-[10px] text-white font-extrabold">RC</span> },
    { name: 'Maintenance / MM', desc: 'Two-way work-order & ticket sync with your MM stack.', logo: <span className="w-8 h-8 rounded-lg bg-[#ff0060]/10 flex items-center justify-center"><I.cloud className="w-5 h-5 text-[#ff0060]" /></span> },
  ] },
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

        {/* ============ HERO ============ */}
        <section className="relative pt-28 lg:pt-36 pb-16 lg:pb-24">
          <HeroBackground />
          <div className="relative max-w-7xl mx-auto px-5 lg:px-8 grid lg:grid-cols-[1.05fr_1fr] gap-14 items-center">
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
                  <span className="inline-flex items-center gap-1.5"><I.shield className="w-4 h-4 text-accent-dark" /> Enterprise-grade &amp; auditable</span>
                  <span className="inline-flex items-center gap-1.5"><I.check className="w-4 h-4 text-accent-dark" /> Offline-ready field app</span>
                </div>
              </Reveal>
            </div>

            {/* hero product composition */}
            <Reveal delay={140}>
              <div className="relative mx-auto max-w-md lg:max-w-none">
                <div className="hidden sm:block absolute -top-6 -left-6 w-56 z-20 rotate-[-4deg]">
                  <div className="rounded-xl bg-white shadow-2xl ring-1 ring-black/5 p-3">
                    <div className="text-[10px] text-gray-400">Rate-card total</div>
                    <div className="font-heading font-extrabold text-brand text-lg">$3,205.00</div>
                    <div className="mt-1 h-1.5 rounded-full bg-gray-100 overflow-hidden"><div className="h-full w-4/5 bg-gradient-to-r from-brand to-accent" /></div>
                  </div>
                </div>
                <div className="flex justify-center"><InspectionPhone /></div>
                <div className="hidden sm:block absolute -bottom-8 -right-4 w-64 z-20 rotate-[3deg]">
                  <div className="rounded-xl bg-ink text-white shadow-2xl ring-1 ring-white/10 p-3">
                    <div className="text-[10px] text-white/50 mb-1.5">Pass rate · this month</div>
                    <div className="flex items-end gap-1 h-10">{[40,55,48,66,60,74,88].map((h,i)=><div key={i} className="flex-1 rounded-t bg-gradient-to-t from-brand to-accent" style={{height:`${h}%`}} />)}</div>
                    <div className="mt-1 font-heading font-extrabold text-accent text-sm">96.4%</div>
                  </div>
                </div>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ============ STATS / TRUST ============ */}
        <section className="border-y border-gray-100 bg-white">
          <div className="max-w-7xl mx-auto px-5 lg:px-8 py-10">
            <Reveal>
              <p className="text-center text-xs font-heading font-bold uppercase tracking-widest text-ink/40">Proven across the Southeast SFR &amp; BTR landscape</p>
            </Reveal>
            <div className="mt-7 grid grid-cols-2 lg:grid-cols-4 gap-6 lg:gap-4">
              {[['6,000+', 'Homes under active management'], ['32,000+', 'Homes managed, all-time'], ['15', 'Markets across the Southeast'], ['4,200+', 'BTR homes delivered']].map((s, i) => (
                <Reveal key={s[1]} delay={i * 70}>
                  <div className="text-center">
                    <div className="font-heading font-extrabold text-3xl lg:text-4xl bg-gradient-to-br from-brand to-brand-deeper bg-clip-text text-transparent">{s[0]}</div>
                    <div className="mt-1 text-[13px] text-ink/60 leading-snug">{s[1]}</div>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
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
              <div className="mt-12 max-w-4xl mx-auto rounded-2xl overflow-hidden shadow-2xl ring-1 ring-black/5 bg-ink">
                <video className="w-full h-auto block" controls playsInline preload="metadata" poster="/resiwalk-logo.svg">
                  <source src="/sitepreview/resiwalk-intro.mp4" type="video/mp4" />
                </video>
              </div>
            </Reveal>
            <div className="mt-10 grid md:grid-cols-3 gap-5">
              {[['Inspect', 'Walk the home once — offline-ready, photo-evidenced.'], ['Price & scope', 'Live rate-card pricing computed on the spot.'], ['Dispatch & measure', 'Auto-route, invoice, and track it all in insights.']].map((s, i) => (
                <Reveal key={s[0]} delay={i * 80}>
                  <div className="rounded-2xl bg-white ring-1 ring-gray-100 p-6">
                    <div className="w-8 h-8 rounded-full bg-brand text-white font-heading font-bold text-sm flex items-center justify-center">{i + 1}</div>
                    <h3 className="mt-3 font-heading font-bold text-lg text-ink">{s[0]}</h3>
                    <p className="mt-1.5 text-[15px] text-ink/65">{s[1]}</p>
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
            <div className="mt-12 space-y-10">
              {INTEGRATION_GROUPS.map((g, gi) => (
                <Reveal key={g.category} delay={gi * 40}>
                  <div>
                    <div className="text-xs font-heading font-bold uppercase tracking-widest text-ink/40 mb-3">{g.category}</div>
                    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                      {g.items.map((it) => (
                        <div key={it.name} className="flex items-start gap-4 rounded-2xl bg-white ring-1 ring-gray-100 p-5 hover:shadow-lg hover:-translate-y-0.5 transition-all">
                          <div className="shrink-0 w-12 h-12 rounded-xl bg-gray-50 ring-1 ring-gray-100 flex items-center justify-center">{it.logo}</div>
                          <div><h3 className="font-heading font-bold text-ink">{it.name}</h3><p className="mt-1 text-[13.5px] text-ink/60 leading-snug">{it.desc}</p></div>
                        </div>
                      ))}
                    </div>
                  </div>
                </Reveal>
              ))}
            </div>
            <Reveal><p className="mt-8 text-center text-sm text-ink/45">…plus an API-first foundation for the next integration on your roadmap.</p></Reveal>
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
        <section className="py-16 lg:py-20">
          <div className="max-w-5xl mx-auto px-5 lg:px-8 text-center">
            <Reveal>
              <h2 className="font-heading font-extrabold text-2xl lg:text-3xl text-ink leading-snug">Designed, built, and managed by industry veterans —<br className="hidden sm:block" /> for the SFR &amp; BTR demands of today and tomorrow.</h2>
              <p className="mt-4 text-ink/60 text-lg max-w-2xl mx-auto">We&apos;ve run the portfolios, walked the homes, and chased the invoices. ResiWalk is the platform we always wished we had — now yours.</p>
            </Reveal>
          </div>
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
