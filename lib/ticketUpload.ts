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
  selUsername: 'input[name="username"], input[name="email"], input[type="email"], input[type="text"], input#username, input#email',
  selPassword: 'input[type="password"], input[name="password"], input#password',
  // HoneyBadger's button reads "LOGIN TO ACCOUNT".
  selSubmit: 'button::-p-text(LOGIN TO ACCOUNT), input[type="submit"], button[type="submit"], button::-p-text(Login), button::-p-text(Log In), button::-p-text(Sign In)',
  selUploadDoc: '::-p-text(Upload Document)',
  selFileInput: 'input#uploader, input[type="file"][name="files"], input[type="file"]',
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

  // @sparticuz/chromium only extracts its bundled shared libs + sets
  // LD_LIBRARY_PATH when it detects an AWS Lambda runtime via AWS_EXECUTION_ENV,
  // AT IMPORT TIME, and it picks the lib set by the value:
  //   "AWS_Lambda_nodejs20.x"/"22.x"  -> al2023 set (libnspr4, libnss3, …)
  //   other "AWS_Lambda_nodejs…"      -> al2 set (libnss3 but NO libnspr4)
  // Vercel's modern runtime is AL2023, which needs the al2023 set. Vercel may
  // pre-set AWS_EXECUTION_ENV to a non-Node20 value (which pulled the wrong al2
  // set → "libnspr4 missing"), so we FORCE the al2023 value before importing.
  // Overridable via HBMM_CHROMIUM_LAMBDA_ENV if the runtime ever changes.
  process.env.AWS_EXECUTION_ENV = (process.env.HBMM_CHROMIUM_LAMBDA_ENV || 'AWS_Lambda_nodejs20.x').trim();
  log(`AWS_EXECUTION_ENV=${process.env.AWS_EXECUTION_ENV}`);

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
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await page.goto(loginUrl, { waitUntil: 'networkidle2' });
    log(`opened login (${loginUrl})`);
    await page.waitForSelector(selUsername, { timeout: navTimeout });
    await page.type(selUsername, username, { delay: 20 });
    await page.type(selPassword, password, { delay: 20 });
    log('entered credentials');
    // Click the login button (fallback: Enter in the password field).
    try { await page.click(selSubmit); } catch { await page.focus(selPassword); await page.keyboard.press('Enter'); }
    log('submitted login');
    // The login is a SPA AJAX call that then redirects to the dashboard — there
    // may be no full navigation. Wait for the login form to go away (success)
    // and give the session a moment to settle.
    await page.waitForSelector(selPassword, { hidden: true, timeout: navTimeout })
      .then(() => log('login form cleared (authenticated)'))
      .catch(() => log('login form still present after submit (login may have failed)'));
    await sleep(2500);

    // 4. Now that we're authenticated, navigate to the ticket. The app ignores
    // the deep link during login and lands on home, so we (re)submit the ticket
    // URL here and force the hash route to take.
    await page.goto(ticketUrl, { waitUntil: 'networkidle2' });
    await page.evaluate((u: string) => { if (window.location.href !== u) window.location.href = u; }, ticketUrl);
    // Reload to force the AngularJS hash route to (re)initialize on the ticket.
    await page.reload({ waitUntil: 'networkidle2' }).catch(() => {});
    await sleep(3500);
    const diag = await page.evaluate(() => /upload document/i.test(document.body?.innerText || document.body?.textContent || '')).catch(() => false);
    log(`opened ticket (url=${page.url()} · hasUploadDocText=${diag})`);

    // Robust click-by-visible-text over interactive elements (handles the icon
    // next to "Upload Document", scrolls into view, polls until it appears).
    const clickByText = async (needle: string, exact = false): Promise<boolean> => {
      const end = Date.now() + navTimeout;
      const t = needle.toLowerCase();
      while (Date.now() < end) {
        const ok = await page.evaluate((needleText: string, ex: boolean) => {
          const els = Array.from(document.querySelectorAll('button, a, input[type=button], input[type=submit], [role=button]')) as HTMLElement[];
          const norm = (s: string) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
          const target = els.find((e) => {
            const txt = norm((e as HTMLInputElement).value || e.innerText || e.textContent || '');
            return ex ? txt === needleText : txt.includes(needleText);
          });
          if (target) { target.scrollIntoView({ block: 'center' }); target.click(); return true; }
          return false;
        }, t, exact);
        if (ok) return true;
        await sleep(500);
      }
      return false;
    };

    // 5. Click "Upload Document" — precise AngularJS selector first, text fallback.
    const uploadDocCss = env('HBMM_SEL_UPLOAD_DOC_CSS', 'a[ng-click="openUploadModal(false)"], [ng-click*="openUploadModal"]');
    let clickedDoc = false;
    try {
      await page.waitForSelector(uploadDocCss, { timeout: navTimeout });
      await page.evaluate((sel: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (el) { el.scrollIntoView({ block: 'center' }); el.click(); }
      }, uploadDocCss);
      clickedDoc = true;
    } catch { /* fall back to text */ }
    if (!clickedDoc) clickedDoc = await clickByText('upload document');
    if (!clickedDoc) throw new Error('could not find the "Upload Document" button on the ticket page');
    log('clicked Upload Document');

    // 6. Set the Kendo upload file input (id="uploader", name="files"). Setting
    // files dispatches a change event → Kendo stages them in fileList.
    await sleep(1500);
    await page.waitForSelector(selFileInput, { timeout: navTimeout });
    const inputs = await page.$$(selFileInput);
    const input = inputs[inputs.length - 1] || inputs[0];
    if (!input) throw new Error(`file input not found (${selFileInput})`);
    await input.uploadFile(...localPaths);
    log(`attached ${localPaths.length} file(s) to the input`);

    // If there's a required "Add Files to:" section dropdown showing, pick the
    // first real option (skip the "?" placeholder) so upload isn't blocked.
    try {
      await page.evaluate(() => {
        const sel = document.querySelector('select#documentSection') as HTMLSelectElement | null;
        const grp = sel?.closest('.form-group') as HTMLElement | null;
        const visible = sel && grp && !grp.classList.contains('ng-hide');
        if (visible && (sel!.value === '?' || sel!.value === '')) {
          const opt = Array.from(sel!.options).find((o) => o.value && o.value !== '?');
          if (opt) {
            sel!.value = opt.value;
            sel!.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      });
    } catch { /* no section dropdown — fine */ }

    // 7. Click the modal "Upload" button (ng-click="upload()"), which stays
    // disabled until files are staged — wait for it to enable, then click.
    await sleep(1200);
    const selUp = env('HBMM_SEL_UPLOAD_BTN_CSS', 'button[ng-click="upload()"]');
    let clickedUpload = false;
    try {
      await page.waitForFunction((sel: string) => {
        const b = document.querySelector(sel) as HTMLButtonElement | null;
        return !!b && !b.disabled;
      }, { timeout: navTimeout }, selUp);
      await page.evaluate((sel: string) => { (document.querySelector(sel) as HTMLElement | null)?.click(); }, selUp);
      clickedUpload = true;
    } catch { /* fall back to text */ }
    if (!clickedUpload) clickedUpload = await clickByText('upload', true);
    if (!clickedUpload) throw new Error('could not click the modal Upload button (still disabled — files may not have staged)');
    log('clicked Upload');

    // Wait for the async upload to finish — prefer the modal closing as the
    // success signal, otherwise give it a generous fixed wait.
    await page.waitForFunction(() => !document.querySelector('.modal.in, .modal[style*="display: block"]'), { timeout: 20000 })
      .then(() => log('upload modal closed (success)'))
      .catch(() => log('upload modal still open after wait (verify on the ticket)'));
    await sleep(2000);

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
