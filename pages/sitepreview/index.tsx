/**
 * /sitepreview — ResiWalk marketing / product site (PREVIEW).
 *
 * A public, enterprise-grade landing page for review before promotion to the
 * main site. Self-contained Next page: sticky nav, video hero, platform feature
 * sections (inspections, real-world pricing & scoping, AI reviews + self-learning
 * knowledge base, scheduled services + vendor management + billing, rules engine,
 * insights dashboard), integrations, "built by veterans" band, metrics, contact
 * form (emails eric.williams@ + hwoods@ via /api/sitepreview/contact), footer.
 *
 * Brand: pink #ff0060 (brand), teal #73e3df (accent), ink dark. Not indexed while
 * it lives under /sitepreview.
 */
import { useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { SiteNav, SiteFooter, Reveal } from '@/components/sitepreview/Chrome';

// ---------- small inline icons (stroke, currentColor) ----------
type IconProps = { className?: string };
const I = {
  clipboard: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={p.className}><rect x="8" y="3" width="8" height="4" rx="1"/><path d="M9 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3"/><path d="M9 12l2 2 4-4"/></svg>,
  dollar: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>,
  spark: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M12 3l1.8 4.7L18.5 9l-4.7 1.3L12 15l-1.8-4.7L5.5 9l4.7-1.3L12 3z"/><path d="M19 15l.9 2.3L22 18l-2.1.7L19 21l-.9-2.3L16 18l2.1-.7L19 15z"/></svg>,
  calendar: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={p.className}><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/><path d="M8 14l3 3 5-5"/></svg>,
  wallet: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={p.className}><rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18M16 15h2"/></svg>,
  flow: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={p.className}><rect x="3" y="3" width="7" height="5" rx="1"/><rect x="14" y="16" width="7" height="5" rx="1"/><path d="M6.5 8v4a3 3 0 0 0 3 3h5"/></svg>,
  chart: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M4 20V4M4 20h16M8 16l3-4 3 3 5-7"/></svg>,
  camera: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/></svg>,
  brain: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M9 3a3 3 0 0 0-3 3 3 3 0 0 0-1 5.8A3 3 0 0 0 7 17a3 3 0 0 0 5 1 3 3 0 0 0 5-1 3 3 0 0 0 2-5.2A3 3 0 0 0 18 6a3 3 0 0 0-3-3 3 3 0 0 0-3 1.5A3 3 0 0 0 9 3z"/></svg>,
  check: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M20 6L9 17l-5-5"/></svg>,
  bolt: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></svg>,
  shield: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M12 3l8 3v5c0 5-3.4 8.5-8 10-4.6-1.5-8-5-8-10V6l8-3z"/><path d="M9 12l2 2 4-4"/></svg>,
};

const STATS = [
  { value: '2.6d → 0.1d', label: 'Scope-to-ticket turnaround' },
  { value: '6', label: 'Inspection templates, one platform' },
  { value: '100%', label: 'Field-priced against live rate cards' },
  { value: 'Real-time', label: 'Insights across every region' },
];

const FEATURES = [
  { id: 'inspections', icon: I.clipboard, tag: 'Inspections', title: 'A full suite of property inspections', body: 'Scope Rate Card, 1099 Leasing-Agent, Turn Re-Inspect QC, Vacancy/Occupancy, Community, and New-Construction RRQC — one app, offline-ready, photo-evidenced, GPS-stamped. Purpose-built for the field teams who actually walk the homes.', points: ['Works offline; syncs the moment signal returns', 'GPS + timestamp evidence on every photo', 'Configurable templates per program'] },
  { id: 'pricing', icon: I.dollar, tag: 'Pricing & Scoping', title: 'Real-world pricing and scoping, on site', body: 'Every line item priced against live regional rate cards — labor, materials, markup, and tenant bill-back computed instantly as the inspector scopes. No spreadsheets, no guesswork, no back-office re-pricing.', points: ['Region-aware labor & material rates', 'Instant vendor / client / tenant cost splits', 'Consistent, defensible pricing every time'] },
  { id: 'ai', icon: I.brain, tag: 'AI Reviews', title: 'AI reviews + a self-learning knowledge base', body: 'On-device camera and voice AI suggest the right line items and catch issues in the moment, while a self-learning knowledge base absorbs every human override to get sharper over time — your standards, encoded and always improving.', points: ['Photo & voice AI line-item capture', 'Learns from every reviewer override', 'Your playbook, enforced automatically'] },
  { id: 'services', icon: I.calendar, tag: 'Services & Vendors', title: 'Scheduled services, vendor management & billing', body: 'Bring recurring services in-house — grass, cleans, pools — with a scheduling engine, vendor dispatch, field evidence, and clean vendor & client billing end to end. Replace the middlemen without losing the controls.', points: ['Recurring scheduling & vendor rotation', 'Field-evidenced completion', 'Vendor + client invoicing built in'] },
  { id: 'rules', icon: I.flow, tag: 'Rules Engine', title: 'An integrated rules engine', body: 'Codify the way your business actually runs: approval routing by dollar and region, auto-dispatch on failed findings, escalation ladders, and service triggers — all configurable, all auditable, no code.', points: ['NTE-based approval routing', 'Condition-driven automations', 'Fully auditable decisions'] },
  { id: 'insights', icon: I.chart, tag: 'Insights', title: 'A full-service insights dashboard', body: 'Live analytics across inspections, pass/fail trends, scope cost, inspector performance, AI overrides, and service throughput — banked daily and sliced by region, program, and person. The command center for the whole operation.', points: ['Region, program & inspector breakdowns', 'Trend history banked automatically', 'Exec-ready, real-time'] },
];

const INTEGRATIONS = [
  { name: 'HubSpot', desc: 'CRM system of record — properties, listings, tickets & workflows.' },
  { name: 'Google Drive', desc: 'Documents, reports & evidence, synced where your teams work.' },
  { name: 'Google Calendar', desc: 'Scheduling and dispatch that lands on the right calendars.' },
  { name: 'Slack', desc: 'Real-time approvals, dispatch alerts & a conversational assistant.' },
  { name: 'RentCast', desc: 'Live market comps to inform listing & scoping decisions.' },
  { name: 'Maintenance Systems', desc: 'Ticketing & work-order sync into your existing MM stack.' },
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
        <section className="relative pt-28 pb-20 lg:pt-36 lg:pb-28 overflow-hidden">
          <div aria-hidden className="absolute inset-0 -z-10">
            <div className="absolute -top-40 -right-40 w-[46rem] h-[46rem] rounded-full bg-brand/15 blur-3xl" />
            <div className="absolute top-40 -left-40 w-[38rem] h-[38rem] rounded-full bg-accent/20 blur-3xl" />
          </div>
          <div className="max-w-7xl mx-auto px-5 lg:px-8 grid lg:grid-cols-[1.05fr_1fr] gap-12 items-center">
            <div>
              <Reveal>
                <span className="inline-flex items-center gap-2 rounded-full bg-brand/10 text-brand px-3.5 py-1.5 text-xs font-heading font-bold tracking-wide uppercase">
                  <I.bolt className="w-3.5 h-3.5" /> Built for SFR &amp; BTR at scale
                </span>
              </Reveal>
              <Reveal delay={60}>
                <h1 className="mt-5 font-heading font-extrabold text-4xl sm:text-5xl lg:text-[3.4rem] leading-[1.05] text-ink">
                  The property operations platform that <span className="text-brand">walks with your team.</span>
                </h1>
              </Reveal>
              <Reveal delay={120}>
                <p className="mt-6 text-lg text-ink/70 leading-relaxed max-w-xl">
                  Inspections, real-world pricing &amp; scoping, AI reviews, scheduled services, vendor billing, a self-learning knowledge base, an integrated rules engine, and a live insights dashboard — one platform, built by industry veterans.
                </p>
              </Reveal>
              <Reveal delay={180}>
                <div className="mt-8 flex flex-wrap items-center gap-3">
                  <Link href="#contact" className="inline-flex items-center h-12 px-7 rounded-full bg-brand text-white font-heading font-bold hover:bg-brand-dark transition-colors shadow-lg shadow-brand/20">Book a demo</Link>
                  <Link href="/login" className="inline-flex items-center h-12 px-7 rounded-full border border-gray-300 text-ink font-heading font-bold hover:border-brand hover:text-brand transition-colors">Log in to the portal</Link>
                </div>
              </Reveal>
              <Reveal delay={240}>
                <div className="mt-8 flex items-center gap-6 text-sm text-ink/60">
                  <span className="inline-flex items-center gap-1.5"><I.shield className="w-4 h-4 text-accent-dark" /> Enterprise-grade</span>
                  <span className="inline-flex items-center gap-1.5"><I.check className="w-4 h-4 text-accent-dark" /> Offline-ready field app</span>
                </div>
              </Reveal>
            </div>
            <Reveal delay={160}>
              <div className="relative rounded-2xl overflow-hidden shadow-2xl ring-1 ring-black/5 bg-ink">
                <video
                  className="w-full h-auto block"
                  controls
                  playsInline
                  preload="metadata"
                  poster="/resiwalk-logo.svg"
                >
                  <source src="/sitepreview/resiwalk-intro.mp4" type="video/mp4" />
                </video>
              </div>
            </Reveal>
          </div>

          {/* stats strip */}
          <div className="max-w-7xl mx-auto px-5 lg:px-8 mt-16">
            <Reveal>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-px rounded-2xl overflow-hidden bg-gray-100 ring-1 ring-gray-100">
                {STATS.map((s) => (
                  <div key={s.label} className="bg-white p-6 text-center">
                    <div className="font-heading font-extrabold text-2xl lg:text-3xl text-brand">{s.value}</div>
                    <div className="mt-1 text-[13px] text-ink/60 leading-snug">{s.label}</div>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>
        </section>

        {/* ============ PLATFORM / FEATURES ============ */}
        <section id="platform" className="py-20 lg:py-28 bg-gray-50">
          <div className="max-w-7xl mx-auto px-5 lg:px-8">
            <Reveal>
              <div className="max-w-3xl">
                <span className="text-brand font-heading font-bold text-sm uppercase tracking-wide">The platform</span>
                <h2 className="mt-3 font-heading font-extrabold text-3xl lg:text-4xl text-ink leading-tight">Everything property operations needs — in one place</h2>
                <p className="mt-4 text-lg text-ink/70">From the first walk to the final invoice, ResiWalk replaces a stack of disconnected tools with a single, integrated system your teams actually enjoy using.</p>
              </div>
            </Reveal>

            <div className="mt-14 space-y-8">
              {FEATURES.map((f, i) => (
                <Reveal key={f.id} delay={(i % 2) * 80}>
                  <div id={f.id} className={`grid lg:grid-cols-2 gap-8 lg:gap-14 items-center rounded-3xl bg-white ring-1 ring-gray-100 shadow-sm p-7 lg:p-10 ${i % 2 ? 'lg:[&>*:first-child]:order-2' : ''}`}>
                    <div>
                      <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-brand/10 text-brand mb-4">
                        <f.icon className="w-6 h-6" />
                      </div>
                      <span className="text-xs font-heading font-bold uppercase tracking-wide text-accent-dark">{f.tag}</span>
                      <h3 className="mt-1.5 font-heading font-extrabold text-2xl lg:text-[1.7rem] text-ink leading-tight">{f.title}</h3>
                      <p className="mt-3 text-ink/70 leading-relaxed">{f.body}</p>
                      <ul className="mt-5 space-y-2.5">
                        {f.points.map((pt) => (
                          <li key={pt} className="flex items-start gap-2.5 text-[15px] text-ink/80">
                            <I.check className="w-5 h-5 text-brand shrink-0 mt-0.5" /> {pt}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <FeatureVisual id={f.id} />
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ============ INTEGRATIONS ============ */}
        <section id="integrations" className="py-20 lg:py-28">
          <div className="max-w-7xl mx-auto px-5 lg:px-8">
            <Reveal>
              <div className="text-center max-w-2xl mx-auto">
                <span className="text-brand font-heading font-bold text-sm uppercase tracking-wide">Integrations</span>
                <h2 className="mt-3 font-heading font-extrabold text-3xl lg:text-4xl text-ink">Plugs into the tools you already run</h2>
                <p className="mt-4 text-lg text-ink/70">ResiWalk is the connective tissue of your operation — syncing cleanly with your CRM, calendar, storage, and comms so data flows where it needs to, automatically.</p>
              </div>
            </Reveal>
            <div className="mt-12 grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {INTEGRATIONS.map((n, i) => (
                <Reveal key={n.name} delay={(i % 3) * 70}>
                  <div className="h-full rounded-2xl border border-gray-100 bg-white p-6 hover:shadow-lg hover:-translate-y-0.5 transition-all">
                    <div className="flex items-center gap-3">
                      <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-brand/15 to-accent/20 flex items-center justify-center font-heading font-extrabold text-brand">{n.name[0]}</div>
                      <h3 className="font-heading font-bold text-lg text-ink">{n.name}</h3>
                    </div>
                    <p className="mt-3 text-[15px] text-ink/65 leading-relaxed">{n.desc}</p>
                  </div>
                </Reveal>
              ))}
            </div>
            <Reveal>
              <p className="mt-8 text-center text-sm text-ink/50">…and an open, API-first foundation for the next integration on your roadmap.</p>
            </Reveal>
          </div>
        </section>

        {/* ============ INSIGHTS BAND ============ */}
        <section id="insights" className="py-20 lg:py-28 bg-ink text-white relative overflow-hidden">
          <div aria-hidden className="absolute inset-0 -z-0 opacity-30">
            <div className="absolute -bottom-40 -right-24 w-[40rem] h-[40rem] rounded-full bg-brand/40 blur-3xl" />
            <div className="absolute -top-32 -left-24 w-[32rem] h-[32rem] rounded-full bg-accent/30 blur-3xl" />
          </div>
          <div className="relative max-w-7xl mx-auto px-5 lg:px-8 grid lg:grid-cols-2 gap-12 items-center">
            <Reveal>
              <div>
                <span className="text-accent font-heading font-bold text-sm uppercase tracking-wide">Insights &amp; control</span>
                <h2 className="mt-3 font-heading font-extrabold text-3xl lg:text-4xl leading-tight">See the whole operation — in real time</h2>
                <p className="mt-4 text-lg text-white/70 leading-relaxed">Pass/fail trends, scope cost by region and category, inspector throughput, AI override rates, service completion — banked daily and always current. Decisions backed by the same verified data your field teams generate.</p>
                <div className="mt-7 flex flex-wrap gap-3">
                  <Link href="#contact" className="inline-flex items-center h-11 px-6 rounded-full bg-brand text-white font-heading font-bold hover:bg-brand-dark transition-colors">See it live</Link>
                  <Link href="/login" className="inline-flex items-center h-11 px-6 rounded-full border border-white/25 text-white font-heading font-bold hover:bg-white/10 transition-colors">Log in</Link>
                </div>
              </div>
            </Reveal>
            <Reveal delay={120}>
              <div className="rounded-2xl bg-white/5 ring-1 ring-white/10 p-6 backdrop-blur">
                <div className="grid grid-cols-2 gap-4">
                  {[['Pass rate', '96.4%', 'accent'], ['Avg scope', '$1,284', 'brand'], ['On-time services', '98%', 'accent'], ['AI acceptance', '91%', 'brand']].map(([l, v, c]) => (
                    <div key={l} className="rounded-xl bg-white/5 p-5">
                      <div className={`font-heading font-extrabold text-2xl ${c === 'brand' ? 'text-brand-light' : 'text-accent'}`}>{v}</div>
                      <div className="mt-1 text-xs text-white/60">{l}</div>
                    </div>
                  ))}
                </div>
                <div className="mt-4 rounded-xl bg-white/5 p-5">
                  <div className="flex items-end gap-1.5 h-24">
                    {[38, 52, 45, 63, 58, 72, 68, 80, 76, 88, 84, 95].map((h, idx) => (
                      <div key={idx} className="flex-1 rounded-t bg-gradient-to-t from-brand to-accent" style={{ height: `${h}%` }} />
                    ))}
                  </div>
                  <div className="mt-2 text-xs text-white/50">Completed inspections, trailing 12 periods</div>
                </div>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ============ VETERANS BAND ============ */}
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
                  <li className="flex items-center gap-2.5"><I.check className="w-5 h-5 text-brand" /> A tailored walkthrough of the platform</li>
                  <li className="flex items-center gap-2.5"><I.check className="w-5 h-5 text-brand" /> Real pricing &amp; scoping on your regions</li>
                  <li className="flex items-center gap-2.5"><I.check className="w-5 h-5 text-brand" /> A migration path from your current tools</li>
                </ul>
                <p className="mt-8 text-sm text-ink/50">Prefer email? <a href="mailto:eric.williams@resihome.com" className="text-brand font-semibold underline">eric.williams@resihome.com</a></p>
              </div>
            </Reveal>
            <Reveal delay={120}>
              <ContactForm />
            </Reveal>
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

/** Lightweight, brand-styled visual per feature (no external images). */
function FeatureVisual({ id }: { id: string }) {
  if (id === 'pricing') {
    return (
      <div className="rounded-2xl bg-gradient-to-br from-gray-50 to-white ring-1 ring-gray-100 p-6">
        {[['Replace carpet & pad — LR', '$842.00'], ['Repair mailbox post', '$118.50'], ['Interior paint — whole home', '$1,960.00']].map(([k, v]) => (
          <div key={k} className="flex items-center justify-between py-3 border-b border-gray-100 last:border-0">
            <span className="text-sm text-ink/70">{k}</span>
            <span className="font-heading font-bold text-ink">{v}</span>
          </div>
        ))}
        <div className="mt-3 flex items-center justify-between rounded-xl bg-brand/10 px-4 py-3">
          <span className="font-heading font-bold text-brand">Client total</span>
          <span className="font-heading font-extrabold text-brand">$2,920.50</span>
        </div>
      </div>
    );
  }
  if (id === 'ai') {
    return (
      <div className="rounded-2xl bg-ink text-white p-6">
        <div className="flex items-center gap-2 text-accent"><I.camera className="w-5 h-5" /><span className="text-sm font-heading font-semibold">AI camera review</span></div>
        <div className="mt-4 space-y-2.5">
          {['Detected: water stain — ceiling', 'Suggested: drywall repair + paint', 'Confidence 0.94 · confirm to add'].map((t, i) => (
            <div key={t} className={`rounded-lg px-4 py-3 text-sm ${i === 2 ? 'bg-brand/20 text-brand-light' : 'bg-white/5 text-white/80'}`}>{t}</div>
          ))}
        </div>
        <div className="mt-4 text-xs text-white/50">Every override teaches the knowledge base.</div>
      </div>
    );
  }
  if (id === 'services') {
    return (
      <div className="rounded-2xl bg-gradient-to-br from-gray-50 to-white ring-1 ring-gray-100 p-6">
        {[['Grass cut — biweekly', 'Vendor assigned', 'accent'], ['Pool service — weekly', 'Scheduled', 'brand'], ['Turn clean', 'Invoiced', 'accent']].map(([k, s, c]) => (
          <div key={k} className="flex items-center justify-between py-3 border-b border-gray-100 last:border-0">
            <span className="text-sm text-ink/75">{k}</span>
            <span className={`text-xs font-heading font-bold px-2.5 py-1 rounded-full ${c === 'brand' ? 'bg-brand/10 text-brand' : 'bg-accent/20 text-accent-dark'}`}>{s}</span>
          </div>
        ))}
      </div>
    );
  }
  if (id === 'rules') {
    return (
      <div className="rounded-2xl bg-gradient-to-br from-gray-50 to-white ring-1 ring-gray-100 p-6 text-sm">
        <div className="font-heading font-bold text-ink mb-3">When a scope exceeds NTE →</div>
        <div className="space-y-2">
          <div className="rounded-lg bg-white ring-1 ring-gray-100 px-4 py-2.5">IF amount ≤ region NTE → tag PM + Sr. PM</div>
          <div className="rounded-lg bg-white ring-1 ring-gray-100 px-4 py-2.5">ELSE IF ≤ RM ceiling → tag RM</div>
          <div className="rounded-lg bg-brand/10 text-brand px-4 py-2.5 font-semibold">ELSE → escalate to directors</div>
        </div>
      </div>
    );
  }
  if (id === 'insights') {
    return (
      <div className="rounded-2xl bg-gradient-to-br from-gray-50 to-white ring-1 ring-gray-100 p-6">
        <div className="flex items-end gap-1.5 h-28">
          {[45, 60, 52, 70, 66, 82, 78, 90].map((h, idx) => (
            <div key={idx} className="flex-1 rounded-t bg-gradient-to-t from-brand to-accent" style={{ height: `${h}%` }} />
          ))}
        </div>
        <div className="mt-3 grid grid-cols-3 gap-3 text-center">
          {[['Pass', '96%'], ['On-time', '98%'], ['AI accept', '91%']].map(([l, v]) => (
            <div key={l} className="rounded-lg bg-white ring-1 ring-gray-100 py-2"><div className="font-heading font-extrabold text-brand">{v}</div><div className="text-[11px] text-ink/50">{l}</div></div>
          ))}
        </div>
      </div>
    );
  }
  // inspections (default)
  return (
    <div className="rounded-2xl bg-gradient-to-br from-gray-50 to-white ring-1 ring-gray-100 p-6">
      <div className="grid grid-cols-2 gap-3">
        {['Scope Rate Card', '1099 Leasing Agent', 'Turn Re-Inspect QC', 'Vacancy / Occupancy', 'Community / Visit', 'New-Construction RRQC'].map((t) => (
          <div key={t} className="rounded-xl bg-white ring-1 ring-gray-100 px-4 py-3 text-sm font-heading font-semibold text-ink/80 flex items-center gap-2">
            <I.clipboard className="w-4 h-4 text-brand shrink-0" /> {t}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Contact form → /api/sitepreview/contact (emails eric + hwoods). */
function ContactForm() {
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState('');

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus('sending'); setError('');
    const fd = new FormData(e.currentTarget);
    const body = Object.fromEntries(fd.entries());
    try {
      const r = await fetch('/api/sitepreview/contact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error || 'Something went wrong. Please try again.'); setStatus('error'); return; }
      setStatus('sent');
    } catch (err: any) {
      setError(String(err?.message || err)); setStatus('error');
    }
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
    <form onSubmit={onSubmit} className="rounded-2xl bg-white ring-1 ring-gray-100 shadow-sm p-6 lg:p-8 space-y-4">
      {/* honeypot */}
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
      <button type="submit" disabled={status === 'sending'} className="w-full h-12 rounded-full bg-brand text-white font-heading font-bold hover:bg-brand-dark transition-colors disabled:bg-gray-300">
        {status === 'sending' ? 'Sending…' : 'Send message'}
      </button>
      <p className="text-xs text-ink/45 text-center">We&apos;ll only use your details to respond to this inquiry.</p>
    </form>
  );
}
