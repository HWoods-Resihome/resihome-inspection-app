#!/usr/bin/env node
/**
 * Web ↔ native parity check (a REMINDER, not a blocker).
 *
 * CLAUDE.md rule: some web changes (new device capability, a deep-link/OAuth
 * change, a new Capacitor plugin) silently break on a real device unless a
 * matching change lands in the native shell (mobile/android/...). This scans the
 * ADDED lines of a diff for those signals and prints a reminder of the native
 * file(s) to update, so the parity step isn't forgotten in review.
 *
 * Usage:
 *   node scripts/check-native-parity.mjs [baseRef]
 *   BASE_REF=origin/main node scripts/check-native-parity.mjs
 *   (pass --strict to exit non-zero on a finding; default is warn-only)
 *
 * Only WEB paths are scanned (the native project itself is exempt).
 */
import { execSync } from 'node:child_process';

const STRICT = process.argv.includes('--strict');
const baseArg = process.argv.find((a, i) => i >= 2 && !a.startsWith('--'));
const inCI = !!process.env.GITHUB_ACTIONS;

// Web paths that ship to the live site (mobile/ is the native shell — exempt).
const WEB_PATHS = ['pages', 'components', 'lib', 'styles', 'middleware.ts'];

// Each rule: a signal in web code → the matching native change CLAUDE.md wants.
const RULES = [
  {
    re: /getUserMedia|navigator\.mediaDevices/,
    cap: 'Camera / microphone (getUserMedia)',
    native: 'AndroidManifest.xml: CAMERA + RECORD_AUDIO (+ MODIFY_AUDIO_SETTINGS); iOS Info.plist usage strings',
  },
  {
    re: /navigator\.geolocation|getCurrentPosition|watchPosition/,
    cap: 'Geolocation',
    native: 'AndroidManifest.xml: ACCESS_FINE_LOCATION + ACCESS_COARSE_LOCATION; iOS location usage strings',
  },
  {
    re: /resiwalk:\/\/|intent-filter|auth-callback/,
    cap: 'Custom scheme / deep link / OAuth return',
    native: 'MainActivity.java deep-link handling + <intent-filter> in AndroidManifest.xml',
  },
  {
    re: /from ['"]@capacitor\/|require\(['"]@capacitor\//,
    cap: 'Capacitor plugin / native API usage',
    native: 'mobile/package.json, then `npx cap sync android`',
  },
];

function resolveBase() {
  const candidates = [baseArg, process.env.BASE_REF, 'origin/main', 'HEAD~1'].filter(Boolean);
  for (const ref of candidates) {
    try {
      execSync(`git rev-parse --verify --quiet ${ref}^{commit}`, { stdio: 'ignore' });
      return ref;
    } catch { /* try next */ }
  }
  return null;
}

function addedLines(base) {
  // --unified=0 so we only see changed lines; keep just ADDED lines ('+', not '+++').
  let raw = '';
  try {
    raw = execSync(`git diff --unified=0 ${base}...HEAD -- ${WEB_PATHS.join(' ')}`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    // Fall back to a two-dot diff if the merge-base form isn't available.
    try { raw = execSync(`git diff --unified=0 ${base} -- ${WEB_PATHS.join(' ')}`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
    catch { return []; }
  }
  const out = [];
  let file = '';
  for (const line of raw.split('\n')) {
    if (line.startsWith('+++ b/')) file = line.slice(6);
    else if (line.startsWith('+') && !line.startsWith('+++')) out.push({ file, text: line.slice(1) });
  }
  return out;
}

const base = resolveBase();
if (!base) {
  console.log('[native-parity] no base ref to diff against — skipping.');
  process.exit(0);
}

const added = addedLines(base);
const findings = [];
for (const { file, text } of added) {
  for (const rule of RULES) {
    if (rule.re.test(text)) findings.push({ file, cap: rule.cap, native: rule.native });
  }
}

// De-dupe by file+capability.
const seen = new Set();
const unique = findings.filter((f) => {
  const k = `${f.file}::${f.cap}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

if (unique.length === 0) {
  console.log(`[native-parity] no device-capability/deep-link/plugin changes vs ${base}. ✅`);
  process.exit(0);
}

console.log(`\n[native-parity] ${unique.length} change(s) may need a matching NATIVE update (see CLAUDE.md → Web↔Mobile parity checklist):\n`);
for (const f of unique) {
  const msg = `${f.file}: ${f.cap} → update ${f.native}`;
  if (inCI) console.log(`::warning file=${f.file}::Native parity: ${f.cap} → ${f.native}`);
  console.log(`  • ${msg}`);
}
console.log('\nIf the matching native change is already done (or none is needed), ignore this reminder.\n');

process.exit(STRICT ? 1 : 0);
