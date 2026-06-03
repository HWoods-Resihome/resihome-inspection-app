// Server-only: upload PDFs into a HoneyBadger maintenance ticket by driving the
// web UI with a headless browser (the External API has no attachment endpoint).
//
// Runs puppeteer-core + @sparticuz/chromium inside our own serverless function
// (Vercel Pro). Logs in with username/password (env), opens the ticket's Edit
// page, clicks "Upload Document", sets the hidden file input with the
// downloaded PDFs (no OS dialog), clicks "Upload", and waits for completion.
//
// Never throws — returns a step-by-step log (+ a failure screenshot) so we can
// tune selectors via env without redeploying.
//
// Required env:
//   HBMM_USERNAME, HBMM_PASSWORD          login credentials
// Optional env (sensible defaults; override to tune without a deploy):
//   HBMM_LOGIN_URL            default https://honeybadgermm.com/
//   HBMM_SEL_USERNAME         CSS selector for the username/email field
//   HBMM_SEL_PASSWORD         CSS selector for the password field
//   HBMM_SEL_SUBMIT           CSS selector for the login submit button
//   HBMM_SEL_UPLOAD_DOC       selector/text for the "Upload Document" button
//   HBMM_SEL_FILE_INPUT       CSS selector for the file <input>
//   HBMM_SEL_UPLOAD_BTN       selector/text for the modal "Upload" button
//   HBMM_NAV_TIMEOUT_MS       per-step timeout (default 30000)

import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildTicketUrl } from '@/lib/maintenanceAi';

export interface TicketUploadFile { name: string; url: string }
export interface TicketUploadResult {
  ok: boolean;
  configured: boolean;
  uploaded: number;
  steps: string[];
  error?: string;
  /** base64 PNG of the page at the point of failure (for selector tuning). */
  screenshot?: string;
}

const DEFAULTS = {
  loginUrl: 'https://honeybadgermm.com/',
  selUsername: 'input[type="email"], input[name="username"], input[name="email"], input#username, input#email',
  selPassword: 'input[type="password"], input[name="password"], input#password',
  selSubmit: 'button[type="submit"], button::-p-text(Log In), button::-p-text(Login), button::-p-text(Sign In)',
  selUploadDoc: '::-p-text(Upload Document)',
  selFileInput: 'input[type="file"]',
  selUploadBtn: 'button::-p-text(Upload)',
  navTimeout: 30000,
};

function env(name: string, fallback: string): string {
  const v = (process.env[name] || '').trim();
  return v || fallback;
}

async function downloadToTmp(file: TicketUploadFile, dir: string, idx: number): Promise<string> {
  const resp = await fetch(file.url);
  if (!resp.ok) throw new Error(`download ${file.name} failed: HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  // Keep a clean, real filename (the UI shows it on the ticket).
  const safe = (file.name || `document-${idx}.pdf`).replace(/[\\/:*?"<>|]+/g, '_');
  const p = path.join(dir, safe);
  fs.writeFileSync(p, buf);
  return p;
}

/**
 * Upload the given files to a ticket via the HoneyBadger UI. Best-effort.
 */
export async function uploadTicketDocuments(args: { ticketId: number; files: TicketUploadFile[] }): Promise<TicketUploadResult> {
  const steps: string[] = [];
  const log = (s: string) => { steps.push(s); };

  const username = (process.env.HBMM_USERNAME || '').trim();
  const password = process.env.HBMM_PASSWORD || '';
  if (!username || !password) {
    return { ok: false, configured: false, uploaded: 0, steps, error: 'Browser upload not configured (set HBMM_USERNAME / HBMM_PASSWORD).' };
  }
  if (!args.files.length) {
    return { ok: false, configured: true, uploaded: 0, steps, error: 'No files to upload.' };
  }

  const loginUrl = env('HBMM_LOGIN_URL', DEFAULTS.loginUrl);
  const selUsername = env('HBMM_SEL_USERNAME', DEFAULTS.selUsername);
  const selPassword = env('HBMM_SEL_PASSWORD', DEFAULTS.selPassword);
  const selSubmit = env('HBMM_SEL_SUBMIT', DEFAULTS.selSubmit);
  const selUploadDoc = env('HBMM_SEL_UPLOAD_DOC', DEFAULTS.selUploadDoc);
  const selFileInput = env('HBMM_SEL_FILE_INPUT', DEFAULTS.selFileInput);
  const selUploadBtn = env('HBMM_SEL_UPLOAD_BTN', DEFAULTS.selUploadBtn);
  const navTimeout = Number(process.env.HBMM_NAV_TIMEOUT_MS || DEFAULTS.navTimeout) || DEFAULTS.navTimeout;
  const ticketUrl = buildTicketUrl(args.ticketId);
  if (!ticketUrl) {
    return { ok: false, configured: true, uploaded: 0, steps, error: 'Could not build ticket URL.' };
  }

  // @sparticuz/chromium only extracts its bundled shared libs (libnss3, etc.)
  // and sets LD_LIBRARY_PATH when it detects an AWS Lambda runtime via
  // AWS_EXECUTION_ENV — and it does so AT IMPORT TIME. Vercel runs on Lambda
  // but doesn't set that var the way the package expects, so we set it ourselves
  // (matching the running Node major version) BEFORE importing the package, so
  // the right tarball (al2 for <20, al2023 for 20.x/22.x) is extracted.
  if (!process.env.AWS_EXECUTION_ENV) {
    const major = parseInt(process.version.replace(/^v/, ''), 10) || 20;
    process.env.AWS_EXECUTION_ENV = `AWS_Lambda_nodejs${major}.x`;
    log(`set AWS_EXECUTION_ENV=${process.env.AWS_EXECUTION_ENV}`);
  }

  // Dynamic imports so these heavy deps never enter a non-upload code path.
  const [{ default: puppeteer }, { default: chromium }] = await Promise.all([
    import('puppeteer-core'),
    import('@sparticuz/chromium'),
  ]);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hbmm-'));
  let browser: any = null;
  let page: any = null;
  const screenshotB64 = async (): Promise<string | undefined> => {
    try {
      if (!page) return undefined;
      const b = await page.screenshot({ type: 'png', fullPage: false });
      return `data:image/png;base64,${Buffer.from(b).toString('base64')}`;
    } catch { return undefined; }
  };

  try {
    // 1. Download the files locally.
    const localPaths: string[] = [];
    for (let i = 0; i < args.files.length; i++) {
      localPaths.push(await downloadToTmp(args.files[i], tmpDir, i));
    }
    log(`downloaded ${localPaths.length} file(s)`);

    // 2. Launch headless Chromium.
    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      defaultViewport: chromium.defaultViewport || { width: 1280, height: 900 },
    });
    page = await browser.newPage();
    page.setDefaultTimeout(navTimeout);
    page.setDefaultNavigationTimeout(navTimeout);
    log('launched browser');

    // 3. Log in.
    await page.goto(loginUrl, { waitUntil: 'networkidle2' });
    log(`opened login (${loginUrl})`);
    await page.waitForSelector(selUsername, { timeout: navTimeout });
    await page.type(selUsername, username, { delay: 15 });
    await page.type(selPassword, password, { delay: 15 });
    log('entered credentials');
    await Promise.all([
      page.click(selSubmit).catch(() => page.keyboard.press('Enter')),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: navTimeout }).catch(() => {}),
    ]);
    log('submitted login');

    // 4. Open the ticket's Edit page.
    await page.goto(ticketUrl, { waitUntil: 'networkidle2' });
    log(`opened ticket (${ticketUrl})`);

    // 5. Click "Upload Document".
    await page.waitForSelector(selUploadDoc, { timeout: navTimeout });
    await page.click(selUploadDoc);
    log('clicked Upload Document');

    // 6. Set the hidden file input with all files (no OS dialog).
    await page.waitForSelector(selFileInput, { timeout: navTimeout });
    const input = await page.$(selFileInput);
    if (!input) throw new Error(`file input not found (${selFileInput})`);
    await input.uploadFile(...localPaths);
    log(`attached ${localPaths.length} file(s) to the input`);

    // 7. Click "Upload" and give the upload time to complete.
    await page.click(selUploadBtn);
    log('clicked Upload');
    await new Promise((r) => setTimeout(r, 6000));
    log('waited for upload to finish');

    return { ok: true, configured: true, uploaded: localPaths.length, steps };
  } catch (e: any) {
    const shot = await screenshotB64();
    return {
      ok: false,
      configured: true,
      uploaded: 0,
      steps,
      error: String(e?.message || e).slice(0, 400),
      screenshot: shot,
    };
  } finally {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
