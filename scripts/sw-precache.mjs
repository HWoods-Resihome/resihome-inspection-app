// Build-time generator for the service-worker PRECACHE manifest.
//
// The field app must open + render inspections OFFLINE, including on a cold
// start (app relaunched with no signal). Next.js code-splits per route AND lazy-
// loads the big forms via next/dynamic (RateCardForm / QuestionForm /
// QcReinspectForm are separate chunks). The hand-written SW only caches assets
// AFTER it takes control, so first-load + never-fetched dynamic chunks are absent
// offline → the inspection page mounts but the form chunk can't load and it
// hangs on the spinner (the offline bug).
//
// Fix: enumerate EVERY built JS/CSS chunk (the whole bundle is ~2MB, trivial to
// cache) and write it to public/sw-precache.json. The SW fetches this at install
// (while online, right after a deploy) and caches them all, so every route +
// dynamic form renders offline thereafter. Runs as part of `next build`.

import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const nextDir = join(root, '.next');
const staticDir = join(nextDir, 'static');

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

const assets = [];
if (existsSync(staticDir)) {
  for (const file of walk(staticDir)) {
    if (/\.(js|css)$/.test(file)) {
      const rel = relative(nextDir, file).split(/[\\/]/).join('/'); // e.g. static/chunks/....js
      assets.push('/_next/' + rel);
    }
  }
}

const buildId = existsSync(join(nextDir, 'BUILD_ID'))
  ? readFileSync(join(nextDir, 'BUILD_ID'), 'utf8').trim()
  : String(Date.now());

// Emit as a .JS file (not .json): the service worker pulls it via importScripts,
// and `.js` is already a PUBLIC static path in middleware.ts (isStaticAsset), so
// the SW's install-time load never hits the auth gate that silently broke the
// JSON fetch on the deployed site. Vercel serves files written to public/ during
// the build.
const js = `self.__SW_PRECACHE=${JSON.stringify(assets)};self.__SW_PRECACHE_BUILD=${JSON.stringify(buildId)};`;
writeFileSync(join(root, 'public', 'sw-precache.js'), js);
console.log(`[sw-precache] wrote ${assets.length} assets for build ${buildId}`);
