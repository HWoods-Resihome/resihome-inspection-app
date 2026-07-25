/**
 * /preview — ALTERNATIVE marketing homepage under review (not yet live).
 *
 * A semantic, high-performance rebuild per the "elite HTML5 / conversion" brief:
 * strict HTML5 landmarks (header/nav/main/section/article/figure/footer) with
 * almost no generic containers, Grid/Flexbox applied to the semantic tags, custom
 * properties + clamp() fluid type, a dark-mode variable set (system + toggle),
 * ALL-CAPS value benchmarks for a 3-second scroll, a proof-of-concept metrics
 * matrix, three lightweight "live proof" scripts (status ticker, count-up, a
 * self-animating mini dashboard), and a two-step lead capture that closes on a
 * live availability indicator. Reuses the live brand assets (logo, intro video,
 * /api/sitepreview/contact) so promotion to / is a one-file swap.
 *
 * Public via middleware PUBLIC_PATHS; NOT indexed (noindex) while under review.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import Head from 'next/head';
import { HubSpotMark, DriveMark, CalendarMark, SlackMark, GoogleMark } from '@/components/sitepreview/Logos';

const CSS = `
:root{
  --pink:#FF0060;--pink-700:#D60052;--pink-050:#FFF0F5;--aqua:#73E3DF;--aqua-700:#0C8A83;
  --ink:#0A0B0D;--paper:#FFFFFF;--panel:#0E1116;--panel-2:#151A21;
  --bg:#FFFFFF;--bg-2:#F6F7F9;--bg-3:#EEF1F5;--fg:#0A0B0D;--fg-2:#5B6169;--fg-3:#868D98;
  --line:#E6E9EF;--line-2:#D9DDE6;--code:#0E1116;--code-fg:#E7FBFA;
  --f-display:'Oswald','Raleway',Arial,sans-serif;--f-body:'Raleway',Arial,sans-serif;
  --f-mono:ui-monospace,'SF Mono',Menlo,Consolas,monospace;
  --fs-h1:clamp(2.6rem,6vw,4.6rem);--fs-h2:clamp(2rem,4vw,3rem);--fs-h3:clamp(1.15rem,2vw,1.4rem);
  --fs-lead:clamp(1.05rem,1.5vw,1.25rem);--fs-mega:clamp(2.4rem,7vw,5rem);
  --wrap:1180px;--gutter:clamp(20px,4vw,44px);--sect:clamp(4rem,8vw,7rem);
  --r:12px;--r-lg:20px;--r-pill:999px;
  --sh:0 4px 14px rgba(14,17,22,.08),0 1px 3px rgba(14,17,22,.05);
  --sh-2:0 20px 50px rgba(14,17,22,.14),0 6px 14px rgba(14,17,22,.08);
}
/* Dark mode — system default, overridable by the [data-theme] toggle both ways. */
@media (prefers-color-scheme: dark){:root{
  --bg:#0A0B0D;--bg-2:#111318;--bg-3:#171A20;--fg:#F3F5F8;--fg-2:#A6ADB8;--fg-3:#6F7783;
  --line:#20242C;--line-2:#2A2F39;--paper:#111318;--code:#05070A;
}}
.sp[data-theme='dark']{
  --bg:#0A0B0D;--bg-2:#111318;--bg-3:#171A20;--fg:#F3F5F8;--fg-2:#A6ADB8;--fg-3:#6F7783;
  --line:#20242C;--line-2:#2A2F39;--paper:#111318;--code:#05070A;
}
.sp[data-theme='light']{
  --bg:#FFFFFF;--bg-2:#F6F7F9;--bg-3:#EEF1F5;--fg:#0A0B0D;--fg-2:#5B6169;--fg-3:#868D98;
  --line:#E6E9EF;--line-2:#D9DDE6;--paper:#FFFFFF;--code:#0E1116;
}
.sp,.sp *,.sp *::before,.sp *::after{box-sizing:border-box}
.sp{margin:0;font-family:var(--f-body);font-size:1rem;line-height:1.6;color:var(--fg);background:var(--bg);
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;overflow-x:hidden;transition:background .3s,color .3s}
.sp img,.sp svg,.sp video{display:block;max-width:100%}
.sp a{color:inherit;text-decoration:none}
.sp button{font-family:inherit;cursor:pointer}
.sp :focus-visible{outline:3px solid var(--pink);outline-offset:2px;border-radius:4px}
.sp [id]{scroll-margin-top:84px}
.wrap{width:100%;max-width:var(--wrap);margin-inline:auto;padding-inline:var(--gutter)}
main>section{padding-block:var(--sect)}
h1,h2,h3{font-family:var(--f-display);font-weight:700;line-height:1.04;letter-spacing:-.015em;margin:0}
.eyebrow{font-weight:800;font-size:.76rem;letter-spacing:.18em;text-transform:uppercase;color:var(--pink);
  display:inline-flex;align-items:center;gap:.55em;margin:0 0 1rem}
.eyebrow::before{content:"";width:26px;height:2px;background:var(--pink);display:inline-block}
.lead{font-size:var(--fs-lead);color:var(--fg-2);line-height:1.6;max-width:60ch;margin:0}
.mono{font-family:var(--f-mono)}
/* ── buttons ── */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:.5em;font-weight:700;font-size:1rem;
  padding:.85em 1.6em;border-radius:var(--r-pill);border:1.5px solid var(--pink);background:var(--pink);color:#fff;
  transition:transform .18s,box-shadow .2s,background .18s,border-color .18s,color .18s;white-space:nowrap}
.btn:hover{background:var(--pink-700);border-color:var(--pink-700);transform:translateY(-2px);box-shadow:0 16px 40px rgba(255,0,96,.28)}
.btn--ghost{background:transparent;color:var(--fg);border-color:var(--line-2)}
.btn--ghost:hover{background:var(--fg);border-color:var(--fg);color:var(--bg);box-shadow:var(--sh)}
.btn--lg{padding:1em 2em;font-size:1.06rem}
.btn__x{transition:transform .2s}.btn:hover .btn__x{transform:translateX(3px)}
/* ── masthead / nav ── */
.mast{position:fixed;inset:0 0 auto 0;z-index:60;transition:background .3s,box-shadow .3s,border-color .3s;
  background:transparent;border-bottom:1px solid transparent}
.mast.stuck{background:color-mix(in srgb,var(--bg) 82%,transparent);backdrop-filter:saturate(180%) blur(14px);
  -webkit-backdrop-filter:saturate(180%) blur(14px);border-bottom:1px solid var(--line);box-shadow:var(--sh)}
.mast nav{display:flex;align-items:center;gap:1.4rem;height:72px}
.mast .brand{display:flex;align-items:center;gap:.55rem}.mast .brand img{height:32px;width:auto}
/* Inverse (white) logo on the dark nav — matches the footer's inverse treatment. */
@media(prefers-color-scheme:dark){.mast .brand img{filter:brightness(0) invert(1)}}
.sp[data-theme='dark'] .mast .brand img{filter:brightness(0) invert(1)}
.sp[data-theme='light'] .mast .brand img{filter:none}
.mast nav menu{display:flex;align-items:center;gap:.2rem;margin:0 auto 0 1.2rem;padding:0;list-style:none}
.mast nav menu a{font-weight:600;font-size:.94rem;color:var(--fg);padding:.5em .8em;border-radius:8px;transition:.15s}
.mast nav menu a:hover{color:var(--pink);background:var(--pink-050)}
.mast .end{display:flex;align-items:center;gap:.7rem}
.tgl{width:40px;height:40px;border:1.5px solid var(--line-2);border-radius:10px;background:var(--paper);color:var(--fg);
  display:grid;place-items:center}
.login{font-weight:700;font-size:.94rem;color:var(--fg);padding:.5em .7em}
.login:hover{color:var(--pink)}
.burger{display:none;width:42px;height:42px;border:1.5px solid var(--line-2);border-radius:10px;background:var(--paper);
  color:var(--fg);place-items:center}
.mobile{display:none}
@media(max-width:960px){.mast nav menu,.mast .end .btn,.mast .end .login{display:none}.burger{display:grid}
  .mast .end{margin-left:auto}
  .mobile{display:block;position:fixed;inset:72px 0 auto 0;z-index:59;background:var(--paper);border-bottom:1px solid var(--line);
    box-shadow:var(--sh-2);padding:1rem var(--gutter) 1.4rem;list-style:none;margin:0;transform:translateY(-10px);opacity:0;
    pointer-events:none;transition:.25s}
  .mast.open .mobile{transform:none;opacity:1;pointer-events:auto}
  .mobile a{display:block;padding:.85rem .4rem;font-weight:600;border-bottom:1px solid var(--line)}
  .mobile .btn{display:flex;width:100%;margin-top:1rem}}
/* ── hero ── */
.hero{position:relative;padding-top:clamp(6rem,13vw,9rem);overflow:hidden}
.hero::before{content:"";position:absolute;inset:0;z-index:-1;
  background:radial-gradient(60% 45% at 18% 0%,color-mix(in srgb,var(--aqua) 26%,transparent),transparent 70%),
             radial-gradient(50% 40% at 92% 8%,color-mix(in srgb,var(--pink) 14%,transparent),transparent 70%)}
.hero .in{display:grid;gap:1.4rem;max-width:60rem}
.hero h1{font-size:var(--fs-h1)}
.hero h1 em{font-style:normal;color:var(--pink)}
.hero .cta{display:flex;flex-wrap:wrap;gap:.8rem;margin-top:.4rem}
/* live status ticker (script 1) */
.status{display:inline-flex;align-items:center;gap:.7rem;align-self:start;font-family:var(--f-mono);font-size:.82rem;
  font-weight:600;color:var(--fg-2);background:var(--paper);border:1px solid var(--line);border-radius:var(--r-pill);
  padding:.5rem .95rem}
.status .dot{width:9px;height:9px;border-radius:50%;background:var(--aqua);box-shadow:0 0 0 0 rgba(115,227,223,.7);
  animation:pulse 2s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(115,227,223,.6)}70%{box-shadow:0 0 0 8px rgba(115,227,223,0)}100%{box-shadow:0 0 0 0 rgba(115,227,223,0)}}
.status b{color:var(--fg);font-weight:800}
/* value benchmarks (ALL CAPS pattern interrupt) */
.bench{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;margin-top:2.4rem;background:var(--line);
  border:1px solid var(--line);border-radius:var(--r);overflow:hidden}
.bench article{background:var(--bg);padding:1.3rem 1.2rem}
.bench dt{font-size:.68rem;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--fg-3);margin:0 0 .35rem}
.bench dd{margin:0;font-family:var(--f-display);font-weight:700;font-size:clamp(1.6rem,3vw,2.3rem);line-height:1;
  font-variant-numeric:tabular-nums}
.bench dd em{font-style:normal;color:var(--pink)}
@media(max-width:760px){.bench{grid-template-columns:1fr 1fr}}
/* ── trust strip ── */
.trust{border-block:1px solid var(--line);background:var(--paper)}
.trust p{text-align:center;font-size:.78rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--fg-3);margin:0 0 1.3rem}
.trust ul{display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:clamp(1rem,3.5vw,2.6rem);list-style:none;margin:0;padding:0}
.trust li{display:inline-flex;align-items:center;gap:.5rem;color:var(--fg-2);font-weight:700;opacity:.85}
/* ── section heads ── */
.head{max-width:60ch;margin-bottom:clamp(2.4rem,5vw,3.4rem)}
.head.center{margin-inline:auto;text-align:center}
.head h2{font-size:var(--fs-h2);margin-bottom:.9rem}
/* ── SOP services ── */
.sop{background:var(--bg-2)}
.sop ol{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;list-style:none;margin:0;padding:0;counter-reset:s}
.sop li{background:var(--paper);border:1px solid var(--line);border-radius:var(--r);padding:1.6rem 1.5rem;
  transition:transform .22s,box-shadow .22s;position:relative}
.sop li:hover{transform:translateY(-4px);box-shadow:var(--sh-2)}
.sop li::before{counter-increment:s;content:"0" counter(s);font-family:var(--f-mono);font-weight:700;font-size:.8rem;color:var(--pink)}
.sop h3{font-size:var(--fs-h3);margin:.7rem 0 .5rem}
.sop p{color:var(--fg-2);font-size:.95rem;margin:0 0 1rem}
.sop b{display:block;font-family:var(--f-display);font-weight:700;text-transform:uppercase;letter-spacing:.03em;
  font-size:.82rem;color:var(--fg);border-top:1px dashed var(--line-2);padding-top:.9rem}
.sop b em{font-style:normal;color:var(--pink)}
@media(max-width:900px){.sop ol{grid-template-columns:1fr}}
/* ── proof matrix ── */
.proof table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;border:1px solid var(--line);
  border-radius:var(--r);overflow:hidden}
.proof caption{text-align:left;color:var(--fg-3);font-size:.82rem;margin-bottom:.8rem}
.proof thead th{text-align:left;font-family:var(--f-display);font-weight:600;font-size:.74rem;letter-spacing:.1em;
  text-transform:uppercase;color:var(--fg-3);background:var(--bg-2);padding:.9rem 1.1rem;border-bottom:1px solid var(--line)}
.proof tbody th{text-align:left;font-weight:700;padding:1.05rem 1.1rem;border-bottom:1px solid var(--line)}
.proof td{padding:1.05rem 1.1rem;border-bottom:1px solid var(--line);color:var(--fg-2)}
.proof tbody tr:last-child th,.proof tbody tr:last-child td{border-bottom:0}
.proof .big{font-family:var(--f-display);font-weight:700;font-size:1.5rem;color:var(--fg)}
.proof .big em{font-style:normal;color:var(--pink)}
.proof .delta{font-weight:800;color:var(--aqua-700)}
@media(max-width:640px){.proof thead{display:none}.proof table,.proof tbody,.proof tr,.proof th,.proof td{display:block}
  .proof tbody tr{border-bottom:1px solid var(--line);padding:.4rem 0}.proof tbody th,.proof td{border:0;padding:.35rem 1.1rem}
  .proof td::before{content:attr(data-l) "  ";font-weight:700;color:var(--fg-3)}}
/* ── live console (script 3) ── */
.live{background:var(--ink);color:#fff;position:relative;overflow:hidden}
.sp[data-theme='light'] .live{background:var(--ink)}
.live::after{content:"";position:absolute;width:520px;height:520px;right:-160px;top:-200px;
  background:radial-gradient(closest-side,rgba(115,227,223,.16),transparent 70%)}
.live .in{position:relative;z-index:2;display:grid;grid-template-columns:1fr 1.15fr;gap:clamp(2rem,5vw,4rem);align-items:center}
.live h2{color:#fff}.live .lead{color:rgba(255,255,255,.72)}
.live .eyebrow{color:var(--aqua)}.live .eyebrow::before{background:var(--aqua)}
.console{background:var(--panel);border:1px solid rgba(255,255,255,.09);border-radius:var(--r-lg);box-shadow:var(--sh-2);overflow:hidden}
.console figcaption{display:flex;align-items:center;gap:.5rem;padding:.7rem .95rem;border-bottom:1px solid rgba(255,255,255,.08);
  font-family:var(--f-mono);font-size:.72rem;color:rgba(255,255,255,.55)}
.console figcaption i{width:9px;height:9px;border-radius:50%;display:block}
.console figcaption i:nth-of-type(1){background:#FF5F57}.console figcaption i:nth-of-type(2){background:#FEBC2E}.console figcaption i:nth-of-type(3){background:#28C840}
.console figcaption span{margin-left:auto;display:inline-flex;align-items:center;gap:.4rem;color:var(--aqua)}
.console figcaption span b{width:7px;height:7px;border-radius:50%;background:var(--aqua);animation:pulse 2s infinite}
.console .body{padding:1.15rem}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:.6rem;margin:0 0 1rem;padding:0;list-style:none}
.kpis li{background:var(--panel-2);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:.75rem .7rem}
.kpis data{font-family:var(--f-display);font-weight:600;font-size:1.4rem;line-height:1;font-variant-numeric:tabular-nums}
.kpis li:nth-child(2) data{color:var(--aqua)}
.kpis small{display:block;margin-top:.3rem;font-size:.62rem;text-transform:uppercase;letter-spacing:.05em;color:rgba(255,255,255,.5)}
.charts{display:grid;grid-template-columns:1.5fr 1fr;gap:.7rem}
.charts figure{margin:0;background:var(--panel-2);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:.85rem}
.charts figcaption{padding:0;border:0;font-size:.64rem;text-transform:uppercase;letter-spacing:.06em;color:rgba(255,255,255,.55);margin-bottom:.7rem}
.bars{display:flex;align-items:flex-end;gap:.7rem;height:100px}
.bars b{flex:1;border-radius:5px 5px 0 0;background:linear-gradient(180deg,var(--pink),#c0004e);transition:height .6s cubic-bezier(.2,.7,.2,1);min-height:4px}
.bars b:nth-child(2){background:linear-gradient(180deg,var(--aqua),#3bbdb7)}
.bars b:nth-child(3){background:linear-gradient(180deg,#8b909a,#585d66)}
.bars b:nth-child(4){background:linear-gradient(180deg,#ff7fb0,#ff2d7f)}
.ring{display:grid;place-items:center;height:100px;position:relative}
.ring b{position:absolute;font-family:var(--f-display);font-weight:600;font-size:1.3rem;color:#fff}
@media(max-width:900px){.live .in{grid-template-columns:1fr}.kpis{grid-template-columns:1fr 1fr}}
/* ── film ── */
.film figure{margin:0;max-width:880px;margin-inline:auto;border-radius:var(--r-lg);overflow:hidden;box-shadow:var(--sh-2);border:1px solid var(--line);background:#000}
.film video{width:100%;aspect-ratio:16/9;object-fit:contain;background:#000}
/* ── quote ── */
.quote{background:var(--bg-2)}
.quote figure{margin:0;max-width:60rem;margin-inline:auto;text-align:center}
.quote blockquote{margin:0;font-family:var(--f-display);font-weight:500;font-size:clamp(1.5rem,3.3vw,2.3rem);line-height:1.28}
.quote blockquote em{font-style:normal;color:var(--aqua-700)}
.quote figcaption{margin-top:1.3rem;font-weight:700;color:var(--fg-2)}.quote figcaption b{color:var(--pink)}
/* ── lead (two-step) ── */
.lead-sec{background:var(--ink);color:#fff;position:relative;overflow:hidden}
.lead-sec::before{content:"";position:absolute;width:600px;height:600px;left:-200px;bottom:-300px;
  background:radial-gradient(closest-side,rgba(255,0,96,.16),transparent 70%)}
.lead-sec .in{position:relative;z-index:2;display:grid;grid-template-columns:1fr 1.05fr;gap:clamp(2rem,5vw,4rem);align-items:start}
.lead-sec h2{color:#fff;font-size:var(--fs-h2)}.lead-sec .lead{color:rgba(255,255,255,.74)}
.lead-sec .eyebrow{color:var(--aqua)}.lead-sec .eyebrow::before{background:var(--aqua)}
.steps{list-style:none;margin:1.6rem 0 0;padding:0;display:grid;gap:1rem}
.steps li{display:flex;gap:.9rem;align-items:flex-start}
.steps b{flex:none;width:30px;height:30px;border-radius:50%;background:var(--pink);color:#fff;display:grid;place-items:center;font-family:var(--f-display);font-weight:600}
.steps h3{color:#fff;font-size:1.05rem;margin-bottom:.15rem}.steps p{margin:0;color:rgba(255,255,255,.66);font-size:.92rem}
form.card{background:var(--paper);color:var(--fg);border-radius:var(--r-lg);padding:clamp(1.5rem,3vw,2rem);box-shadow:var(--sh-2)}
form.card fieldset{border:0;margin:0;padding:0}
form.card legend{font-family:var(--f-display);font-weight:600;font-size:1.2rem;margin-bottom:.2rem;padding:0}
form.card .sub{color:var(--fg-2);font-size:.9rem;margin:0 0 1.2rem}
form.card label{display:block;font-size:.8rem;font-weight:700;margin-bottom:.35rem}
form.card label em{font-style:normal;color:var(--pink)}
form.card input,form.card textarea,form.card select{width:100%;font-family:inherit;font-size:.95rem;padding:.75rem .9rem;
  border:1.5px solid var(--line-2);border-radius:10px;background:var(--bg-2);color:var(--fg);transition:.15s;margin-bottom:.9rem}
form.card input:focus,form.card textarea:focus,form.card select:focus{outline:none;border-color:var(--pink);background:var(--paper)}
form.card textarea{resize:vertical;min-height:84px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:.9rem}
.intent{display:flex;gap:.6rem;margin-bottom:1rem}
.intent label{flex:1;margin:0;border:1.5px solid var(--line-2);border-radius:10px;padding:.7rem .8rem;cursor:pointer;
  font-weight:700;font-size:.86rem;display:flex;gap:.5rem;align-items:center;transition:.15s}
.intent input{width:auto;margin:0}
.intent label:has(input:checked){border-color:var(--pink);background:var(--pink-050);color:var(--pink-700)}
form.card .btn{width:100%}
.avail{display:inline-flex;align-items:center;gap:.6rem;margin-top:1.1rem;font-family:var(--f-mono);font-size:.82rem;
  color:var(--fg-2)}
.avail .dot{width:10px;height:10px;border-radius:50%;background:var(--aqua);animation:pulse 2s infinite}
.avail.off .dot{background:var(--fg-3);animation:none}.avail b{color:var(--fg)}
.msg{border-radius:10px;padding:.85rem 1rem;font-weight:600;font-size:.92rem;margin-bottom:1rem}
.msg.ok{background:var(--aqua-050,#ECFBFA);color:var(--aqua-700);border:1px solid #CDEFED}
.msg.err{background:var(--pink-050);color:var(--pink-700);border:1px solid #FFD4E2}
@media(max-width:880px){.lead-sec .in{grid-template-columns:1fr}.two,.intent{grid-template-columns:1fr}}
/* ── footer ── */
footer.foot{background:var(--panel);color:rgba(255,255,255,.7);padding-block:clamp(3rem,6vw,4rem) 1.8rem}
.foot .top{display:grid;grid-template-columns:1.6fr 1fr 1fr;gap:2rem;padding-bottom:2.2rem;border-bottom:1px solid rgba(255,255,255,.1)}
.foot img{height:26px;margin-bottom:1rem;filter:brightness(0) invert(1)}
.foot .top p{font-size:.9rem;color:rgba(255,255,255,.6);max-width:38ch}
.foot h3{font-family:var(--f-display);font-weight:500;font-size:.8rem;letter-spacing:.1em;text-transform:uppercase;color:#fff;margin:0 0 .9rem}
.foot ul{list-style:none;margin:0;padding:0;display:grid;gap:.55rem}
.foot ul a{font-size:.9rem;color:rgba(255,255,255,.66)}.foot ul a:hover{color:var(--aqua)}
.foot .bot{display:flex;justify-content:space-between;flex-wrap:wrap;gap:1rem;padding-top:1.6rem;font-size:.82rem;color:rgba(255,255,255,.5)}
.foot .bot b{color:var(--aqua)}
@media(max-width:760px){.foot .top{grid-template-columns:1fr 1fr}.foot .top p{grid-column:1/-1}}
/* ── fab ── */
.fab{position:fixed;right:16px;bottom:16px;z-index:55;display:inline-flex;align-items:center;gap:.5em;background:var(--pink);
  color:#fff;font-weight:700;padding:.85em 1.4em;border-radius:var(--r-pill);box-shadow:0 16px 40px rgba(255,0,96,.32);
  opacity:0;transform:translateY(14px);pointer-events:none;transition:.3s;border:0}
.fab.on{opacity:1;transform:none;pointer-events:auto}.fab:hover{background:var(--pink-700)}
/* ── reveal ── */
.rv{opacity:0;transform:translateY(22px);transition:opacity .7s cubic-bezier(.2,.7,.2,1),transform .7s cubic-bezier(.2,.7,.2,1)}
.rv.in{opacity:1;transform:none}
@media(prefers-reduced-motion:reduce){.sp *{animation:none!important;transition:none!important}.rv{opacity:1;transform:none}}
`;

const Arrow = () => <svg className="btn__x" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>;

// SOP services — each with an ALL-CAPS value benchmark (pattern interrupt).
const SOP: { t: string; p: string; b: ReactNode }[] = [
  { t: 'Scope every walk', p: 'A fully customizable form builder plus out-of-the-box Estimate and QC inspection types — unlimited templates, offline in the field, priced against your live rate card as you go.', b: <>SCOPE → PRICE IN <em>UNDER 1 MINUTE</em></> },
  { t: 'Review with AI', p: 'Every photo and line is checked the moment it lands — flagging missing evidence, mispriced work, and duplicate lines before a human ever opens it.', b: <>AI REVIEW ON <em>100% OF SCOPES</em></> },
  { t: 'Dispatch & bill', p: 'Approved work becomes vendor tickets automatically, recurring services schedule themselves off a rules engine, and every dollar is tracked to the vendor and the owner.', b: <>SCOPE → TICKET IN <em>0.1 DAYS</em></> },
];

// Proof-of-concept matrix.
const MATRIX: { k: string; before: string; after: ReactNode; delta: string }[] = [
  { k: 'Scope → vendor ticket', before: '2.6 days', after: <><em>0.1</em> days</>, delta: '−96%' },
  { k: 'Priced scope turnaround', before: '~20 min', after: <><em>&lt;1</em> min</>, delta: '−95%' },
  { k: 'Photo review coverage', before: 'Spot-checked', after: <><em>100%</em> AI</>, delta: 'Full' },
  { k: 'Lost inspection evidence', before: 'Silent gaps', after: <><em>0</em> silent</>, delta: 'Caught' },
];

export default function Preview() {
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState('');
  const [menu, setMenu] = useState(false);
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>('system');
  const [fab, setFab] = useState(false);
  const [tick, setTick] = useState(0);
  const [avail, setAvail] = useState<{ on: boolean; text: string }>({ on: true, text: 'checking availability…' });
  const spRef = useRef<HTMLDivElement>(null);

  // Live status phrases (script 1) — cycled client-side, zero network.
  const PHRASES = [
    <>Live · <b>1,240</b> inspections synced today</>,
    <>Live · avg scope → ticket <b>0.1 days</b></>,
    <>Live · <b>100%</b> of scopes AI-reviewed</>,
    <>Live · <b>0</b> photos lost to bad signal</>,
  ];

  useEffect(() => {
    // Nav stuck + FAB.
    const onScroll = () => {
      spRef.current?.querySelector('.mast')?.classList.toggle('stuck', window.scrollY > 12);
      setFab(window.scrollY > 620);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Reveal on scroll.
    const reveals = Array.from(spRef.current?.querySelectorAll('.rv') || []);
    let io: IntersectionObserver | null = null;
    if ('IntersectionObserver' in window && !reduce) {
      io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io!.unobserve(e.target); } }), { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
      reveals.forEach((el) => io!.observe(el));
    } else reveals.forEach((el) => el.classList.add('in'));

    // SCRIPT 2 — count-up on any [data-count] once it scrolls in.
    let co: IntersectionObserver | null = null;
    const animateCount = (el: HTMLElement) => {
      const target = parseFloat(el.getAttribute('data-count') || '0');
      const dec = parseInt(el.getAttribute('data-dec') || '0', 10);
      const suf = el.getAttribute('data-suf') || '';
      let s: number | null = null;
      const step = (ts: number) => { if (s === null) s = ts; const p = Math.min((ts - s) / 1200, 1); const e = 1 - Math.pow(1 - p, 3); el.textContent = (target * e).toFixed(dec) + suf; if (p < 1) requestAnimationFrame(step); else el.textContent = target.toFixed(dec) + suf; };
      requestAnimationFrame(step);
    };
    const counters = Array.from(spRef.current?.querySelectorAll<HTMLElement>('[data-count]') || []);
    if ('IntersectionObserver' in window && !reduce) {
      co = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { animateCount(e.target as HTMLElement); co!.unobserve(e.target); } }), { threshold: 0.6 });
      counters.forEach((el) => co!.observe(el));
    } else counters.forEach((el) => { el.textContent = (el.getAttribute('data-count') || '') + (el.getAttribute('data-suf') || ''); });

    // SCRIPT 1 — status ticker.
    const t1 = reduce ? null : setInterval(() => setTick((n) => n + 1), 3200);
    // SCRIPT 3 — self-animating live console (bars + ring), high-contrast, GPU-cheap.
    const bars = Array.from(spRef.current?.querySelectorAll<HTMLElement>('.bars b') || []);
    const ringPct = spRef.current?.querySelector<HTMLElement>('.ring');
    const ringVal = spRef.current?.querySelector<HTMLElement>('.ring b');
    const paint = () => {
      bars.forEach((b) => { b.style.height = (30 + Math.round(Math.abs(Math.sin(Date.now() / 900 + Number(b.dataset.i))) * 70)) + '%'; });
      if (ringPct && ringVal) {
        const pct = 88 + Math.round(Math.abs(Math.sin(Date.now() / 1500)) * 10);
        ringPct.style.background = `conic-gradient(var(--aqua) ${pct}%, rgba(255,255,255,.08) 0)`;
        ringVal.textContent = pct + '%';
      }
    };
    paint();
    const t3 = reduce ? null : setInterval(paint, 1200);

    // Availability indicator (two-step closer) — business hours in ET.
    const computeAvail = () => {
      try {
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(new Date());
        const wd = parts.find((p) => p.type === 'weekday')?.value || '';
        const hr = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
        const weekday = !['Sat', 'Sun'].includes(wd);
        const openNow = weekday && hr >= 8 && hr < 18;
        setAvail(openNow
          ? { on: true, text: 'Available now · typical reply under 1 business hour' }
          : { on: false, text: "We'll reply first thing · usually within 1 business hour" });
      } catch { setAvail({ on: true, text: 'Typical reply within 1 business hour' }); }
    };
    computeAvail();
    const t4 = setInterval(computeAvail, 60000);

    return () => { window.removeEventListener('scroll', onScroll); io?.disconnect(); co?.disconnect(); if (t1) clearInterval(t1); if (t3) clearInterval(t3); clearInterval(t4); };
  }, []);

  function setTheme_(v: 'light' | 'dark') { setTheme(v); }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus('sending'); setError('');
    const fd = new FormData(e.currentTarget);
    try {
      const r = await fetch('/api/sitepreview/contact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(fd.entries())) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error || 'Something went wrong. Please try again.'); setStatus('error'); return; }
      setStatus('sent'); (e.target as HTMLFormElement).reset();
    } catch (err: any) { setError(String(err?.message || err)); setStatus('error'); }
  }

  const dataTheme = theme === 'system' ? undefined : theme;

  return (
    <div className="sp" ref={spRef} data-theme={dataTheme} id="top">
      <Head>
        <title>ResiWalk — The #1 Property Management Tool (preview)</title>
        <meta name="robots" content="noindex,nofollow" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#FF0060" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=Raleway:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      </Head>
      {/* eslint-disable-next-line react/no-danger */}
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      <header className={`mast${menu ? ' open' : ''}`}>
        <nav className="wrap" aria-label="Primary">
          <a href="#top" className="brand" aria-label="ResiWalk home"><img src="/resiwalk-logo.svg" alt="ResiWalk" /></a>
          <menu>
            <li><a href="#platform">Platform</a></li>
            <li><a href="#proof">Proof</a></li>
            <li><a href="#live">Live</a></li>
            <li><a href="#contact">Book a demo</a></li>
          </menu>
          <span className="end">
            <button className="tgl" onClick={() => setTheme_(document.documentElement && (dataTheme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)) ? 'light' : 'dark')} aria-label="Toggle dark mode" title="Toggle dark mode">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" /></svg>
            </button>
            <a href="/login" className="login">Log in</a>
            <a href="#contact" className="btn">Book a demo</a>
            <button className="burger" aria-label="Menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
            </button>
          </span>
        </nav>
        <menu className="mobile">
          <li><a href="#platform" onClick={() => setMenu(false)}>Platform</a></li>
          <li><a href="#proof" onClick={() => setMenu(false)}>Proof</a></li>
          <li><a href="#live" onClick={() => setMenu(false)}>Live</a></li>
          <li><a href="/login" onClick={() => setMenu(false)}>Log in</a></li>
          <li><a href="#contact" className="btn" onClick={() => setMenu(false)}>Book a demo</a></li>
        </menu>
      </header>

      <main>
        {/* HERO — value proposition */}
        <section className="hero">
          <div className="wrap in">
            <span className="status" aria-live="polite"><span className="dot" />{PHRASES[tick % PHRASES.length]}</span>
            <p className="eyebrow">The #1 Property Management Tool</p>
            <h1>Every property walk — <em>priced, dispatched &amp; measured.</em></h1>
            <p className="lead">ResiWalk turns a field inspection into a priced scope, an AI-reviewed report, a dispatched vendor ticket, and a line on your P&amp;L — in one pass, built by SFR &amp; BTR operators for the work you actually run.</p>
            <p className="cta">
              <a href="#contact" className="btn btn--lg">Book a demo <Arrow /></a>
              <a href="/login" className="btn btn--ghost btn--lg">Log in</a>
            </p>
            <dl className="bench">
              <article><dt>Scope → ticket</dt><dd><em>0.1</em>d</dd></article>
              <article><dt>Priced scope</dt><dd>&lt;<em>1</em>min</dd></article>
              <article><dt>AI photo review</dt><dd><em>100</em>%</dd></article>
              <article><dt>Templates</dt><dd>Un<em>ltd</em></dd></article>
            </dl>
          </div>
        </section>

        {/* TRUST */}
        <section className="trust">
          <div className="wrap">
            <p>Connected to the systems you already run</p>
            <ul className="rv">
              <li><HubSpotMark className="w-6 h-6" /> HubSpot</li>
              <li><DriveMark className="w-6 h-6" /> Google Drive</li>
              <li><CalendarMark className="w-6 h-6" /> Calendar</li>
              <li><SlackMark className="w-6 h-6" /> Slack</li>
              <li><GoogleMark className="w-6 h-6" /> Workspace</li>
            </ul>
          </div>
        </section>

        {/* SOP SERVICES */}
        <section className="sop" id="platform">
          <div className="wrap">
            <header className="head rv">
              <p className="eyebrow">The operating procedure</p>
              <h2>One pass. Priced, reviewed, dispatched.</h2>
              <p className="lead">Not a stack of point tools bolted together — a single procedure your field and office run the same way on every home.</p>
            </header>
            <ol>
              {SOP.map((s) => (
                <li key={s.t} className="rv">
                  <h3>{s.t}</h3>
                  <p>{s.p}</p>
                  <b>{s.b}</b>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* PROOF MATRIX */}
        <section className="proof" id="proof">
          <div className="wrap">
            <header className="head rv">
              <p className="eyebrow">Proof of concept</p>
              <h2>The numbers operators feel first.</h2>
              <p className="lead">Measured against the manual, multi-tool workflow ResiWalk replaces. Real operational savings, not vanity metrics.</p>
            </header>
            <table className="rv">
              <caption>Manual, multi-tool workflow vs. ResiWalk</caption>
              <thead><tr><th scope="col">Benchmark</th><th scope="col">Before</th><th scope="col">With ResiWalk</th><th scope="col">Change</th></tr></thead>
              <tbody>
                {MATRIX.map((m) => (
                  <tr key={m.k}>
                    <th scope="row">{m.k}</th>
                    <td data-l="Before">{m.before}</td>
                    <td data-l="With ResiWalk" className="big">{m.after}</td>
                    <td data-l="Change" className="delta">{m.delta}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* LIVE CONSOLE */}
        <section className="live" id="live">
          <div className="wrap in">
            <header className="rv">
              <p className="eyebrow">Live proof of competence</p>
              <h2>Your portfolio, measured in real time.</h2>
              <p className="lead">Insights update as the field works — completions, spend, on-time rate, and vendor performance across every market, without a single export.</p>
              <p className="cta"><a href="#contact" className="btn btn--lg">See it on your portfolio <Arrow /></a></p>
            </header>
            <figure className="console rv">
              <figcaption><i /><i /><i /> insights.resiwalk.com <span><b />live</span></figcaption>
              <div className="body">
                <ul className="kpis">
                  <li><data data-count="1240" data-suf="">0</data><small>Inspections</small></li>
                  <li><data data-count="98.6" data-dec="1" data-suf="%">0</data><small>On-time</small></li>
                  <li><data data-count="312" data-suf="">0</data><small>Vendors</small></li>
                  <li><data data-count="1.4" data-dec="1" data-suf="M" >0</data><small>Tracked $</small></li>
                </ul>
                <div className="charts">
                  <figure><figcaption>Completions / week</figcaption><div className="bars"><b data-i="0" /><b data-i="1" /><b data-i="2" /><b data-i="3" /></div></figure>
                  <figure><figcaption>On-time rate</figcaption><div className="ring"><b>—</b></div></figure>
                </div>
              </div>
            </figure>
          </div>
        </section>

        {/* FILM */}
        <section className="film">
          <div className="wrap">
            <header className="head center rv">
              <p className="eyebrow">See it in action</p>
              <h2>Two minutes, one property walk.</h2>
            </header>
            <figure className="rv">
              <video controls playsInline preload="metadata" poster="/sitepreview/intro-poster.jpg">
                <source src="/sitepreview/resiwalk-intro.mp4" type="video/mp4" />
              </video>
            </figure>
          </div>
        </section>

        {/* QUOTE */}
        <section className="quote">
          <div className="wrap">
            <figure className="rv">
              <blockquote><em>“</em>We stopped stitching together spreadsheets, photo folders, and vendor emails. Now a walk becomes a priced, dispatched, measured job before the inspector leaves the driveway.<em>”</em></blockquote>
              <figcaption>Mentor Sokoli, <b>President, ResiHome</b></figcaption>
            </figure>
          </div>
        </section>

        {/* LEAD — two-step */}
        <section className="lead-sec" id="contact">
          <div className="wrap in">
            <header className="rv">
              <p className="eyebrow">Two steps to a walkthrough</p>
              <h2>Bring one property. We'll show you the whole loop.</h2>
              <p className="lead">No slide deck marathon — a working walkthrough on a real home from your portfolio, priced against your own rate card.</p>
              <ol className="steps">
                <li><b>1</b><span><h3>Tell us where to send it</h3><p>Pick a callback or the 2-page overview — 20 seconds, no obligation.</p></span></li>
                <li><b>2</b><span><h3>We reply while we're open</h3><p>A real operator, not a bot — usually within one business hour.</p></span></li>
              </ol>
              <p className={`avail${avail.on ? '' : ' off'}`} aria-live="polite"><span className="dot" /><b>{avail.on ? 'Available now' : 'Back soon'}</b> — <output>{avail.text.replace(/^(Available now|We'll reply first thing)\s*·\s*/, '')}</output></p>
            </header>
            <form className="card rv" onSubmit={onSubmit}>
              <fieldset>
                <legend>Get a walkthrough</legend>
                <p className="sub">One low-friction step. We'll take it from there.</p>
                {status === 'sent' && <p className="msg ok" role="status">Got it — we'll be in touch within one business hour. Thank you.</p>}
                {status === 'error' && <p className="msg err" role="alert">{error}</p>}
                <div className="intent">
                  <label><input type="radio" name="intent" value="callback" defaultChecked /> Get a callback</label>
                  <label><input type="radio" name="intent" value="overview" /> Send the overview</label>
                </div>
                <div className="two">
                  <span><label htmlFor="pn">Name <em>*</em></label><input id="pn" name="name" required autoComplete="name" placeholder="Alex Rivera" /></span>
                  <span><label htmlFor="pc">Company</label><input id="pc" name="company" autoComplete="organization" placeholder="Acme SFR" /></span>
                </div>
                <div className="two">
                  <span><label htmlFor="pe">Work email <em>*</em></label><input id="pe" name="email" type="email" required autoComplete="email" placeholder="alex@acme.com" /></span>
                  <span><label htmlFor="ps">Portfolio size</label>
                    <select id="ps" name="portfolio" defaultValue=""><option value="" disabled>Select…</option><option>Under 500 homes</option><option>500–2,500</option><option>2,500–10,000</option><option>10,000+</option></select>
                  </span>
                </div>
                <label htmlFor="pm">Anything specific? <span style={{ color: 'var(--fg-3)', fontWeight: 400 }}>(optional)</span></label>
                <textarea id="pm" name="message" placeholder="Markets, current tools, what you'd want to see…" />
                <button className="btn" type="submit" disabled={status === 'sending'}>{status === 'sending' ? 'Sending…' : <>Get my walkthrough <Arrow /></>}</button>
              </fieldset>
            </form>
          </div>
        </section>
      </main>

      <footer className="foot">
        <div className="wrap">
          <div className="top">
            <div>
              <img src="/resiwalk-logo.svg" alt="ResiWalk" />
              <p>The full-suite property inspection, vendor management, and services platform — built by industry veterans for the SFR &amp; BTR demands of today and tomorrow.</p>
            </div>
            <nav aria-label="Platform"><h3>Platform</h3><ul><li><a href="#platform">Operating procedure</a></li><li><a href="#proof">Proof of concept</a></li><li><a href="#live">Live insights</a></li></ul></nav>
            <nav aria-label="Company"><h3>Company</h3><ul><li><a href="/login">Log in</a></li><li><a href="#contact">Book a demo</a></li><li><a href="/faq">FAQ</a></li></ul></nav>
          </div>
          <p className="bot"><span>© {new Date().getFullYear()} ResiWalk — a <b>ResiHome</b> company.</span><span>Built for SFR &amp; BTR.</span></p>
        </div>
      </footer>

      <button className={`fab${fab ? ' on' : ''}`} onClick={() => { document.getElementById('contact')?.scrollIntoView({ behavior: 'smooth' }); }}>Book a demo <Arrow /></button>
    </div>
  );
}
