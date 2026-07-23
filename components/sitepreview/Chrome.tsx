/**
 * components/sitepreview/Chrome.tsx — shared nav + footer + scroll-reveal for the
 * ResiWalk marketing preview site (/sitepreview). Kept separate so the landing
 * and FAQ pages share one header/footer. Public marketing surface — no app state.
 */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

/** Fade-and-rise on scroll into view (IntersectionObserver). Respects reduced motion. */
export function Reveal({ children, delay = 0, className = '' }: { children: React.ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setSeen(true); return; }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { setSeen(true); io.disconnect(); }
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: seen ? 1 : 0,
        transform: seen ? 'none' : 'translateY(22px)',
        transition: `opacity .7s cubic-bezier(.2,.7,.2,1) ${delay}ms, transform .7s cubic-bezier(.2,.7,.2,1) ${delay}ms`,
        willChange: 'opacity, transform',
      }}
    >
      {children}
    </div>
  );
}

const NAV = [
  { label: 'Platform', href: '/#platform' },
  { label: 'Integrations', href: '/#integrations' },
  { label: 'Pricing', href: '/#pricing' },
  { label: 'Insights', href: '/#insights' },
  { label: 'FAQ', href: '/faq' },
];

export function SiteNav() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return (
    <header className={`fixed inset-x-0 top-0 z-50 transition-all duration-300 ${scrolled ? 'bg-white/90 backdrop-blur-md shadow-[0_1px_0_rgba(0,0,0,0.06)]' : 'bg-transparent'}`}>
      <nav className="max-w-7xl mx-auto px-5 lg:px-8 h-16 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2 shrink-0" aria-label="ResiWalk home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/resiwalk-logo.svg" alt="ResiWalk" className="h-9 w-auto" />
        </Link>
        <div className="hidden md:flex items-center gap-8">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="text-[15px] font-heading font-semibold text-ink/80 hover:text-brand transition-colors">{n.label}</Link>
          ))}
        </div>
        <div className="hidden md:flex items-center gap-3">
          <Link href="/login" className="text-[15px] font-heading font-semibold text-ink/80 hover:text-brand transition-colors">Log in</Link>
          <Link href="/#contact" className="inline-flex items-center h-10 px-5 rounded-full bg-brand text-white font-heading font-bold text-sm hover:bg-brand-dark transition-colors shadow-sm">Book a demo</Link>
        </div>
        <button type="button" onClick={() => setOpen((o) => !o)} className="md:hidden inline-flex items-center justify-center w-10 h-10 rounded-lg text-ink" aria-label="Menu" aria-expanded={open}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d={open ? 'M6 6l12 12M6 18L18 6' : 'M4 7h16M4 12h16M4 17h16'} /></svg>
        </button>
      </nav>
      {open && (
        <div className="md:hidden bg-white border-t border-gray-100 px-5 py-4 space-y-1 shadow-lg">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} onClick={() => setOpen(false)} className="block py-2.5 text-[15px] font-heading font-semibold text-ink">{n.label}</Link>
          ))}
          <div className="pt-3 flex items-center gap-3">
            <Link href="/login" className="flex-1 text-center h-11 leading-[44px] rounded-full border border-gray-300 font-heading font-bold text-sm text-ink">Log in</Link>
            <Link href="/#contact" onClick={() => setOpen(false)} className="flex-1 text-center h-11 leading-[44px] rounded-full bg-brand text-white font-heading font-bold text-sm">Book a demo</Link>
          </div>
        </div>
      )}
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="bg-ink text-white/70">
      <div className="max-w-7xl mx-auto px-5 lg:px-8 py-14 grid gap-10 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/resiwalk-logo.svg" alt="ResiWalk" className="h-8 w-auto brightness-0 invert" />
          <p className="mt-4 text-sm leading-relaxed max-w-xs">The full-suite property inspection, vendor management, and services platform — built by industry veterans for the SFR &amp; BTR demands of today and tomorrow.</p>
        </div>
        <FooterCol title="Platform" links={[['Inspections', '/#platform'], ['Pricing & Scoping', '/#pricing'], ['AI Reviews', '/#ai'], ['Services & Vendors', '/#services'], ['Insights', '/#insights']]} />
        <FooterCol title="Resources" links={[['FAQ', '/faq'], ['Integrations', '/#integrations'], ['Contact us', '/#contact']]} />
        <FooterCol title="Company" links={[['Log in', '/login'], ['Book a demo', '/#contact'], ['Built for SFR & BTR', '/#platform']]} />
      </div>
      <div className="border-t border-white/10">
        <div className="max-w-7xl mx-auto px-5 lg:px-8 py-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs">
          <span>© {new Date().getFullYear()} ResiHome / ResiWalk. All rights reserved.</span>
          <span className="text-white/40">Enterprise property operations, reimagined.</span>
        </div>
      </div>
    </footer>
  );
}

function FooterCol({ title, links }: { title: string; links: [string, string][] }) {
  return (
    <div>
      <h4 className="text-white font-heading font-bold text-sm mb-3">{title}</h4>
      <ul className="space-y-2.5">
        {links.map(([label, href]) => (
          <li key={label}>
            <Link href={href} className="text-sm hover:text-white transition-colors break-words">{label}</Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
