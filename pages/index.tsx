/**
 * / — the OFFICIAL ResiWalk marketing homepage (promoted from /sitepreview).
 *
 * Approved "enterprise redesign" (Oswald display + Raleway, pink #FF0066 / ink /
 * aqua) with the intro video, a contact form that POSTs to
 * /api/sitepreview/contact, and real photo slots loading /sitepreview/photos/*.
 * Public + indexable. Routing (middleware.ts): a SIGNED-IN visitor who arrives by
 * typing/bookmark/app-launch is redirected to /app; link arrivals (Google, email)
 * always see this page and can enter via the nav's Log in / Open app button.
 */
import { useEffect, useState, type ReactNode } from 'react';
import Head from 'next/head';
import { HubSpotMark, DriveMark, CalendarMark, SlackMark, GoogleMark } from '@/components/sitepreview/Logos';

const CSS = `
:root{
  --pink:#FF0066;--pink-700:#D60057;--pink-050:#FFF0F5;--ink:#0A0A0A;--ink-800:#16181D;
  --panel:#0E1116;--panel-2:#151A21;--paper:#FFFFFF;--mist:#F6F7F9;--mist-2:#EEF1F5;
  --aqua:#73E3DF;--aqua-200:#A8EEEB;--aqua-050:#ECFBFA;--line:#E6E9EF;--line-2:#D9DDE6;--muted:#5B6169;--muted-2:#868D98;
  --f-display:'Oswald','Raleway',Arial,sans-serif;--f-body:'Raleway',Arial,sans-serif;--f-mono:ui-monospace,'SF Mono',Menlo,Consolas,monospace;
  --fs-eyebrow:.78rem;--fs-h1:clamp(2.55rem,5.4vw,4.35rem);--fs-h2:clamp(1.95rem,3.4vw,2.9rem);--fs-h3:1.3rem;
  --fs-lead:clamp(1.05rem,1.35vw,1.2rem);--fs-body:1rem;--fs-sm:.9rem;--fs-xs:.8rem;
  --wrap:1200px;--gutter:clamp(20px,4vw,40px);--sect:clamp(4.5rem,8vw,7.5rem);
  --r-xs:6px;--r-sm:10px;--r-md:16px;--r-lg:24px;--r-pill:999px;
  --sh-1:0 1px 2px rgba(14,17,22,.06),0 1px 1px rgba(14,17,22,.04);--sh-2:0 4px 12px rgba(14,17,22,.07),0 2px 4px rgba(14,17,22,.05);
  --sh-3:0 14px 34px rgba(14,17,22,.10),0 4px 10px rgba(14,17,22,.06);--sh-4:0 30px 70px rgba(14,17,22,.16),0 10px 24px rgba(14,17,22,.10);
  --glow-pink:0 20px 60px rgba(255,0,102,.22);--glow-aqua:0 20px 60px rgba(115,227,223,.30);
}
.sp *,.sp *::before,.sp *::after{box-sizing:border-box}
.sp{margin:0;font-family:var(--f-body);font-size:var(--fs-body);line-height:1.6;color:var(--ink);background:var(--paper);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;overflow-x:hidden}
.sp img,.sp svg{display:block;max-width:100%}
.sp a{text-decoration:none}
.sp a:not(.btn){color:inherit}
.sp button{font-family:inherit;cursor:pointer}
.sp [id]{scroll-margin-top:88px}
.sp :focus-visible{outline:3px solid var(--pink);outline-offset:2px;border-radius:4px}
.wrap{max-width:var(--wrap);margin-inline:auto;padding-inline:var(--gutter)}
.wrap-lg{max-width:1320px;margin-inline:auto;padding-inline:var(--gutter)}
.section{padding-block:var(--sect)}.section--mist{background:var(--mist)}.section--tight{padding-block:clamp(3rem,5vw,4.5rem)}
.eyebrow{font-family:var(--f-body);font-weight:700;font-size:var(--fs-eyebrow);letter-spacing:.16em;text-transform:uppercase;color:var(--pink);display:inline-flex;align-items:center;gap:.55em;margin:0 0 1.1rem}
.eyebrow__ico{width:24px;height:24px;border-radius:7px;background:var(--pink-050);color:var(--pink);display:grid;place-items:center;flex:none}
.eyebrow--center{justify-content:center}.eyebrow--light{color:var(--aqua)}.eyebrow--light .eyebrow__ico{background:rgba(115,227,223,.14);color:var(--aqua)}
.h1{font-family:var(--f-display);font-weight:700;font-size:var(--fs-h1);line-height:1.02;letter-spacing:-.015em;margin:0 0 1.3rem}
.h2{font-family:var(--f-display);font-weight:700;font-size:var(--fs-h2);line-height:1.06;letter-spacing:-.01em;margin:0 0 1.1rem}
.h3{font-family:var(--f-display);font-weight:600;font-size:var(--fs-h3);line-height:1.2;margin:0 0 .5rem}
.lead{font-size:var(--fs-lead);color:var(--muted);line-height:1.62;margin:0 0 1.6rem;max-width:56ch}
.center{text-align:center}.section-head{max-width:60ch;margin-inline:auto;margin-bottom:clamp(2.6rem,5vw,4rem)}.section-head .lead{margin-inline:auto}
.btn{--_bg:var(--pink);--_fg:#fff;--_bd:var(--pink);display:inline-flex;align-items:center;justify-content:center;gap:.5em;font-family:var(--f-body);font-weight:700;font-size:.98rem;letter-spacing:.01em;padding:.85em 1.5em;border-radius:var(--r-xs);background:var(--_bg);color:var(--_fg);border:1.5px solid var(--_bd);transition:transform .18s,box-shadow .22s,background .18s,border-color .18s,color .18s;white-space:nowrap}
.btn:hover{background:var(--pink-700);border-color:var(--pink-700);transform:translateY(-2px);box-shadow:var(--glow-pink)}
.btn--ghost{--_bg:transparent;--_fg:var(--ink);--_bd:var(--line-2)}.btn--ghost:hover{background:var(--ink);border-color:var(--ink);color:#fff;box-shadow:var(--sh-3)}
.btn--light{--_bg:#fff;--_fg:var(--ink);--_bd:#fff}.btn--light:hover{background:var(--aqua-050);border-color:var(--aqua-050);color:var(--ink)}
.btn--ghost-light{--_bg:transparent;--_fg:#fff;--_bd:rgba(255,255,255,.35)}.btn--ghost-light:hover{background:rgba(255,255,255,.10);border-color:rgba(255,255,255,.6)}
.btn--lg{padding:1.02em 1.9em;font-size:1.05rem}.btn__arrow{transition:transform .2s}.btn:hover .btn__arrow{transform:translateX(3px)}
.ticks{list-style:none;margin:1.5rem 0 0;padding:0;display:grid;gap:.75rem}
.ticks li{display:flex;align-items:flex-start;gap:.7rem;font-size:.98rem;color:var(--ink)}
.tick-ico{width:22px;height:22px;border-radius:var(--r-pill);background:var(--aqua-050);display:grid;place-items:center;flex:none;margin-top:.05rem}
.nav{position:fixed;top:0;left:0;right:0;z-index:60;transition:background .3s,box-shadow .3s,border-color .3s;background:rgba(255,255,255,0);border-bottom:1px solid transparent}
.nav.is-stuck{background:rgba(255,255,255,.82);backdrop-filter:saturate(180%) blur(14px);-webkit-backdrop-filter:saturate(180%) blur(14px);border-bottom:1px solid var(--line);box-shadow:var(--sh-1)}
.nav__in{display:flex;align-items:center;gap:1.5rem;height:72px}
.nav__logo{display:flex;align-items:center;gap:.6rem}.nav__logo img{height:34px;width:auto}
.nav__links{display:flex;align-items:center;gap:.35rem;margin-inline:auto}
.nav__links a{font-size:.94rem;font-weight:600;color:var(--ink-800);padding:.55em .8em;border-radius:var(--r-xs);transition:color .15s,background .15s}
.nav__links a:hover{color:var(--pink);background:var(--pink-050)}
.nav__cta{display:flex;align-items:center;gap:.6rem}
.nav__login{font-size:.94rem;font-weight:600;padding:.55em .7em;color:var(--ink-800)}.nav__login:hover{color:var(--pink)}
.nav__burger{display:none;width:44px;height:44px;border:1.5px solid var(--line-2);border-radius:var(--r-xs);background:#fff;place-items:center}
.nav__burger span,.nav__burger span::before,.nav__burger span::after{content:"";display:block;width:18px;height:2px;background:var(--ink);border-radius:2px;position:relative;transition:.25s}
.nav__burger span::before{position:absolute;top:-6px}.nav__burger span::after{position:absolute;top:6px}
.nav.is-open .nav__burger span{background:transparent}.nav.is-open .nav__burger span::before{top:0;transform:rotate(45deg)}.nav.is-open .nav__burger span::after{top:0;transform:rotate(-45deg)}
.nav__mobile{display:none}
@media(max-width:980px){.nav__links,.nav__cta .btn{display:none}.nav__burger{display:grid}.nav__cta{margin-left:auto}
  .nav__login{border:1.5px solid var(--line-2);border-radius:var(--r-xs);padding:.5em .95em;background:#fff}
  .nav__mobile{display:block;position:fixed;inset:72px 0 auto 0;z-index:59;background:#fff;border-bottom:1px solid var(--line);box-shadow:var(--sh-3);padding:1rem var(--gutter) 1.5rem;transform:translateY(-12px);opacity:0;pointer-events:none;transition:.25s}
  .nav.is-open .nav__mobile{transform:translateY(0);opacity:1;pointer-events:auto}
  .nav__mobile a{display:block;padding:.85rem .5rem;font-weight:600;border-bottom:1px solid var(--line);font-size:1.05rem}.nav__mobile .btn{display:flex;width:100%;margin-top:1rem}}
.hero{position:relative;padding-top:clamp(5.5rem,12vw,9.5rem);padding-bottom:clamp(2rem,4vw,3.5rem);overflow:hidden}
.hero__bg{position:absolute;inset:0;z-index:-1;overflow:hidden}
.hero__bg::before{content:"";position:absolute;width:900px;height:900px;left:-260px;top:-360px;background:radial-gradient(closest-side,rgba(115,227,223,.35),transparent 70%);filter:blur(10px)}
.hero__bg::after{content:"";position:absolute;width:760px;height:760px;right:-240px;top:-160px;background:radial-gradient(closest-side,rgba(255,0,102,.13),transparent 70%)}
.hero__grid-lines{position:absolute;inset:0;background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);background-size:46px 46px;opacity:.35;-webkit-mask-image:radial-gradient(120% 90% at 50% 0,#000 30%,transparent 78%);mask-image:radial-gradient(120% 90% at 50% 0,#000 30%,transparent 78%)}
.hero__in{display:flex;justify-content:center}
.hero__copy{max-width:760px;text-align:center}
.hero__copy .lead{margin-inline:auto}
.badge{display:inline-flex;align-items:center;gap:.5rem;background:#fff;border:1px solid var(--line);border-radius:var(--r-pill);padding:.5rem 1rem .5rem .8rem;font-size:.74rem;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--pink);box-shadow:var(--sh-1);margin-bottom:1.5rem}
.hero h1 .lite{display:block;background:linear-gradient(90deg,var(--pink),#9e003f);-webkit-background-clip:text;background-clip:text;color:transparent}
.btn--pill{border-radius:var(--r-pill)}
.fab{position:fixed;right:18px;bottom:18px;z-index:55;display:inline-flex;align-items:center;gap:.5em;background:var(--pink);color:#fff;font-weight:700;font-size:.95rem;padding:.9em 1.5em;border-radius:var(--r-pill);box-shadow:var(--glow-pink),var(--sh-3);opacity:0;transform:translateY(16px);pointer-events:none;transition:opacity .3s,transform .3s}
.fab.on{opacity:1;transform:none;pointer-events:auto}
.fab:hover{background:var(--pink-700)}
.hero__cta{display:flex;flex-wrap:wrap;gap:.8rem;margin-top:.4rem;justify-content:center}
.hero__proof{display:flex;flex-wrap:wrap;gap:1.6rem;margin-top:2.4rem;padding-top:1.8rem;border-top:1px solid var(--line)}
.proof__item{display:flex;flex-direction:column;gap:.1rem}
.proof__num{font-family:var(--f-display);font-weight:600;font-size:1.5rem;line-height:1;letter-spacing:-.01em}
.proof__lab{font-size:var(--fs-xs);color:var(--muted);font-weight:500}
.hero__stage{position:relative;min-height:420px;display:grid;place-items:center}
.stage-glow{position:absolute;inset:8% 4% 4% 8%;background:radial-gradient(60% 60% at 55% 45%,rgba(115,227,223,.42),transparent 70%);filter:blur(34px);z-index:0}
.compo{position:relative;z-index:1;display:flex;align-items:flex-end;justify-content:center;gap:14px;width:min(480px,100%)}
.browser{position:relative;z-index:2;flex:1 1 auto;min-width:0;background:#fff;border:1px solid var(--line);border-radius:var(--r-md);box-shadow:var(--sh-4);overflow:hidden}
.browser__bar{display:flex;align-items:center;gap:.5rem;padding:.7rem .9rem;border-bottom:1px solid var(--line);background:linear-gradient(#fff,#fbfcfd)}
.browser__dots{display:flex;gap:.4rem}.browser__dots i{width:11px;height:11px;border-radius:50%;display:block}
.browser__dots i:nth-child(1){background:#FF5F57}.browser__dots i:nth-child(2){background:#FEBC2E}.browser__dots i:nth-child(3){background:#28C840}
.browser__url{margin-left:.4rem;flex:1;font-family:var(--f-mono);font-size:.72rem;color:var(--muted-2);background:var(--mist);border:1px solid var(--line);border-radius:var(--r-pill);padding:.28rem .8rem;display:flex;align-items:center;gap:.4rem}
.browser__body{padding:1.1rem 1.15rem 1.25rem}
.scope__head{display:flex;align-items:center;justify-content:space-between;margin-bottom:.85rem}
.scope__title{font-family:var(--f-display);font-weight:600;font-size:1.05rem}
.chip{display:inline-flex;align-items:center;gap:.35rem;font-size:.72rem;font-weight:600;padding:.28rem .6rem;border-radius:var(--r-pill);background:var(--aqua-050);color:#0C8A83;border:1px solid #CDEFED}
.chip--region{background:var(--mist);color:var(--muted);border-color:var(--line)}
.scope__room{font-size:.74rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted-2);margin:.2rem 0 .55rem}
.line{display:flex;align-items:center;justify-content:space-between;gap:.8rem;padding:.68rem .2rem;border-bottom:1px solid var(--line)}.line:last-of-type{border-bottom:0}
.line__l{display:flex;flex-direction:column;gap:.12rem;min-width:0}
.line__name{font-weight:600;font-size:.92rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.line__meta{font-size:.74rem;color:var(--muted)}
.line__price{font-weight:700;font-variant-numeric:tabular-nums;font-size:.92rem}
.totals{display:grid;grid-template-columns:repeat(3,1fr);gap:.6rem;margin-top:.9rem}
.tot{background:var(--mist);border:1px solid var(--line);border-radius:var(--r-sm);padding:.75rem .4rem;text-align:center;min-width:0}
.tot--pink{background:var(--pink-050);border-color:#FFD4E2}
.tot__v{font-family:var(--f-display);font-weight:600;font-size:clamp(.95rem,3.4vw,1.15rem);font-variant-numeric:tabular-nums;line-height:1;white-space:nowrap}.tot--pink .tot__v{color:var(--pink)}
.tot__l{font-size:.66rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-top:.25rem}
.ai-chip{position:absolute;z-index:4;left:14px;top:14px;width:208px;background:#fff;border:1px solid var(--line);border-radius:var(--r-sm);box-shadow:var(--sh-3);padding:.75rem .85rem}
.ai-chip__top{display:flex;align-items:center;gap:.45rem;margin-bottom:.35rem}
.ai-dot{width:24px;height:24px;border-radius:6px;background:linear-gradient(135deg,var(--pink),#ff5b93);display:grid;place-items:center;flex:none}
.ai-chip__label{font-size:.68rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted-2)}
.ai-chip__txt{font-size:.82rem;font-weight:600;line-height:1.35}
.ai-chip__conf{margin-top:.5rem;height:5px;border-radius:3px;background:var(--mist);overflow:hidden}
.ai-chip__conf i{display:block;height:100%;width:94%;background:linear-gradient(90deg,var(--aqua),#0FB5AD);border-radius:3px}
.ai-chip__meta{display:flex;justify-content:space-between;margin-top:.35rem;font-size:.68rem;color:var(--muted)}
.phone{position:relative;z-index:3;flex:0 0 140px;width:140px;aspect-ratio:9/19.2;background:#0A0A0A;border-radius:30px;padding:8px;box-shadow:var(--sh-4);border:1px solid #26292F}
.phone__screen{position:absolute;inset:8px;border-radius:23px;overflow:hidden;background:#fff;display:flex;flex-direction:column}
.phone__notch{position:absolute;top:8px;left:50%;transform:translateX(-50%);width:64px;height:16px;background:#0A0A0A;border-radius:0 0 12px 12px;z-index:5}
.ph-top{background:var(--ink);color:#fff;padding:22px 12px 10px;flex:none}
.ph-top__t{font-family:var(--f-display);font-weight:600;font-size:.82rem}.ph-top__s{font-size:.6rem;color:rgba(255,255,255,.6)}
.ph-body{padding:9px 10px;display:flex;flex-direction:column;gap:7px;flex:1;background:var(--mist)}
.ph-shot{height:52px;border-radius:8px;background:linear-gradient(135deg,#dfe4ea,#eef1f5);position:relative;overflow:hidden;border:1px solid var(--line)}
.ph-shot::after{content:"";position:absolute;inset:0;background:radial-gradient(40% 60% at 30% 40%,rgba(115,227,223,.5),transparent),radial-gradient(50% 50% at 75% 70%,rgba(255,0,102,.14),transparent)}
.ph-gps{position:absolute;left:5px;bottom:5px;z-index:2;font-size:.5rem;font-weight:700;color:#fff;background:rgba(10,10,10,.7);border-radius:4px;padding:2px 5px;display:flex;align-items:center;gap:3px}
.ph-thumbs{display:flex;gap:5px}
.ph-thumbs i{flex:1;height:30px;border-radius:6px;background:#dfe4ea;border:1px solid var(--line);display:block;position:relative;overflow:hidden}
.ph-thumbs i::after{content:"";position:absolute;inset:0;background:radial-gradient(60% 60% at 40% 40%,rgba(115,227,223,.4),transparent)}
.ph-thumbs i:nth-child(2)::after{background:radial-gradient(60% 60% at 60% 50%,rgba(255,0,102,.14),transparent)}
.ph-line{background:#fff;border:1px solid var(--line);border-radius:7px;padding:6px 7px}
.ph-line__n{font-size:.6rem;font-weight:700}
.ph-line__r{display:flex;justify-content:space-between;font-size:.55rem;color:var(--muted);margin-top:2px}.ph-line__r b{color:var(--ink);font-variant-numeric:tabular-nums}
.ph-ai{background:var(--pink-050);border:1px solid #FFD4E2;border-radius:7px;padding:6px 7px;font-size:.56rem;font-weight:600;color:var(--pink-700);display:flex;align-items:center;gap:4px}
.ph-sync{margin-top:auto;background:#fff;border-top:1px solid var(--line);padding:7px 10px;font-size:.56rem;font-weight:700;color:#0C8A83;display:flex;align-items:center;gap:5px;flex:none}
.ph-sync .dot{width:6px;height:6px;border-radius:50%;background:#0FB5AD}
@media(max-width:560px){.compo{width:min(430px,94vw);gap:10px}.phone{flex:0 0 118px;width:118px}.ai-chip{width:180px;padding:.6rem .7rem}.ai-chip__txt{font-size:.76rem}}
.reveal{opacity:0;transform:translateY(26px);transition:opacity .7s cubic-bezier(.2,.7,.2,1),transform .7s cubic-bezier(.2,.7,.2,1)}
.reveal.in{opacity:1;transform:none}
.reveal.d1{transition-delay:.08s}.reveal.d2{transition-delay:.16s}.reveal.d3{transition-delay:.24s}
.logos{padding-block:clamp(2rem,4vw,3rem);border-top:1px solid var(--line);border-bottom:1px solid var(--line);background:#fff}
.logos__lab{text-align:center;font-size:var(--fs-xs);font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--muted-2);margin-bottom:1.6rem}
.logos__row{display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:clamp(1rem,3.5vw,2.8rem)}
.logo-mark{display:flex;align-items:center;gap:.55rem;color:var(--muted);font-weight:700;font-size:1.02rem;opacity:.85;transition:.2s}
.logo-mark:hover{opacity:1;color:var(--ink)}
.video-wrap{max-width:920px;margin-inline:auto;border-radius:var(--r-lg);overflow:hidden;box-shadow:var(--sh-4);background:#000;border:1px solid var(--line)}
.video-wrap video{width:100%;display:block;aspect-ratio:16/9;object-fit:contain;background:#000}
.gallery{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem}
.gtile{position:relative;aspect-ratio:4/3;border-radius:var(--r-md);overflow:hidden;border:1px solid var(--line);background:linear-gradient(135deg,#20232a,#0e1116);box-shadow:var(--sh-2)}
.gtile img{width:100%;height:100%;object-fit:cover;display:block}
.gtile__ph{position:absolute;inset:0;display:grid;place-items:center;color:rgba(255,255,255,.25)}
.gtile__cap{position:absolute;left:0;right:0;bottom:0;padding:1rem 1.1rem;background:linear-gradient(transparent,rgba(10,10,10,.78));color:#fff;font-weight:600;font-size:.92rem;z-index:2}
@media(max-width:820px){.gallery{grid-template-columns:1fr 1fr}}@media(max-width:520px){.gallery{grid-template-columns:1fr}}
.pipeline{position:relative}
.pipeline__grid{display:grid;grid-template-columns:repeat(3,1fr);gap:clamp(1.5rem,3vw,2.5rem);position:relative;z-index:2}
.walkline{position:absolute;left:0;right:0;top:56px;height:0;border-top:2px dashed var(--line-2);z-index:1;pointer-events:none}
.walkline i{position:absolute;top:-7px;width:14px;height:14px;border-radius:50%;background:var(--ink);border:3px solid var(--paper);box-shadow:0 0 0 2px var(--aqua)}
.walkline i:nth-child(1){left:calc(33.333% - 7px)}.walkline i:nth-child(2){left:calc(66.666% - 7px);background:var(--pink);box-shadow:0 0 0 2px var(--pink)}
.stage{background:#fff;border:1px solid var(--line);border-radius:var(--r-md);padding:1.8rem 1.6rem;box-shadow:var(--sh-2);position:relative;transition:transform .25s,box-shadow .25s}
.stage:hover{transform:translateY(-5px);box-shadow:var(--sh-3)}
.stage__pin{width:54px;height:54px;border-radius:16px;background:var(--ink);color:#fff;display:grid;place-items:center;margin-bottom:1.1rem;position:relative;box-shadow:var(--sh-2)}
.stage__pin b{font-family:var(--f-display);font-weight:600;font-size:1.15rem}
.stage__pin::after{content:"";position:absolute;inset:-5px;border-radius:20px;border:2px solid var(--aqua);opacity:.5}
.stage:nth-child(3) .stage__pin{background:var(--pink)}.stage:nth-child(3) .stage__pin::after{border-color:var(--pink);opacity:.35}
.stage__t{font-family:var(--f-display);font-weight:600;font-size:1.35rem;margin:0 0 .5rem}
.stage__p{color:var(--muted);font-size:.97rem;margin:0}
@media(max-width:820px){.pipeline__grid{grid-template-columns:1fr;gap:1.2rem}.walkline{display:none}}
.feature{display:grid;grid-template-columns:1.05fr 1fr;gap:clamp(2rem,5vw,4.5rem);align-items:center}
.feature + .feature{margin-top:clamp(4.5rem,9vw,7.5rem)}
.feature__title{font-family:var(--f-display);font-weight:700;font-size:clamp(1.6rem,2.6vw,2.15rem);line-height:1.1;letter-spacing:-.01em;margin:0 0 .95rem}
.feature__lead{font-size:var(--fs-lead);color:var(--muted);line-height:1.62;margin:0}
.feature--rev .feature__media{order:-1}
@media(max-width:880px){.feature{grid-template-columns:1fr;gap:2.2rem}.feature--rev .feature__media{order:0}}
.visual{position:relative;background:linear-gradient(155deg,var(--mist),#fff);border:1px solid var(--line);border-radius:var(--r-lg);padding:clamp(1.4rem,3vw,2.2rem);box-shadow:var(--sh-2);overflow:hidden}
.visual::before{content:"";position:absolute;width:340px;height:340px;right:-120px;top:-120px;background:radial-gradient(closest-side,rgba(115,227,223,.28),transparent 70%)}
.visual--pink::before{background:radial-gradient(closest-side,rgba(255,0,102,.12),transparent 70%)}
.card{position:relative;background:#fff;border:1px solid var(--line);border-radius:var(--r-md);box-shadow:var(--sh-3);overflow:hidden}
.card__bar{display:flex;align-items:center;gap:.5rem;padding:.6rem .85rem;border-bottom:1px solid var(--line);background:linear-gradient(#fff,#fbfcfd)}
.card__dots{display:flex;gap:.35rem}.card__dots i{width:9px;height:9px;border-radius:50%}
.card__dots i:nth-child(1){background:#FF5F57}.card__dots i:nth-child(2){background:#FEBC2E}.card__dots i:nth-child(3){background:#28C840}
.card__url{margin-left:.3rem;font-family:var(--f-mono);font-size:.68rem;color:var(--muted-2);background:var(--mist);border:1px solid var(--line);border-radius:var(--r-pill);padding:.24rem .7rem}
.card__body{padding:1.1rem 1.15rem}
.rc__head{display:flex;justify-content:space-between;align-items:center;margin-bottom:.8rem}
.rc__title{font-family:var(--f-display);font-weight:600;font-size:1.05rem}
.rc__region{font-size:.72rem;font-weight:600;color:var(--muted);background:var(--mist);border:1px solid var(--line);border-radius:var(--r-pill);padding:.26rem .65rem}
.rc__row{display:flex;justify-content:space-between;align-items:center;gap:.8rem;padding:.62rem .1rem;border-bottom:1px solid var(--line)}.rc__row:last-child{border-bottom:0}
.rc__n{font-weight:600;font-size:.9rem}.rc__u{font-size:.72rem;color:var(--muted)}.rc__p{font-weight:700;font-variant-numeric:tabular-nums;font-size:.92rem}
.rc__totals{display:grid;grid-template-columns:repeat(3,1fr);gap:.5rem;margin-top:.9rem}
.ai-photo{aspect-ratio:16/10;border-radius:var(--r-sm);position:relative;overflow:hidden;background:linear-gradient(135deg,#cdd4dc,#eef1f5);border:1px solid var(--line)}
.ai-photo img{width:100%;height:100%;object-fit:cover}
.ai-photo::after{content:"";position:absolute;inset:0;background:radial-gradient(45% 55% at 62% 30%,rgba(180,190,200,.5),transparent),linear-gradient(180deg,rgba(0,0,0,.02),rgba(0,0,0,.10))}
.ai-box{position:absolute;left:52%;top:16%;width:34%;height:32%;border:2px dashed var(--pink);border-radius:6px;z-index:2;box-shadow:0 0 0 3px rgba(255,0,102,.12)}
.ai-box__tag{position:absolute;top:-24px;left:-2px;background:var(--pink);color:#fff;font-size:.62rem;font-weight:700;padding:.2rem .5rem;border-radius:4px;white-space:nowrap}
.ai-sugg{margin-top:.9rem;background:var(--mist);border:1px solid var(--line);border-radius:var(--r-sm);padding:.8rem .9rem}
.ai-sugg__t{display:flex;align-items:center;gap:.45rem;font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted-2);margin-bottom:.35rem}
.ai-sugg__m{font-size:.92rem;font-weight:600}
.ai-sugg__bar{height:6px;border-radius:3px;background:#E7EAEF;margin:.6rem 0 .3rem;overflow:hidden}.ai-sugg__bar i{display:block;height:100%;width:94%;background:linear-gradient(90deg,var(--aqua),#0FB5AD);border-radius:3px}
.ai-sugg__row{display:flex;justify-content:space-between;align-items:center;margin-top:.6rem}.ai-sugg__conf{font-size:.72rem;color:var(--muted)}
.mini-btns{display:flex;gap:.4rem}.mini-btn{font-size:.72rem;font-weight:700;padding:.35rem .8rem;border-radius:var(--r-xs);border:1.5px solid var(--line-2);background:#fff}.mini-btn--go{background:var(--pink);border-color:var(--pink);color:#fff}
.svc__head{display:flex;justify-content:space-between;align-items:center;margin-bottom:.7rem}
.svc__title{font-family:var(--f-display);font-weight:600;font-size:1.05rem}.svc__sub{font-size:.72rem;color:var(--muted)}
.svc-row{display:grid;grid-template-columns:1.4fr .9fr 1.2fr auto;gap:.6rem;align-items:center;padding:.65rem .2rem;border-bottom:1px solid var(--line);font-size:.86rem}.svc-row:last-child{border-bottom:0}
.svc-row__n{font-weight:600}.svc-row__c,.svc-row__v{color:var(--muted);font-size:.8rem}
.pill{font-size:.66rem;font-weight:700;padding:.24rem .6rem;border-radius:var(--r-pill);white-space:nowrap;justify-self:end}
.pill--sch{background:var(--aqua-050);color:#0C8A83;border:1px solid #CDEFED}.pill--dis{background:var(--pink-050);color:var(--pink-700);border:1px solid #FFD4E2}
.pill--inv{background:#EDEFF3;color:var(--ink);border:1px solid var(--line-2)}.pill--asn{background:var(--mist);color:var(--muted);border:1px solid var(--line)}
.svc__foot{display:flex;justify-content:space-between;font-size:.76rem;color:var(--muted);border-top:1px solid var(--line);padding-top:.7rem;margin-top:.3rem}.svc__foot b{color:var(--ink)}
.ladder__cap{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted-2);margin-bottom:.9rem}
.rung{display:flex;align-items:center;gap:.9rem;background:#fff;border:1px solid var(--line);border-left:3px solid var(--aqua);border-radius:var(--r-sm);padding:.75rem .9rem;box-shadow:var(--sh-1)}
.rung--esc{border-left-color:var(--pink)}
.rung__cond{font-family:var(--f-mono);font-size:.76rem;font-weight:600;color:var(--ink);background:var(--mist);border-radius:var(--r-xs);padding:.28rem .55rem;white-space:nowrap}
.rung__then{font-size:.86rem;color:var(--muted)}.rung__then b{color:var(--ink);font-weight:700}
.rung-link{display:flex;justify-content:center;padding:.25rem 0;color:var(--muted-2)}
.dash{background:var(--panel);border:1px solid rgba(255,255,255,.08);border-radius:var(--r-md);box-shadow:var(--sh-4);overflow:hidden;color:#fff}
.dash__bar{display:flex;align-items:center;gap:.5rem;padding:.7rem .9rem;border-bottom:1px solid rgba(255,255,255,.08)}
.dash__dots{display:flex;gap:.35rem}.dash__dots i{width:9px;height:9px;border-radius:50%}
.dash__dots i:nth-child(1){background:#FF5F57}.dash__dots i:nth-child(2){background:#FEBC2E}.dash__dots i:nth-child(3){background:#28C840}
.dash__url{margin-left:.3rem;font-family:var(--f-mono);font-size:.68rem;color:rgba(255,255,255,.5);background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);border-radius:var(--r-pill);padding:.24rem .7rem}
.dash__body{padding:1.15rem}
.dash__top{display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem}.dash__title{font-family:var(--f-display);font-weight:600;font-size:1.1rem}
.tabs{display:flex;gap:.3rem;background:rgba(255,255,255,.06);border-radius:var(--r-pill);padding:.2rem}
.tabs span{font-size:.7rem;font-weight:700;padding:.28rem .7rem;border-radius:var(--r-pill);color:rgba(255,255,255,.6)}.tabs span.on{background:var(--pink);color:#fff}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:.6rem;margin-bottom:1rem}
.kpi{background:var(--panel-2);border:1px solid rgba(255,255,255,.06);border-radius:var(--r-sm);padding:.75rem .7rem}
.kpi__v{font-family:var(--f-display);font-weight:600;font-size:1.4rem;line-height:1;font-variant-numeric:tabular-nums}
.kpi__l{font-size:.64rem;color:rgba(255,255,255,.55);margin-top:.3rem;text-transform:uppercase;letter-spacing:.05em}.kpi--hi .kpi__v{color:var(--aqua)}
.dash__charts{display:grid;grid-template-columns:1.5fr 1fr;gap:.7rem}
.panel{background:var(--panel-2);border:1px solid rgba(255,255,255,.06);border-radius:var(--r-sm);padding:.85rem .9rem}
.panel__t{font-size:.66rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:rgba(255,255,255,.55);margin-bottom:.7rem}
.bars{display:flex;align-items:flex-end;gap:.8rem;height:104px;padding-top:.3rem}
.bar{flex:1;display:flex;flex-direction:column;align-items:center;gap:.4rem;height:100%;justify-content:flex-end}
.bar__fill{width:100%;border-radius:5px 5px 0 0;background:linear-gradient(180deg,var(--pink),#c0004e)}
.bar:nth-child(2) .bar__fill{background:linear-gradient(180deg,var(--aqua),#3bbdb7)}.bar:nth-child(3) .bar__fill{background:linear-gradient(180deg,#8b909a,#585d66)}.bar:nth-child(4) .bar__fill{background:linear-gradient(180deg,#ff7fb0,#ff2d7f)}
.bar__l{font-size:.6rem;color:rgba(255,255,255,.5)}
.donut{display:flex;flex-direction:column;align-items:center;gap:.4rem}.donut__c{position:relative;width:120px;height:120px}
.donut__mid{position:absolute;inset:0;display:grid;place-items:center;text-align:center}
.donut__v{font-family:var(--f-display);font-weight:600;font-size:1.35rem;line-height:1}.donut__l{font-size:.58rem;color:rgba(255,255,255,.55);text-transform:uppercase;letter-spacing:.05em}
@media(max-width:520px){.kpis{grid-template-columns:repeat(2,1fr)}.dash__charts{grid-template-columns:1fr}}
.insights-wrap{max-width:960px;margin-inline:auto}.insights-wrap .dash{margin-top:.5rem}
.int-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem}
.int-card{background:#fff;border:1px solid var(--line);border-radius:var(--r-md);padding:1.5rem;box-shadow:var(--sh-1);transition:transform .22s,box-shadow .22s,border-color .22s}
.int-card:hover{transform:translateY(-4px);box-shadow:var(--sh-3);border-color:var(--line-2)}
.int-card__ico{width:48px;height:48px;border-radius:12px;background:var(--mist);border:1px solid var(--line);display:grid;place-items:center;margin-bottom:1rem}
.int-card__cat{font-size:.68rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--pink);margin-bottom:.3rem}
.int-card h3{font-family:var(--f-display);font-weight:600;font-size:1.2rem;margin:0 0 .4rem}
.int-card p{font-size:.9rem;color:var(--muted);margin:0;line-height:1.5}
.int-card--cta{background:var(--ink);color:#fff;display:flex;flex-direction:column;justify-content:center}
.int-card--cta h3{color:#fff}.int-card--cta p{color:rgba(255,255,255,.7)}
.int-card--cta a{color:var(--aqua);font-weight:700;font-size:.9rem;margin-top:.6rem;display:inline-flex;align-items:center;gap:.35rem}
@media(max-width:820px){.int-grid{grid-template-columns:1fr 1fr}}@media(max-width:520px){.int-grid{grid-template-columns:1fr}}
.band{background:var(--ink);color:#fff;position:relative;overflow:hidden}
.band::before{content:"";position:absolute;width:600px;height:600px;left:-200px;bottom:-300px;background:radial-gradient(closest-side,rgba(115,227,223,.18),transparent 70%)}
.band::after{content:"";position:absolute;width:500px;height:500px;right:-160px;top:-260px;background:radial-gradient(closest-side,rgba(255,0,102,.16),transparent 70%)}
.band__in{position:relative;z-index:2;display:grid;grid-template-columns:1.1fr 1fr;gap:clamp(2rem,5vw,4rem);align-items:center}
.band h2{color:#fff}.band .lead{color:rgba(255,255,255,.72)}
.metrics{display:grid;grid-template-columns:repeat(2,1fr);gap:1px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.12);border-radius:var(--r-md);overflow:hidden}
.metric{background:var(--ink);padding:1.5rem 1.4rem}
.metric__v{font-family:var(--f-display);font-weight:600;font-size:clamp(1.9rem,3.2vw,2.6rem);line-height:1;color:var(--aqua);font-variant-numeric:tabular-nums;white-space:nowrap}
.metric__v--sm{font-size:clamp(1.35rem,2.4vw,1.9rem)}
.metric__l{font-size:.82rem;color:rgba(255,255,255,.7);margin-top:.4rem}
@media(max-width:880px){.band__in{grid-template-columns:1fr}}
.markets{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:1.4rem}
.market{font-size:.82rem;font-weight:600;color:#fff;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);border-radius:var(--r-pill);padding:.4rem .9rem}
.market--more{background:transparent;color:var(--aqua);border-color:rgba(115,227,223,.4)}
.price-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1.1rem;align-items:stretch}
.tier{display:flex;flex-direction:column;background:#fff;border:1px solid var(--line);border-radius:var(--r-lg);padding:2rem 1.7rem;box-shadow:var(--sh-1);position:relative}
.tier--pop{border:2px solid var(--pink);box-shadow:var(--glow-pink)}
.tier__badge{position:absolute;top:-13px;left:50%;transform:translateX(-50%);background:var(--pink);color:#fff;font-size:.68rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:.32rem .9rem;border-radius:var(--r-pill)}
.tier__name{font-family:var(--f-display);font-weight:600;font-size:1.5rem;margin:0 0 .4rem}
.tier__desc{font-size:.9rem;color:var(--muted);min-height:2.6em;margin:0 0 1.1rem;line-height:1.4}
.tier__price{display:flex;align-items:baseline;gap:.4rem;padding-bottom:1.1rem;border-bottom:1px solid var(--line);margin-bottom:1.1rem}
.tier__price b{font-family:var(--f-display);font-weight:600;font-size:2rem;line-height:1}.tier__price span{font-size:.82rem;color:var(--muted)}
.tier__list{list-style:none;margin:0 0 1.5rem;padding:0;display:grid;gap:.65rem;flex:1}
.tier__list li{display:flex;gap:.55rem;align-items:flex-start;font-size:.9rem}.tier__list svg{flex:none;margin-top:.2rem}
.tier .btn{width:100%}.price-note{text-align:center;color:var(--muted);font-size:.9rem;margin-top:1.8rem}
@media(max-width:900px){.price-grid{grid-template-columns:1fr;max-width:440px;margin-inline:auto}.tier--pop{order:-1}}
.sec-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:1rem}
.sec-card{background:var(--mist);border:1px solid var(--line);border-radius:var(--r-md);padding:1.5rem 1.4rem}
.sec-card__ico{width:42px;height:42px;border-radius:12px;background:#fff;border:1px solid var(--line);display:grid;place-items:center;color:var(--pink);margin-bottom:1rem}
.sec-card h3{font-family:var(--f-display);font-weight:600;font-size:1.1rem;margin:0 0 .4rem;line-height:1.2}
.sec-card p{font-size:.86rem;color:var(--muted);margin:0;line-height:1.5}
@media(max-width:900px){.sec-grid{grid-template-columns:1fr 1fr}}@media(max-width:480px){.sec-grid{grid-template-columns:1fr}}
.quote{max-width:900px;margin-inline:auto;text-align:center}
.quote__t{font-family:var(--f-display);font-weight:500;font-size:clamp(1.5rem,3.2vw,2.2rem);line-height:1.28;letter-spacing:-.01em;margin:0 0 1.4rem}
.quote__t .qm{color:var(--aqua)}
.quote__by{font-size:.92rem;color:var(--muted);font-weight:600}.quote__by span{color:var(--pink)}
.about{background:var(--ink);color:#fff;position:relative;overflow:hidden}
.about::after{content:"";position:absolute;width:520px;height:520px;right:-160px;bottom:-260px;background:radial-gradient(closest-side,rgba(115,227,223,.16),transparent 70%)}
.about__in{position:relative;z-index:2;max-width:820px}.about h2{color:#fff;font-size:clamp(1.7rem,3.2vw,2.5rem)}.about p{color:rgba(255,255,255,.74);font-size:var(--fs-lead);max-width:60ch}
.faq{max-width:780px;margin-inline:auto}
.faq details{border:1px solid var(--line);border-radius:var(--r-sm);background:#fff;margin-bottom:.7rem;overflow:hidden;box-shadow:var(--sh-1)}
.faq summary{list-style:none;cursor:pointer;padding:1.1rem 1.3rem;font-family:var(--f-display);font-weight:600;font-size:1.08rem;display:flex;justify-content:space-between;align-items:center;gap:1rem}
.faq summary::-webkit-details-marker{display:none}
.faq summary::after{content:"+";font-size:1.5rem;color:var(--pink);font-weight:400;transition:transform .2s}
.faq details[open] summary::after{transform:rotate(45deg)}
.faq__a{padding:0 1.3rem 1.2rem;color:var(--muted);line-height:1.6;font-size:.96rem}
.contact{display:grid;grid-template-columns:1fr 1fr;gap:clamp(2rem,5vw,4rem);align-items:start}
.contact__form{background:#fff;border:1px solid var(--line);border-radius:var(--r-lg);padding:clamp(1.6rem,3vw,2.2rem);box-shadow:var(--sh-3)}
.field{margin-bottom:1rem}.field label{display:block;font-size:.82rem;font-weight:700;margin-bottom:.4rem}.field label span{color:var(--pink)}
.field input,.field textarea{width:100%;font-family:inherit;font-size:.95rem;padding:.75rem .9rem;border:1.5px solid var(--line-2);border-radius:var(--r-xs);background:var(--mist);transition:border-color .15s,background .15s}
.field input:focus,.field textarea:focus{outline:none;border-color:var(--pink);background:#fff}
.field textarea{resize:vertical;min-height:96px}
.field-row{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
.form-note{font-size:.78rem;color:var(--muted-2);margin-top:.3rem}
.form-msg{border-radius:var(--r-sm);padding:.9rem 1rem;font-weight:600;font-size:.92rem;margin-bottom:1rem}
.form-msg--ok{background:var(--aqua-050);border:1px solid #CDEFED;color:#0C8A83}
.form-msg--err{background:var(--pink-050);border:1px solid #FFD4E2;color:var(--pink-700)}
@media(max-width:820px){.contact{grid-template-columns:1fr}.field-row{grid-template-columns:1fr}}
.final{background:linear-gradient(135deg,var(--pink),#ff3d85);color:#fff;text-align:center;position:relative;overflow:hidden}
.final::before{content:"";position:absolute;inset:0;background:radial-gradient(60% 100% at 50% 0,rgba(255,255,255,.16),transparent 60%)}
.final__in{position:relative;z-index:2;max-width:680px;margin-inline:auto}.final h2{color:#fff;font-size:clamp(2rem,4vw,3rem)}
.final p{color:rgba(255,255,255,.9);font-size:var(--fs-lead);margin-bottom:2rem}.final__cta{display:flex;gap:.8rem;justify-content:center;flex-wrap:wrap}
.foot{background:var(--panel);color:rgba(255,255,255,.7);padding-block:clamp(3rem,6vw,4.5rem) 2rem}
.foot__top{display:grid;grid-template-columns:1.6fr 1fr 1fr 1fr;gap:2rem;padding-bottom:2.5rem;border-bottom:1px solid rgba(255,255,255,.1)}
.foot__brand img{height:26px;margin-bottom:1rem}.foot__brand p{font-size:.9rem;color:rgba(255,255,255,.6);line-height:1.6}
.foot h4{font-family:var(--f-display);font-weight:500;font-size:.82rem;letter-spacing:.1em;text-transform:uppercase;color:#fff;margin:0 0 1rem}
.foot ul{list-style:none;margin:0;padding:0;display:grid;gap:.6rem}.foot ul a{font-size:.9rem;color:rgba(255,255,255,.68);transition:color .15s}.foot ul a:hover{color:var(--aqua)}
.foot__bottom{display:flex;justify-content:space-between;align-items:center;gap:1rem;padding-top:1.8rem;flex-wrap:wrap;font-size:.82rem;color:rgba(255,255,255,.5)}.foot__tag{color:var(--aqua);font-weight:600}
@media(max-width:820px){.foot__top{grid-template-columns:repeat(3,1fr);gap:1.2rem}.foot__brand{grid-column:1/-1}}
@media(prefers-reduced-motion:reduce){.sp *{animation:none!important}.reveal{opacity:1;transform:none;transition:none}}
`;

const Tick = () => <span className="tick-ico"><svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="#0FB5AD" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg></span>;

// Per-section eyebrow icons (stroke, 24 viewBox) — a branded chip instead of the dash.
const EYE_ICONS: Record<string, ReactNode> = {
  platform: <><path d="M12 3l8 4.5-8 4.5-8-4.5L12 3z" /><path d="M4 13l8 4.5L20 13" /></>,
  play: <path d="M8 5.5v13l10.5-6.5L8 5.5z" />,
  inspections: <><rect x="8" y="2.5" width="8" height="4" rx="1" /><path d="M8 4.5H6a2 2 0 00-2 2V19a2 2 0 002 2h12a2 2 0 002-2V6.5a2 2 0 00-2-2h-2" /><path d="M9 13l2 2 4.5-4.5" /></>,
  pricing: <path d="M12 2.5v19M17 6.5H9.5a3 3 0 000 6h5a3 3 0 010 6H6.5" />,
  ai: <path d="M12 3l2 5.5L19.5 10 14 12l-2 5.5L10 12 4.5 10 10 8.5 12 3z" />,
  services: <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M4 10h16M8 3v4M16 3v4" /></>,
  rules: <><rect x="3.5" y="3.5" width="6.5" height="5" rx="1" /><rect x="14" y="15.5" width="6.5" height="5" rx="1" /><path d="M7 8.5v4a3 3 0 003 3h4" /></>,
  field: <><path d="M4 8h3l2-2.5h6L17 8h3a1.5 1.5 0 011.5 1.5V19a1.5 1.5 0 01-1.5 1.5H4A1.5 1.5 0 012.5 19V9.5A1.5 1.5 0 014 8z" /><circle cx="12" cy="14" r="3.5" /></>,
  insights: <path d="M4.5 20V4.5M4.5 20H20M8.5 16l3-4 3 3 5-6.5" />,
  scale: <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.5 2.4 3.8 5.3 3.8 8.5s-1.3 6.1-3.8 8.5c-2.5-2.4-3.8-5.3-3.8-8.5s1.3-6.1 3.8-8.5z" /></>,
  integrations: <path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1.2 1.2M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1.2-1.2" />,
  tiers: <><path d="M20.5 12l-8.5 8.5L3.5 12V3.5H12L20.5 12z" /><circle cx="8" cy="8" r="1.5" /></>,
  security: <><path d="M12 3l7.5 3v5.2c0 4.6-3.2 8.2-7.5 10-4.3-1.8-7.5-5.4-7.5-10V6l7.5-3z" /><path d="M9 12l2 2 4-4" /></>,
  teams: <><circle cx="9" cy="8.5" r="3.5" /><path d="M3 20c0-3.3 2.7-5 6-5s6 1.7 6 5M16.5 5.5a3.5 3.5 0 010 6M18 15.2c2 .7 3.5 2 3.5 4.8" /></>,
  faq: <><circle cx="12" cy="12" r="8.5" /><path d="M9.5 9.5A2.5 2.5 0 0112 7c1.4 0 2.5 1 2.5 2.3 0 1.8-2.5 2-2.5 3.7M12 16.8h.01" /></>,
  contact: <><rect x="3.5" y="5.5" width="17" height="13" rx="2" /><path d="M4 7l8 6 8-6" /></>,
};
const Eyebrow = ({ icon, className = 'eyebrow', children }: { icon: string; className?: string; children: ReactNode }) => (
  <span className={className}>
    <span className="eyebrow__ico" aria-hidden><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{EYE_ICONS[icon]}</svg></span>
    {children}
  </span>
);
const TierCheck = ({ c }: { c: string }) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke={c} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;

/** Real photo with a branded fallback tile until /sitepreview/photos/<name> exists. */
function PhotoTile({ src, caption }: { src: string; caption: string }) {
  const [ok, setOk] = useState(true);
  return (
    <div className="gtile reveal">
      {ok ? <img src={src} alt={caption} loading="lazy" onError={() => setOk(false)} />
        : <div className="gtile__ph"><svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="2" /><path d="M3 17l5-4 4 3 3-2 6 5" /></svg></div>}
      <div className="gtile__cap">{caption}</div>
    </div>
  );
}

export default function SitePreview() {
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState('');

  const [fab, setFab] = useState(false);

  useEffect(() => {
    // Installed-app launches must NEVER sit on the marketing page: a PWA/WebAPK
    // (display-mode: standalone / iOS navigator.standalone) or the native
    // Capacitor shell always forwards to the app shell — signed out, /app just
    // bounces to /login. This also covers already-installed WebAPKs whose baked
    // manifest still has the old start_url "/" and any launch navigation that
    // doesn't carry the typed-arrival headers the middleware keys on.
    const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches
      || (navigator as { standalone?: boolean }).standalone === true
      || !!(window as { Capacitor?: unknown }).Capacitor;
    if (standalone) { window.location.replace('/app'); return; }

    const nav = document.getElementById('sp-nav');
    const onScroll = () => {
      nav?.classList.toggle('is-stuck', window.scrollY > 12);
      // Floating "Book a demo" once the hero (and its inline CTA) scrolls away.
      setFab(window.scrollY > 640);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const reveals = Array.from(document.querySelectorAll('.reveal'));
    let io: IntersectionObserver | null = null;
    if ('IntersectionObserver' in window && !reduce) {
      io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io!.unobserve(e.target); } }), { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
      reveals.forEach((el) => io!.observe(el));
    } else reveals.forEach((el) => el.classList.add('in'));

    // count-up
    const counters = Array.from(document.querySelectorAll<HTMLElement>('[data-count]'));
    const animate = (el: HTMLElement) => {
      const target = parseFloat(el.getAttribute('data-count') || '0');
      const dec = parseInt(el.getAttribute('data-decimals') || '0', 10);
      const suffix = el.getAttribute('data-suffix') || '';
      let start: number | null = null;
      const step = (ts: number) => { if (start === null) start = ts; const p = Math.min((ts - start) / 1200, 1); const eased = 1 - Math.pow(1 - p, 3); el.textContent = (target * eased).toFixed(dec) + suffix; if (p < 1) requestAnimationFrame(step); else el.textContent = target.toFixed(dec) + suffix; };
      requestAnimationFrame(step);
    };
    let co: IntersectionObserver | null = null;
    if ('IntersectionObserver' in window && !reduce) {
      co = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { animate(e.target as HTMLElement); co!.unobserve(e.target); } }), { threshold: 0.6 });
      counters.forEach((el) => co!.observe(el));
    }
    return () => { window.removeEventListener('scroll', onScroll); io?.disconnect(); co?.disconnect(); };
  }, []);

  const [menuOpen, setMenuOpen] = useState(false);

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

  return (
    <>
      <Head>
        <title>ResiWalk — Property inspections, pricing &amp; operations for SFR &amp; BTR</title>
        <meta name="description" content="ResiWalk is the property operations platform for SFR & BTR — inspections, real-world pricing, AI reviews, scheduled services, vendor billing, a rules engine, and live insights, in one system." />
        <link rel="canonical" href="https://resiwalk.com/" />
        <meta property="og:type" content="website" />
        <meta property="og:url" content="https://resiwalk.com/" />
        <meta property="og:site_name" content="ResiWalk" />
        <meta property="og:title" content="ResiWalk — The #1 Property Management Tool" />
        <meta property="og:description" content="Every property walk — priced, dispatched & measured. Inspections, real-world pricing, AI reviews, scheduled services, vendor billing, and live insights in one platform." />
        <meta property="og:image" content="https://resiwalk.com/sitepreview/intro-poster.jpg" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="theme-color" content="#FF0066" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Oswald:wght@300;400;500;600;700&family=Raleway:wght@300;400;500;600;700;800&display=swap" rel="stylesheet" />
      </Head>
      {/* eslint-disable-next-line react/no-danger */}
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      <div className="sp">
        {/* NAV */}
        <header className={`nav${menuOpen ? ' is-open' : ''}`} id="sp-nav">
          <div className="wrap-lg nav__in">
            <a href="#top" className="nav__logo" aria-label="ResiWalk home"><img src="/resiwalk-logo.svg" alt="ResiWalk" /></a>
            <nav className="nav__links" aria-label="Primary">
              <a href="#platform">Platform</a><a href="#integrations">Integrations</a><a href="#pricing">Pricing</a><a href="#insights">Insights</a><a href="#faq">FAQ</a>
            </nav>
            <div className="nav__cta">
              <a href="/login" className="nav__login">Log in</a>
              <a href="#contact" className="btn">Book a demo</a>
              <button className="nav__burger" aria-label="Menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}><span></span></button>
            </div>
          </div>
          <div className="nav__mobile" onClick={() => setMenuOpen(false)}>
            <a href="#platform">Platform</a><a href="#integrations">Integrations</a><a href="#pricing">Pricing</a><a href="#insights">Insights</a><a href="/login">Log in</a><a href="#contact" className="btn">Book a demo</a>
          </div>
        </header>
        <a href="#contact" className={`fab${fab ? ' on' : ''}`} aria-hidden={!fab} tabIndex={fab ? 0 : -1}>Book a demo</a>
        <span id="top" />

        {/* HERO */}
        <section className="hero">
          <div className="hero__bg"><div className="hero__grid-lines" /></div>
          <div className="wrap-lg hero__in">
            <div className="hero__copy reveal">
              <span className="badge"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" /></svg> The #1 Property Management Tool</span>
              <h1 className="h1">Every property walk,<br /><span className="lite">priced, dispatched &amp; measured.</span></h1>
              <p className="lead">ResiWalk turns one property walk into finished work. Walk the home once and leave with photos, full estimate pricing, and separate vendor PDFs and scopes of work — every line AI-reviewed and analyzed on site. No back-office admin, no second walk, no extra apps. Fully customizable to how your team works, built by industry veterans for SFR &amp; BTR.</p>
              <div className="hero__cta">
                <a href="#contact" className="btn btn--lg btn--pill">Book a demo</a>
              </div>
            </div>
          </div>
        </section>

        {/* VIDEO — right under the hero, the first thing after Book a demo */}
        <section className="section section--tight section--mist" id="showcase">
          <div className="wrap">
            <div className="section-head center reveal"><Eyebrow icon="play" className="eyebrow eyebrow--center">See it in action</Eyebrow><h2 className="h2">Watch ResiWalk work</h2></div>
            <div className="video-wrap reveal"><video controls playsInline preload="metadata" poster="/sitepreview/intro-poster.jpg"><source src="/sitepreview/resiwalk-intro.mp4" type="video/mp4" /></video></div>
          </div>
        </section>

        {/* TRUST STRIP */}
        <section className="logos" id="platform">
          <div className="wrap">
            <p className="logos__lab">Connected to the systems you already run</p>
            <div className="logos__row reveal">
              <span className="logo-mark"><HubSpotMark className="w-6 h-6" /> HubSpot</span>
              <span className="logo-mark"><DriveMark className="w-6 h-6" /> Google Drive</span>
              <span className="logo-mark"><CalendarMark className="w-6 h-6" /> Calendar</span>
              <span className="logo-mark"><SlackMark className="w-6 h-6" /> Slack</span>
              <span className="logo-mark"><GoogleMark className="w-6 h-6" /> Workspace</span>
            </div>
          </div>
        </section>

        {/* PIPELINE */}
        <section className="section pipeline">
          <div className="wrap">
            <div className="section-head center reveal">
              <Eyebrow icon="platform" className="eyebrow eyebrow--center">One platform</Eyebrow>
              <h2 className="h2">From the first walk to the final invoice</h2>
              <p className="lead">Replace a stack of disconnected tools. ResiWalk runs the entire property-operations lifecycle in one integrated system — no spreadsheets, no handoffs, no re-pricing in the back office.</p>
            </div>
            <div className="pipeline__grid">
              <div className="walkline" aria-hidden="true"><i /><i /></div>
              <div className="stage reveal"><div className="stage__pin"><b>01</b></div><h3 className="stage__t">Inspect</h3><p className="stage__p">Walk each home once. Every room photo-documented and GPS-stamped — online or off, even in dead zones.</p></div>
              <div className="stage reveal d1"><div className="stage__pin"><b>02</b></div><h3 className="stage__t">Price &amp; scope</h3><p className="stage__p">Line items priced instantly against live regional rate cards. Vendor, client, and resident splits resolved on the spot.</p></div>
              <div className="stage reveal d2"><div className="stage__pin"><b>03</b></div><h3 className="stage__t">Dispatch &amp; measure</h3><p className="stage__p">Auto-route approvals, invoice vendors, and watch every walk land in real-time insights the same day.</p></div>
            </div>
          </div>
        </section>

        {/* FEATURES */}
        <section className="section">
          <div className="wrap">
            {/* Inspections */}
            <div className="feature reveal" id="inspections">
              <div className="feature__text">
                <Eyebrow icon="inspections">Field inspections</Eyebrow>
                <h3 className="feature__title">A full suite of inspections, offline-ready</h3>
                <p className="feature__lead">A fully customizable form builder meets — and grows with — your business needs, alongside out-of-the-box Estimate and QC inspection types. Unlimited templates, customization, and possibilities, in one app your field teams actually enjoy — capturing work offline and syncing the instant signal returns.</p>
                <ul className="ticks"><li><Tick />Fully customizable form builder</li><li><Tick />Estimate &amp; QC inspection types out of the box</li><li><Tick />Unlimited templates, customization &amp; possibilities</li><li><Tick />GPS + timestamp evidence on every photo</li></ul>
              </div>
              <div className="feature__media">
                <div className="visual" style={{ display: 'grid', placeItems: 'center' }}>
                  <div className="phone" style={{ position: 'relative', width: 'min(230px,64vw)' }}>
                    <div className="phone__notch" />
                    <div className="phone__screen">
                      <div className="ph-top"><div className="ph-top__t">QC Inspection</div><div className="ph-top__s">1408 Oak Hill Trl · Kitchen</div></div>
                      <div className="ph-body">
                        <div className="ph-shot"><span className="ph-gps">📍 GPS · 33.74,-84.39</span></div>
                        <div className="ph-thumbs"><i /><i /><i /></div>
                        <div className="ph-line"><div className="ph-line__n">Cabinet face — repair</div><div className="ph-line__r"><span>3 EA</span><b>$210.00</b></div></div>
                        <div className="ph-line"><div className="ph-line__n">GFCI outlet — replace</div><div className="ph-line__r"><span>1 EA</span><b>$96.00</b></div></div>
                        <div className="ph-ai">✦ AI: caulk gap at sink → seal</div>
                      </div>
                      <div className="ph-sync"><span className="dot" /> 2 photos queued · will sync</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Pricing */}
            <div className="feature feature--rev reveal" id="pricing-feature">
              <div className="feature__text">
                <Eyebrow icon="pricing">Pricing &amp; scoping</Eyebrow>
                <h3 className="feature__title">Real-world pricing, computed on site</h3>
                <p className="feature__lead">Every line item is priced against live regional rate cards as the inspector scopes — labor, materials, regional adjustments, markup, and resident bill-back resolved instantly. No spreadsheets, no back-office re-pricing, and consistent, defensible numbers every time.</p>
                <ul className="ticks"><li><Tick />Region-aware labor &amp; material rates</li><li><Tick />Instant vendor / client / resident splits</li><li><Tick />One source of truth for cost</li></ul>
              </div>
              <div className="feature__media">
                <div className="visual visual--pink"><div className="card">
                  <div className="card__bar"><div className="card__dots"><i /><i /><i /></div><span className="card__url">app.resiwalk.com/scope</span></div>
                  <div className="card__body">
                    <div className="rc__head"><span className="rc__title">Scope Rate Card</span><span className="rc__region">Region: GA · Atlanta</span></div>
                    <div className="rc__row"><div><div className="rc__n">Replace carpet &amp; pad — Living Room</div><div className="rc__u">480 SF</div></div><span className="rc__p">$842.00</span></div>
                    <div className="rc__row"><div><div className="rc__n">Interior paint — whole home</div><div className="rc__u">2BR / 2BA</div></div><span className="rc__p">$1,960.00</span></div>
                    <div className="rc__row"><div><div className="rc__n">Repair mailbox post</div><div className="rc__u">1 EA</div></div><span className="rc__p">$118.50</span></div>
                    <div className="rc__row"><div><div className="rc__n">Deep clean — turn</div><div className="rc__u">1 EA</div></div><span className="rc__p">$285.00</span></div>
                    <div className="rc__totals"><div className="tot"><div className="tot__v">$2,671</div><div className="tot__l">Vendor</div></div><div className="tot"><div className="tot__v">$3,205</div><div className="tot__l">Client</div></div><div className="tot tot--pink"><div className="tot__v">$1,120</div><div className="tot__l">Resident</div></div></div>
                  </div>
                </div></div>
              </div>
            </div>

            {/* AI */}
            <div className="feature reveal" id="ai">
              <div className="feature__text">
                <Eyebrow icon="ai">AI reviews</Eyebrow>
                <h3 className="feature__title">AI reviews and a self-learning knowledge base</h3>
                <p className="feature__lead">On-device camera and voice AI suggest the right line items and catch issues in the moment, while a knowledge base absorbs every human override to get sharper over time — your standards, encoded and always improving.</p>
                <ul className="ticks"><li><Tick />Photo &amp; voice AI line-item capture</li><li><Tick />Learns from every reviewer override</li><li><Tick />Your playbook, enforced automatically</li></ul>
              </div>
              <div className="feature__media">
                <div className="visual">
                <div className="ai-chip">
                  <div className="ai-chip__top"><span className="ai-dot"><svg width="13" height="13" viewBox="0 0 24 24" fill="#fff"><path d="M12 2l1.9 5.9L20 9.8l-5 3.6L16.2 20 12 16.3 7.8 20 9 13.4 4 9.8l6.1-1.9z" /></svg></span><span className="ai-chip__label">AI review</span></div>
                  <div className="ai-chip__txt">Ceiling water stain → drywall repair + prime &amp; paint</div>
                  <div className="ai-chip__conf"><i /></div>
                  <div className="ai-chip__meta"><span>Confidence 0.94</span><span>Confirm ✓</span></div>
                </div>
                <div className="card"><div className="card__body">
                  <div className="ai-photo"><img src="/sitepreview/photos/ai-inspection.jpg" alt="" loading="lazy" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} /><div className="ai-box"><span className="ai-box__tag">water stain · 0.94</span></div></div>
                  <div className="ai-sugg">
                    <div className="ai-sugg__t"><svg width="13" height="13" viewBox="0 0 24 24" fill="#FF0066"><path d="M12 2l1.9 5.9L20 9.8l-5 3.6L16.2 20 12 16.3 7.8 20 9 13.4 4 9.8l6.1-1.9z" /></svg>Detected · ceiling water stain</div>
                    <div className="ai-sugg__m">Suggested: drywall repair + prime &amp; paint</div>
                    <div className="ai-sugg__bar"><i /></div>
                    <div className="ai-sugg__row"><span className="ai-sugg__conf">Confidence 0.94</span><div className="mini-btns"><button className="mini-btn" type="button">Adjust</button><button className="mini-btn mini-btn--go" type="button">Confirm</button></div></div>
                  </div>
                </div></div></div>
              </div>
            </div>

            {/* Services */}
            <div className="feature feature--rev reveal" id="services">
              <div className="feature__text">
                <Eyebrow icon="services">Services &amp; vendors</Eyebrow>
                <h3 className="feature__title">Scheduled services, vendors &amp; billing</h3>
                <p className="feature__lead">Bring recurring services in-house — grass, cleans, pools — with a scheduling engine, vendor dispatch and rotation, field-evidenced completion, and clean vendor and client billing end to end. Replace the middlemen without losing the controls.</p>
                <ul className="ticks"><li><Tick />Recurring scheduling &amp; vendor rotation</li><li><Tick />Field-evidenced completion</li><li><Tick />Vendor + client invoicing built in</li></ul>
              </div>
              <div className="feature__media">
                <div className="visual"><div className="card"><div className="card__body">
                  <div className="svc__head"><span className="svc__title">Recurring Services</span><span className="svc__sub">This month · 3,412</span></div>
                  <div className="svc-row"><span className="svc-row__n">Grass cut</span><span className="svc-row__c">Biweekly</span><span className="svc-row__v">GreenPro LLC</span><span className="pill pill--sch">Scheduled</span></div>
                  <div className="svc-row"><span className="svc-row__n">Pool service</span><span className="svc-row__c">Weekly</span><span className="svc-row__v">AquaCare</span><span className="pill pill--dis">Dispatched</span></div>
                  <div className="svc-row"><span className="svc-row__n">Turn clean</span><span className="svc-row__c">On turn</span><span className="svc-row__v">SparkleCo</span><span className="pill pill--inv">Invoiced</span></div>
                  <div className="svc-row"><span className="svc-row__n">Gutter clean</span><span className="svc-row__c">Quarterly</span><span className="svc-row__v">PeakClean</span><span className="pill pill--asn">Assigned</span></div>
                  <div className="svc__foot"><span>On-time completion</span><b>98%</b></div>
                </div></div></div>
              </div>
            </div>

            {/* Rules */}
            <div className="feature reveal" id="rules">
              <div className="feature__text">
                <Eyebrow icon="rules">Rules engine</Eyebrow>
                <h3 className="feature__title">An integrated, no-code rules engine</h3>
                <p className="feature__lead">Codify how your business actually runs: NTE-based approval routing by dollar and region, condition-driven automations, escalation ladders, and service triggers — all configurable and fully auditable.</p>
                <ul className="ticks"><li><Tick />NTE-based approval routing</li><li><Tick />Condition-driven automations</li><li><Tick />Every decision auditable</li></ul>
              </div>
              <div className="feature__media">
                <div className="visual visual--pink"><div className="card"><div className="card__body">
                  <div className="ladder__cap">Approval routing · when scope &gt; NTE</div>
                  <div className="rung"><span className="rung__cond">≤ Region NTE</span><span className="rung__then">tag <b>PM + Sr. PM</b></span></div>
                  <div className="rung-link"><svg width="16" height="20" viewBox="0 0 16 20" fill="none"><path d="M8 2v14m0 0l-4-4m4 4l4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg></div>
                  <div className="rung"><span className="rung__cond">≤ RM ceiling</span><span className="rung__then">tag <b>RM</b></span></div>
                  <div className="rung-link"><svg width="16" height="20" viewBox="0 0 16 20" fill="none"><path d="M8 2v14m0 0l-4-4m4 4l4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg></div>
                  <div className="rung rung--esc"><span className="rung__cond">Above ceiling</span><span className="rung__then">escalate → <b>directors</b></span></div>
                </div></div></div>
              </div>
            </div>
          </div>
        </section>

        {/* IN THE FIELD (photos) */}
        <section className="section section--mist">
          <div className="wrap">
            <div className="section-head center reveal"><Eyebrow icon="field" className="eyebrow eyebrow--center">In the field</Eyebrow><h2 className="h2">Built for the people who walk the homes</h2><p className="lead">From turn scopes to recurring services, ResiWalk goes where your teams go — every home, every market.</p></div>
            <div className="gallery">
              <PhotoTile src="/sitepreview/photos/field-1.jpg" caption="Scoping a turn, on-site" />
              <PhotoTile src="/sitepreview/photos/field-2.jpg" caption="Documenting a finding with photo evidence" />
              <PhotoTile src="/sitepreview/photos/field-3.jpg" caption="Vendor completing a scheduled service" />
            </div>
          </div>
        </section>

        {/* INSIGHTS */}
        <section className="section pipeline" id="insights">
          <div className="wrap">
            <div className="section-head center reveal"><Eyebrow icon="insights" className="eyebrow eyebrow--center">Insights</Eyebrow><h2 className="h2">A full-service insights command center</h2><p className="lead">Live analytics across inspections, pass/fail trends, scope cost, inspector performance, AI acceptance, and service throughput — banked daily and sliced by region, program, and person. Exec-ready and always current.</p></div>
            <div className="insights-wrap reveal"><div className="dash">
              <div className="dash__bar"><div className="dash__dots"><i /><i /><i /></div><span className="dash__url">app.resiwalk.com/insights</span></div>
              <div className="dash__body">
                <div className="dash__top"><span className="dash__title">ResiWalk Insights</span><div className="tabs"><span className="on">GA</span><span>FL</span><span>NC</span></div></div>
                <div className="kpis"><div className="kpi kpi--hi"><div className="kpi__v">96.4%</div><div className="kpi__l">Pass rate</div></div><div className="kpi"><div className="kpi__v">$1,284</div><div className="kpi__l">Avg scope</div></div><div className="kpi"><div className="kpi__v">1,208</div><div className="kpi__l">Completed</div></div><div className="kpi"><div className="kpi__v">98%</div><div className="kpi__l">On-time</div></div></div>
                <div className="dash__charts">
                  <div className="panel"><div className="panel__t">Scope cost by category</div><div className="bars"><div className="bar"><div className="bar__fill" style={{ height: '88%' }} /><span className="bar__l">Paint</span></div><div className="bar"><div className="bar__fill" style={{ height: '66%' }} /><span className="bar__l">Flooring</span></div><div className="bar"><div className="bar__fill" style={{ height: '41%' }} /><span className="bar__l">Clean</span></div><div className="bar"><div className="bar__fill" style={{ height: '54%' }} /><span className="bar__l">Landscape</span></div></div></div>
                  <div className="panel"><div className="panel__t">Inspection pass rate</div><div className="donut"><div className="donut__c"><svg width="120" height="120" viewBox="0 0 120 120"><circle cx="60" cy="60" r="48" fill="none" stroke="rgba(255,255,255,.1)" strokeWidth="13" /><circle cx="60" cy="60" r="48" fill="none" stroke="#73E3DF" strokeWidth="13" strokeLinecap="round" strokeDasharray="301.6" strokeDashoffset="10.8" transform="rotate(-90 60 60)" /></svg><div className="donut__mid"><div><div className="donut__v">96.4%</div><div className="donut__l">Pass</div></div></div></div></div></div>
                </div>
              </div>
            </div></div>
          </div>
        </section>

        {/* SCALE BAND */}
        <section className="section band">
          <div className="wrap band__in">
            <div className="reveal">
              <Eyebrow icon="scale" className="eyebrow eyebrow--light">Built for scale</Eyebrow>
              <h2 className="h2">One command center, any market</h2>
              <p className="lead">Whether it&apos;s 600 doors or 60,000, ResiWalk keeps pricing consistent, dispatch fast, and leadership looking at the same verified numbers your field teams generate — anywhere you operate.</p>
              <div className="markets"><span className="market">SFR</span><span className="market">BTR</span><span className="market">Scattered-site</span><span className="market">Communities</span><span className="market market--more">Any market — anywhere</span></div>
            </div>
            <div className="metrics reveal d1">
              <div className="metric"><div className="metric__v metric__v--sm">2.6d&nbsp;→&nbsp;0.1d</div><div className="metric__l">Scope-to-ticket</div></div>
              <div className="metric"><div className="metric__v" data-count="98" data-suffix="%">98%</div><div className="metric__l">Services on-time</div></div>
              <div className="metric"><div className="metric__v" data-count="91" data-suffix="%">91%</div><div className="metric__l">AI acceptance</div></div>
              <div className="metric"><div className="metric__v">Anywhere</div><div className="metric__l">Any market, any state</div></div>
            </div>
          </div>
        </section>

        {/* INTEGRATIONS */}
        <section className="section" id="integrations">
          <div className="wrap">
            <div className="section-head center reveal"><Eyebrow icon="integrations" className="eyebrow eyebrow--center">Integrations</Eyebrow><h2 className="h2">Connected to the tools you already run</h2><p className="lead">ResiWalk is the connective tissue of your operation — data flows cleanly across your CRM, storage, calendar, and comms, automatically.</p></div>
            <div className="int-grid reveal">
              <div className="int-card"><div className="int-card__ico"><HubSpotMark className="w-7 h-7" /></div><div className="int-card__cat">CRM</div><h3>HubSpot</h3><p>Properties, listings, tickets &amp; workflows — your system of record.</p></div>
              <div className="int-card"><div className="int-card__ico"><DriveMark className="w-7 h-7" /></div><div className="int-card__cat">Storage</div><h3>Google Drive</h3><p>Reports, evidence &amp; documents synced where your teams work.</p></div>
              <div className="int-card"><div className="int-card__ico"><CalendarMark className="w-7 h-7" /></div><div className="int-card__cat">Scheduling</div><h3>Google Calendar</h3><p>Service scheduling &amp; dispatch on the right calendars.</p></div>
              <div className="int-card"><div className="int-card__ico"><GoogleMark className="w-7 h-7" /></div><div className="int-card__cat">Identity / SSO</div><h3>Google Workspace</h3><p>Single sign-on and identity for your staff.</p></div>
              <div className="int-card"><div className="int-card__ico"><SlackMark className="w-7 h-7" /></div><div className="int-card__cat">Communication</div><h3>Slack</h3><p>Approvals, dispatch alerts &amp; a conversational assistant.</p></div>
              <div className="int-card"><div className="int-card__ico"><span style={{ fontWeight: 800, fontSize: '.8rem', color: '#0A0A0A' }}>RC</span></div><div className="int-card__cat">Market data</div><h3>RentCast</h3><p>Live market comps to inform listing &amp; scoping decisions.</p></div>
              <div className="int-card"><div className="int-card__ico"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M14.7 6.3a4 4 0 00-5.5 5.5l-6 6L5 19.3l6-6a4 4 0 005.5-5.5l-2.4 2.4-1.8-1.8 2.4-2.1z" stroke="#FF0066" strokeWidth="1.6" strokeLinejoin="round" /></svg></div><div className="int-card__cat">Work orders</div><h3>Maintenance / MM</h3><p>Two-way work-order &amp; ticket sync with your MM stack.</p></div>
              <div className="int-card int-card--cta"><h3>API-first</h3><p>Build your own. Tell us the next integration on your roadmap.</p><a href="#contact">Request an integration →</a></div>
            </div>
          </div>
        </section>

        {/* PRICING */}
        <section className="section section--mist" id="pricing">
          <div className="wrap">
            <div className="section-head center reveal"><Eyebrow icon="tiers" className="eyebrow eyebrow--center">Pricing</Eyebrow><h2 className="h2">Pricing that scales with your portfolio</h2><p className="lead">Per-door, not per-seat — so your whole field team is in without a headcount penalty. Pick the tier that fits where you are today.</p></div>
            <div className="price-grid reveal">
              <div className="tier">
                <h3 className="tier__name">Growth</h3><p className="tier__desc">Emerging portfolios getting field ops under control.</p>
                <div className="tier__price"><b>Custom</b><span>/ per door</span></div>
                <ul className="tier__list"><li><TierCheck c="#0FB5AD" />Core inspection templates</li><li><TierCheck c="#0FB5AD" />Real-world rate-card pricing</li><li><TierCheck c="#0FB5AD" />Offline field app + evidence</li><li><TierCheck c="#0FB5AD" />Standard integrations</li><li><TierCheck c="#0FB5AD" />Email support</li></ul>
                <a href="#contact" className="btn btn--ghost">Book a demo</a>
              </div>
              <div className="tier tier--pop">
                <span className="tier__badge">Most popular</span>
                <h3 className="tier__name">Professional</h3><p className="tier__desc">Scaling operators standardizing across markets.</p>
                <div className="tier__price"><b>Custom</b><span>/ per door</span></div>
                <ul className="tier__list"><li><TierCheck c="#FF0066" />Everything in Growth</li><li><TierCheck c="#FF0066" />AI reviews + knowledge base</li><li><TierCheck c="#FF0066" />Scheduled services &amp; vendor billing</li><li><TierCheck c="#FF0066" />Rules engine + approval routing</li><li><TierCheck c="#FF0066" />Insights dashboard</li><li><TierCheck c="#FF0066" />Priority support</li></ul>
                <a href="#contact" className="btn">Book a demo</a>
              </div>
              <div className="tier">
                <h3 className="tier__name">Enterprise</h3><p className="tier__desc">National portfolios that need it all, governed.</p>
                <div className="tier__price"><b>Custom</b><span>/ per door</span></div>
                <ul className="tier__list"><li><TierCheck c="#0FB5AD" />Everything in Professional</li><li><TierCheck c="#0FB5AD" />SSO &amp; role-based access</li><li><TierCheck c="#0FB5AD" />Custom templates &amp; workflows</li><li><TierCheck c="#0FB5AD" />Dedicated success manager</li><li><TierCheck c="#0FB5AD" />SLA &amp; onboarding services</li><li><TierCheck c="#0FB5AD" />API &amp; custom integrations</li></ul>
                <a href="#contact" className="btn btn--ghost">Book a demo</a>
              </div>
            </div>
            <p className="price-note">Every plan includes unlimited photos, the offline field app, and evidence storage. Volume &amp; multi-brand pricing available.</p>
          </div>
        </section>

        {/* SECURITY */}
        <section className="section">
          <div className="wrap">
            <div className="section-head center reveal"><Eyebrow icon="security" className="eyebrow eyebrow--center">Security &amp; governance</Eyebrow><h2 className="h2">Built to enterprise standards</h2><p className="lead">The controls large operators require — access, attribution, data ownership, and integrity — baked in from day one.</p></div>
            <div className="sec-grid reveal">
              <div className="sec-card"><div className="sec-card__ico"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="5" y="10" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.8" /><path d="M8 10V7a4 4 0 018 0v3" stroke="currentColor" strokeWidth="1.8" /></svg></div><h3>Role-based access &amp; audit trails</h3><p>Every action attributed and logged — who did what, and when.</p></div>
              <div className="sec-card"><div className="sec-card__ico"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M4 7v10c0 2 3.6 3 8 3s8-1 8-3V7" stroke="currentColor" strokeWidth="1.8" /><ellipse cx="12" cy="7" rx="8" ry="3" stroke="currentColor" strokeWidth="1.8" /></svg></div><h3>Your data, your system of record</h3><p>Syncs to your HubSpot and Drive — you own it, always.</p></div>
              <div className="sec-card"><div className="sec-card__ico"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="1.8" /><path d="M5 20c0-3.3 3.1-5 7-5s7 1.7 7 5" stroke="currentColor" strokeWidth="1.8" /></svg></div><h3>SSO via Google Workspace</h3><p>One identity for your staff; provision and revoke centrally.</p></div>
              <div className="sec-card"><div className="sec-card__ico"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /><path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg></div><h3>Evidence integrity</h3><p>GPS- and time-stamped photos make findings defensible.</p></div>
            </div>
          </div>
        </section>

        {/* TESTIMONIAL */}
        <section className="section section--mist">
          <div className="wrap">
            <blockquote className="quote reveal"><p className="quote__t"><span className="qm">&ldquo;</span>We went from re-pricing scopes for days to dispatched, invoiced work the same afternoon — with the whole portfolio visible in one dashboard.<span className="qm">&rdquo;</span></p><div className="quote__by">Mentor Sokoli · <span>President, ResiHome</span></div></blockquote>
          </div>
        </section>

        {/* ABOUT */}
        <section className="section about">
          <div className="wrap about__in reveal">
            <Eyebrow icon="teams" className="eyebrow eyebrow--light">Why teams switch</Eyebrow>
            <h2 className="h2">Designed, built, and managed by industry veterans — for the SFR &amp; BTR demands of today and tomorrow.</h2>
            <p>We&apos;ve run the portfolios, walked the homes, and chased the invoices. ResiWalk is the platform we always wished we had — now yours.</p>
          </div>
        </section>

        {/* FAQ */}
        <section className="section" id="faq">
          <div className="wrap">
            <div className="section-head center reveal"><Eyebrow icon="faq" className="eyebrow eyebrow--center">FAQ</Eyebrow><h2 className="h2">Questions, answered</h2></div>
            <div className="faq reveal">
              <details open><summary>How does offline capture actually work?</summary><div className="faq__a">Field teams walk and document homes with no connection required — photos, line items, and GPS stamps are stored on-device and sync automatically the moment signal returns. Nothing is lost in a dead zone.</div></details>
              <details><summary>Which inspection types are supported?</summary><div className="faq__a">Any you need. ResiWalk ships with Estimate and QC inspection types out of the box, and a fully customizable form builder lets you create unlimited templates of your own — so inspections meet, and grow with, your business needs.</div></details>
              <details><summary>Where does pricing come from?</summary><div className="faq__a">Every line item is priced against live, region-aware rate cards as the inspector scopes — labor, materials, regional adjustments, markup, and vendor/client/resident splits are resolved on-site, so the numbers are consistent and defensible every time.</div></details>
              <details><summary>Do we keep our own system of record?</summary><div className="faq__a">Yes. ResiWalk syncs cleanly into your HubSpot and Google Drive. Your properties, evidence, and reports live in the systems you already own — ResiWalk is the connective tissue, not a walled garden.</div></details>
              <details><summary>How is pricing structured?</summary><div className="faq__a">Per-door, not per-seat — so your entire field team is included without a headcount penalty. Volume and multi-brand pricing is available; book a demo and we&apos;ll scope it to your portfolio.</div></details>
              <details><summary>How fast can we get live?</summary><div className="faq__a">Onboarding is scoped to your regions and templates. Standard integrations and core inspection types can be running quickly; Enterprise onboarding includes custom templates, SSO, and a dedicated success manager.</div></details>
            </div>
          </div>
        </section>

        {/* CONTACT */}
        <section className="section section--mist" id="contact">
          <div className="wrap">
            <div className="contact">
              <div className="reveal">
                <Eyebrow icon="contact">Contact us</Eyebrow>
                <h2 className="h2">Let&apos;s walk your portfolio forward</h2>
                <p className="lead">Tell us about your operation and we&apos;ll show you exactly how ResiWalk fits — inspections, pricing, services, and the analytics tying it all together.</p>
                <ul className="ticks"><li><Tick />A tailored walkthrough of the platform</li><li><Tick />Real pricing &amp; scoping on your regions</li><li><Tick />A migration path from your current tools</li></ul>
              </div>
              <form className="contact__form reveal d1" onSubmit={onSubmit}>
                {status === 'sent' && <div className="form-msg form-msg--ok">Thanks — we&apos;ll be in touch shortly to schedule your walkthrough.</div>}
                {status === 'error' && <div className="form-msg form-msg--err">{error}</div>}
                <input type="text" name="website" tabIndex={-1} autoComplete="off" style={{ display: 'none' }} aria-hidden />
                <div className="field-row">
                  <div className="field"><label htmlFor="c-name">Name <span>*</span></label><input id="c-name" name="name" type="text" required placeholder="Your name" /></div>
                  <div className="field"><label htmlFor="c-co">Company</label><input id="c-co" name="company" type="text" placeholder="Company" /></div>
                </div>
                <div className="field-row">
                  <div className="field"><label htmlFor="c-email">Email <span>*</span></label><input id="c-email" name="email" type="email" required placeholder="you@company.com" /></div>
                  <div className="field"><label htmlFor="c-phone">Phone</label><input id="c-phone" name="phone" type="tel" placeholder="(555) 555-5555" /></div>
                </div>
                <div className="field"><label htmlFor="c-msg">How can we help? <span>*</span></label><textarea id="c-msg" name="message" required placeholder="Tell us about your portfolio and markets…" /></div>
                <button className="btn btn--lg" type="submit" style={{ width: '100%' }} disabled={status === 'sending'}>{status === 'sending' ? 'Sending…' : 'Send message'}</button>
                <p className="form-note">We&apos;ll only use your details to respond to this inquiry.</p>
              </form>
            </div>
          </div>
        </section>

        {/* FINAL CTA */}
        <section className="section final">
          <div className="wrap final__in reveal">
            <h2 className="h2">Ready to see ResiWalk in action?</h2>
            <p>Give your teams the platform that turns every property walk into priced, dispatched, and measured work — automatically.</p>
            <div className="final__cta"><a href="#contact" className="btn btn--light btn--lg">Book a demo</a><a href="/login" className="btn btn--ghost-light btn--lg">Log in</a></div>
          </div>
        </section>

        {/* FOOTER */}
        <footer className="foot">
          <div className="wrap-lg">
            <div className="foot__top">
              <div className="foot__brand"><img src="/resiwalk-logo.svg" alt="ResiWalk" style={{ filter: 'brightness(0) invert(1)' }} /><p>The full-suite property inspection, vendor management, and services platform — built by industry veterans for the SFR &amp; BTR demands of today and tomorrow.</p></div>
              <div><h4>Platform</h4><ul><li><a href="#inspections">Inspections</a></li><li><a href="#pricing-feature">Pricing &amp; scoping</a></li><li><a href="#ai">AI reviews</a></li><li><a href="#services">Services &amp; vendors</a></li><li><a href="#insights">Insights</a></li></ul></div>
              <div><h4>Resources</h4><ul><li><a href="#faq">FAQ</a></li><li><a href="#integrations">Integrations</a></li><li><a href="#contact">Contact us</a></li></ul></div>
              <div><h4>Company</h4><ul><li><a href="/login">Log in</a></li><li><a href="#contact">Book a demo</a></li><li><a href="#platform">Built for SFR &amp; BTR</a></li></ul></div>
            </div>
            <div className="foot__bottom"><span>© {new Date().getFullYear()} ResiHome / ResiWalk. All rights reserved.</span><span className="foot__tag">Enterprise property operations, reimagined.</span></div>
          </div>
        </footer>
      </div>
    </>
  );
}
