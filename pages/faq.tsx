/**
 * /faq — public FAQ (Resources) for the ResiWalk marketing site.
 * Accordion of common questions across inspections, pricing, AI, services,
 * integrations, and security. Shares the site nav + footer.
 */
import { useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { SiteNav, SiteFooter, Reveal } from '@/components/sitepreview/Chrome';

const FAQS: { q: string; a: string }[] = [
  { q: 'What is ResiWalk?', a: 'ResiWalk is a full-suite property operations platform for single-family (SFR) and build-to-rent (BTR) portfolios. It unifies field inspections, real-world pricing and scoping, AI-assisted reviews, scheduled recurring services, vendor management and billing, an integrated rules engine, and a live insights dashboard — in one system.' },
  { q: 'Which inspection types are supported?', a: 'Any you need. ResiWalk ships with Estimate and QC inspection types out of the box, and a fully customizable form builder lets you create unlimited templates of your own — so inspections meet, and grow with, your business needs. Every template works fully offline in the field app; queued work syncs automatically when signal returns.' },
  { q: 'How does real-world pricing and scoping work?', a: 'Every line item is priced against live regional rate cards as the inspector scopes on site — labor, materials, regional adjustments, markup, and tenant bill-back are computed instantly. The result is consistent, defensible pricing with no back-office re-pricing, and clean vendor/client/tenant cost splits.' },
  { q: 'What do the AI reviews do — and what is the self-learning knowledge base?', a: 'On-device camera and voice AI suggest the correct rate-card line items and surface issues in the moment. Every time a human reviewer overrides a suggestion, the knowledge base learns — so the AI increasingly reflects your standards and gets sharper over time. You stay in control; the AI accelerates the work.' },
  { q: 'Can ResiWalk manage recurring services and vendors?', a: 'Yes. ResiWalk brings recurring services (grass, cleans, pools, and more) in-house with a scheduling engine, vendor dispatch and rotation, field-evidenced completion, and end-to-end vendor and client billing — replacing external middlemen without losing operational control.' },
  { q: 'What is the rules engine?', a: 'A no-code way to encode how your business runs: approval routing by dollar amount and region (NTE ceilings), condition-driven automations (for example, auto-dispatch on a failed grass or pool finding), escalation ladders, and service triggers. Every decision is configurable and auditable.' },
  { q: 'What does the insights dashboard show?', a: 'Live analytics across inspections, pass/fail trends, scope cost by region and category, inspector throughput, AI override rates, and service completion — banked daily and sliced by region, program, and person. It is the real-time command center for your operation.' },
  { q: 'What does ResiWalk integrate with?', a: 'HubSpot (CRM system of record for properties, listings, tickets, and workflows), Google Drive (documents and evidence), Google Calendar (scheduling and dispatch), Slack (approvals, dispatch alerts, and a conversational assistant), plus market-data and maintenance/ticketing systems. The platform is API-first for further integrations.' },
  { q: 'Does the field app work without a connection?', a: 'Yes — inspections are captured offline and sync the moment signal returns, so dead zones and weak cell coverage never stop a walk. Photos are GPS- and time-stamped as evidence.' },
  { q: 'How do we get started?', a: 'Book a demo from any page and our team will tailor a walkthrough to your regions and programs, show real pricing on your rate cards, and map a migration path from your current tools. Existing customers can log in to the portal directly.' },
];

export default function FaqPage() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <>
      <Head>
        <title>Property Inspection &amp; Management Software FAQ | ResiWalk</title>
        <meta name="description" content="Answers to common questions about ResiWalk property management software: field inspections, real-world pricing & scoping, AI reviews, recurring services, vendor billing, the rules engine, insights, integrations, and security." />
        <link rel="canonical" href="https://resiwalk.com/faq" />
        {/* FAQPage rich-result schema, generated from the FAQS array above so the
            markup and the schema can never drift apart. Inert data — CSP-safe. */}
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: FAQS.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
        }) }} />
      </Head>
      <div className="min-h-screen bg-white text-ink font-body antialiased">
        <SiteNav />
        <section className="pt-32 pb-16 lg:pt-40 relative overflow-hidden">
          <div aria-hidden className="absolute -top-40 right-0 w-[36rem] h-[36rem] rounded-full bg-accent/15 blur-3xl -z-10" />
          <div className="max-w-3xl mx-auto px-5 lg:px-8 text-center">
            <Reveal>
              <span className="text-brand font-heading font-bold text-sm uppercase tracking-wide">Resources</span>
              <h1 className="mt-3 font-heading font-extrabold text-4xl lg:text-5xl text-ink">Frequently asked questions</h1>
              <p className="mt-4 text-lg text-ink/70">Everything you need to know about the platform. Still curious? <Link href="/#contact" className="text-brand font-semibold underline">Talk to us</Link>.</p>
            </Reveal>
          </div>
        </section>

        <section className="pb-24">
          <div className="max-w-3xl mx-auto px-5 lg:px-8 space-y-3">
            {FAQS.map((f, i) => {
              const isOpen = open === i;
              return (
                <Reveal key={f.q} delay={(i % 4) * 40}>
                  <div className="rounded-2xl border border-gray-100 bg-white overflow-hidden">
                    <button type="button" onClick={() => setOpen(isOpen ? null : i)} aria-expanded={isOpen} className="w-full flex items-center justify-between gap-4 text-left px-5 lg:px-6 py-5 hover:bg-gray-50 transition-colors">
                      <span className="font-heading font-bold text-lg text-ink">{f.q}</span>
                      <svg className={`w-5 h-5 shrink-0 text-brand transition-transform ${isOpen ? 'rotate-45' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                    </button>
                    <div className="grid transition-all duration-300 ease-out" style={{ gridTemplateRows: isOpen ? '1fr' : '0fr' }}>
                      <div className="overflow-hidden">
                        <p className="px-5 lg:px-6 pb-5 text-ink/70 leading-relaxed">{f.a}</p>
                      </div>
                    </div>
                  </div>
                </Reveal>
              );
            })}
          </div>
        </section>

        <section className="bg-gradient-to-br from-brand to-brand-deeper text-white">
          <div className="max-w-4xl mx-auto px-5 lg:px-8 py-14 text-center">
            <h2 className="font-heading font-extrabold text-2xl lg:text-3xl">Didn&apos;t find your answer?</h2>
            <p className="mt-3 text-white/85">Our team is happy to dig into the specifics of your operation.</p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <Link href="/#contact" className="inline-flex items-center h-11 px-7 rounded-full bg-white text-brand font-heading font-bold hover:bg-white/90 transition-colors">Contact us</Link>
              <Link href="/login" className="inline-flex items-center h-11 px-7 rounded-full border border-white/40 text-white font-heading font-bold hover:bg-white/10 transition-colors">Log in</Link>
            </div>
          </div>
        </section>

        <SiteFooter />
      </div>
    </>
  );
}
