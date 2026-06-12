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
//   HBMM_ENSURE_TICKET_TYPE   "0" to skip the Turnkey check (default on)
//   HBMM_TICKET_TYPE_TARGET   target type text (default "Turnkey")
//   HBMM_SEL_TICKET_EDIT      selector for the Edit button (EditTicketDetails())
//   HBMM_SEL_TICKET_SAVE      selector for the Save button (after Edit)

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
  selUsername: 'input#username, input[name="username"]',
  selPassword: 'input#password, input[name="pwd"], input[type="password"]',
  // AngularJS login button: <button id="login_btn" ng-click="Authenticate()">.
  selSubmit: 'button#login_btn, [ng-click="Authenticate()"]',
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
    // 1. Download the files locally (log sizes — a tiny size means we fetched an
    // error/HTML page instead of the PDF).
    const localPaths: string[] = [];
    for (let i = 0; i < args.files.length; i++) {
      const p = await downloadToTmp(args.files[i], tmpDir, i);
      localPaths.push(p);
      log(`downloaded ${args.files[i].name} → ${(fs.statSync(p).size / 1024).toFixed(0)} KB`);
    }

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

    // Capture upload network calls so we can see whether the file actually POSTed,
    // to WHICH endpoint (image vs document), and what the server returned.
    const postResponses: string[] = [];
    const reqPayloads: string[] = [];
    page.on('request', (req: any) => {
      try {
        const u = req.url();
        if ((req.method() === 'POST' || req.method() === 'PUT') && /upload|image|document|file|attach/i.test(u)) {
          const ct = (req.headers()['content-type'] || '');
          const pd = /multipart/i.test(ct) ? '(multipart)' : (req.postData() || '').slice(0, 500);
          reqPayloads.push(`${u.slice(-70)} ${pd}`);
        }
      } catch { /* ignore */ }
    });
    page.on('response', async (resp: any) => {
      try {
        const rq = resp.request();
        const m = rq.method();
        if (m !== 'POST' && m !== 'PUT') return;
        const u = rq.url();
        const isUpload = /upload|image|document|file|attach/i.test(u);
        // Keep the full URL (incl. query — ticket id is often there) for uploads,
        // and capture the response body (a 200 can carry {success:false,...}).
        let body = '';
        if (isUpload) {
          try { body = (await resp.text()).replace(/\s+/g, ' ').slice(0, 300); } catch { /* ignore */ }
        }
        postResponses.push(`${resp.status()} ${(isUpload ? u : u.split('?')[0]).slice(-90)}${body ? ` :: ${body}` : ''}`);
      } catch { /* ignore */ }
    });

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // Robust click-by-visible-text over interactive elements (handles icons,
    // scrolls into view, polls). exact=true requires the trimmed text to match.
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

    // 3. Log in (AngularJS: ng-model fields + ng-click="Authenticate()" AJAX).
    await page.goto(loginUrl, { waitUntil: 'networkidle2' });
    log(`opened login (${loginUrl})`);
    await page.waitForSelector(selUsername, { timeout: navTimeout });
    // The per-element ngModel approach bound the username but NOT the password,
    // so Authenticate() submitted a blank password. Set the values DIRECTLY on
    // the LoginController scope (Login.Username + Login.AcctPassword) inside a
    // single $apply — that's the model Authenticate() actually reads — plus the
    // DOM values for show. Paths/selectors are env-overridable.
    const modelUserPath = env('HBMM_MODEL_USER_PATH', 'Login.Username');
    const modelPassPath = env('HBMM_MODEL_PASS_PATH', 'Login.AcctPassword');
    const ctrlSel = env('HBMM_SEL_LOGIN_CTRL', '[ng-controller="LoginController"]');
    const bind = await page.evaluate((opts: { u: string; p: string; su: string; sp: string; userPath: string; passPath: string; ctrlSel: string }) => {
      const { u, p, su, sp, userPath, passPath, ctrlSel } = opts;
      const ng = (window as any).angular;
      const setDom = (sel: string, val: string) => {
        const el = document.querySelector(sel) as HTMLInputElement | null;
        if (el) { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
      };
      setDom(su, u); setDom(sp, p);
      const assign = (root: any, path: string, val: any) => {
        const parts = path.split('.'); let o = root;
        for (let i = 0; i < parts.length - 1; i++) { o[parts[i]] = o[parts[i]] || {}; o = o[parts[i]]; }
        o[parts[parts.length - 1]] = val;
      };
      const read = (root: any, path: string) => { let o = root; for (const k of path.split('.')) { if (o == null) return undefined; o = o[k]; } return o; };
      let model: any = null;
      try {
        const ctrlEl = document.querySelector(ctrlSel) || document.querySelector(su);
        const scope = ng && ctrlEl ? ng.element(ctrlEl).scope() : null;
        if (scope) {
          scope.$apply(() => { assign(scope, userPath, u); assign(scope, passPath, p); });
          model = { u: read(scope, userPath) || '', hasPw: !!read(scope, passPath) };
        }
      } catch (e: any) { model = { error: String(e?.message || e) }; }
      return {
        fieldU: (document.querySelector(su) as HTMLInputElement | null)?.value || '',
        pwLen: ((document.querySelector(sp) as HTMLInputElement | null)?.value || '').length,
        model,
      };
    }, { u: username, p: password, su: selUsername, sp: selPassword, userPath: modelUserPath, passPath: modelPassPath, ctrlSel });
    log(`entered credentials (env username="${username}" len=${password.length}; field="${bind.fieldU}" pwLen=${bind.pwLen}; angularModel=${JSON.stringify(bind.model)})`);
    await sleep(600); // let AngularJS digest the model update

    // Submit. Try the button (#login_btn → Authenticate()); if the form is still
    // there, fall back to pressing Enter in the password field (natural submit).
    // It's an AJAX login, so we wait for the login form to disappear (success).
    await page.evaluate((sel: string) => { (document.querySelector(sel) as HTMLElement | null)?.click(); }, selSubmit);
    log('clicked LOGIN TO ACCOUNT');
    await sleep(1500);
    if (await page.$('#login_btn')) {
      await page.focus(selPassword).catch(() => {});
      await page.keyboard.press('Enter');
      log('pressed Enter to submit (fallback)');
    }
    await page.waitForFunction(() => !document.querySelector('#login_btn'), { timeout: navTimeout })
      .catch(() => {});
    await sleep(3000);
    const afterLoginUrl = page.url();
    const stillOnLogin = !!(await page.$('#login_btn'));
    if (stillOnLogin) {
      // Surface any visible error message the login page is showing.
      const msg = await page.evaluate(() => {
        const t = (document.body?.innerText || '').replace(/\s+/g, ' ');
        const m = t.match(/(invalid|incorrect|wrong|failed|not recognized|does not match|locked|disabled|required)[^.]{0,80}/i);
        return m ? m[0].trim() : '';
      }).catch(() => '');
      log(`after login: url=${afterLoginUrl}  ← STILL ON LOGIN${msg ? ` · page says: "${msg}"` : ''}`);
      throw new Error(`Login did not succeed (still on the login form).${msg ? ` Page says: "${msg}".` : ''} Verify HBMM_USERNAME / HBMM_PASSWORD.`);
    }
    log(`after login: url=${afterLoginUrl}  (authenticated)`);

    // 4. Navigate to the ticket (single goto; we're authenticated so the cookie
    // is sent). The app lands on home after login, so we submit the deep link.
    await page.goto(ticketUrl, { waitUntil: 'networkidle2' });
    await sleep(3500);
    const diag = await page.evaluate(() => /upload document/i.test(document.body?.innerText || document.body?.textContent || '')).catch(() => false);
    log(`opened ticket (url=${page.url()} · hasUploadDocText=${diag})`);

    // 4b. FALLBACK — ensure the ticket type is "Turnkey" BEFORE adding documents.
    // The create/update API doesn't always stick the type (it can land as
    // "Maintenance"), so we confirm via the UI and fix it: read the Ticket Type,
    // and if it isn't the target, click Edit → select Turnkey → Save. Entirely
    // best-effort and env-tunable — it NEVER blocks the upload.
    if (env('HBMM_ENSURE_TICKET_TYPE', '1') !== '0') {
      const target = env('HBMM_TICKET_TYPE_TARGET', 'Turnkey');
      const targetRe = new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      // Read the value shown next to the "Ticket Type :" label.
      const readType = async (): Promise<string> => page.evaluate(() => {
        const labels = Array.from(document.querySelectorAll('label')) as HTMLElement[];
        const i = labels.findIndex((l) => /^ticket type\s*:?\s*$/i.test((l.textContent || '').trim()));
        if (i >= 0) for (let j = i + 1; j < Math.min(i + 4, labels.length); j++) {
          const t = (labels[j].textContent || '').trim();
          if (t && !/:\s*$/.test(t)) return t;
        }
        return '';
      }).catch(() => '');
      try {
        const before = await readType();
        if (before && targetRe.test(before)) {
          log(`ticket type already "${before}" — no change needed`);
        } else {
          log(`ticket type is "${before || '(unknown)'}" — switching to ${target}`);
          // Click Edit (ng-click="EditTicketDetails()"), else by visible text.
          const editSel = env('HBMM_SEL_TICKET_EDIT', '[ng-click="EditTicketDetails()"]');
          let clickedEdit = await page.evaluate((sel: string) => { const el = document.querySelector(sel) as HTMLElement | null; if (el) { el.scrollIntoView({ block: 'center' }); el.click(); return true; } return false; }, editSel).catch(() => false);
          if (!clickedEdit) clickedEdit = await clickByText('edit', true);
          log(`clicked Edit: ${clickedEdit}`);
          await sleep(1800); // let edit-mode controls render

          // Select the target type in whatever control edit mode exposes
          // (a <select>, a radio, or a clickable toggle/label).
          const picked = await page.evaluate((t: string) => {
            const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            for (const s of Array.from(document.querySelectorAll('select')) as HTMLSelectElement[]) {
              const opt = Array.from(s.options).find((o) => re.test(o.textContent || '') || re.test(o.value || ''));
              if (opt) { s.value = opt.value; s.dispatchEvent(new Event('change', { bubbles: true })); return 'select'; }
            }
            for (const r of Array.from(document.querySelectorAll('input[type=radio]')) as HTMLInputElement[]) {
              const lbl = (r.closest('label')?.textContent || (r.id && document.querySelector(`label[for="${r.id}"]`)?.textContent) || r.value || '');
              if (re.test(String(lbl))) { r.click(); return 'radio'; }
            }
            const clickables = Array.from(document.querySelectorAll('button, a, label, [role=button], .btn, li, span, div')) as HTMLElement[];
            const hit = clickables.find((e) => { const txt = (e.textContent || '').trim(); return txt.length > 0 && txt.length < 40 && re.test(txt); });
            if (hit) { hit.scrollIntoView({ block: 'center' }); hit.click(); return 'click'; }
            return '';
          }, target).catch(() => '');
          log(`selected ${target} via: ${picked || 'NONE'}`);
          await sleep(800);

          // Save — the Edit button becomes Save in the same spot.
          const saveSel = env('HBMM_SEL_TICKET_SAVE', '[ng-click="SaveTicketDetails()"], [ng-click="UpdateTicket()"], [ng-click="SaveTicket()"], [ng-click="UpdateTicketDetails()"]');
          let clickedSave = await page.evaluate((sel: string) => { const el = document.querySelector(sel) as HTMLElement | null; if (el) { el.scrollIntoView({ block: 'center' }); el.click(); return true; } return false; }, saveSel).catch(() => false);
          if (!clickedSave) clickedSave = await clickByText('save', true);
          log(`clicked Save: ${clickedSave}`);
          await sleep(3500); // let the save round-trip + re-render
          const after = await readType();
          log(`ticket type after save: "${after || '(unknown)'}"${after && targetRe.test(after) ? ' ✓' : ''}`);
          // CRITICAL: reload to a clean view so the upload isn't broken if we're
          // stuck in edit mode (the "Upload Document" button is hidden there).
          await page.goto(ticketUrl, { waitUntil: 'networkidle2' });
          await sleep(2500);
          log('reloaded ticket after type change');
        }
      } catch (e: any) {
        log(`ensure-turnkey step failed (continuing to upload): ${String(e?.message || e).slice(0, 160)}`);
      }
    }

    // 5. Click "Upload Document" — the DOCUMENT button is exactly
    // ng-click="openUploadModal(false)". (The "Upload Photo" button is
    // openUploadModal(true); a wildcard match would grab it instead since it's
    // first in the DOM — which is why files were landing in the photo store.)
    const uploadDocCss = env('HBMM_SEL_UPLOAD_DOC_CSS', '[ng-click="openUploadModal(false)"]');
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
    // Scope to the DOCUMENT modal's uploader (#frmUploadFile) so we don't grab a
    // stray photo uploader (which routes the file to the image store as .jpg).
    let input = await page.$('#frmUploadFile input[type="file"]'); let inputVia = '#frmUploadFile';
    if (!input) { input = await page.$('.modal.in input[type="file"], .modal[style*="display: block"] input[type="file"]'); inputVia = 'open-modal'; }
    if (!input) { input = await page.$('input#uploader'); inputVia = '#uploader'; }
    if (!input) { const inputs = await page.$$(selFileInput); input = inputs[inputs.length - 1] || inputs[0]; inputVia = 'fallback-last'; }
    if (!input) throw new Error(`file input not found (${selFileInput})`);
    log(`file input via: ${inputVia}`);
    await input.uploadFile(...localPaths);
    log(`attached ${localPaths.length} file(s) to the input`);
    // Confirm Kendo actually staged the file(s) (fileList row appears).
    await sleep(1200);
    const staged = await page.evaluate(() => document.querySelectorAll('.k-file, .k-upload-files li, [data-uid].k-file').length).catch(() => 0);
    log(`staged files in widget: ${staged}`);

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
    const postsBefore = postResponses.length;
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

    // Wait for the async upload to actually complete, then judge by the NETWORK
    // (the modal can close optimistically even when the upload fails).
    await sleep(9000);
    const newPosts = postResponses.slice(postsBefore);
    log(`upload network POST/PUT: ${newPosts.join(' | ') || '(NONE — file did not submit)'}`);
    if (reqPayloads.length) log(`upload request endpoints: ${reqPayloads.join(' | ')}`);
    // Kendo success/error indicators (use the specific file-state classes; the
    // .k-i-close icon is the per-file REMOVE button, NOT an error).
    const kendo = await page.evaluate(() => {
      if (document.querySelector('.k-file-error, .k-file-invalid')) return 'error';
      if (document.querySelector('.k-file-success')) return 'success';
      return 'unknown';
    }).catch(() => 'unknown');
    log(`kendo file status: ${kendo}`);

    const shot = await screenshotB64();
    const had2xxPost = newPosts.some((s) => /^2\d\d /.test(s));
    const hadErrPost = newPosts.some((s) => /^[45]\d\d /.test(s));
    const succeeded = kendo === 'success' || (had2xxPost && kendo !== 'error' && !hadErrPost);
    if (!succeeded) {
      return {
        ok: false, configured: true, uploaded: 0, steps,
        error: newPosts.length
          ? `Upload did not confirm. Server responses: ${newPosts.join(', ')}; widget status: ${kendo}.`
          : `No upload request was sent (file may not have staged; widget status: ${kendo}).`,
        screenshot: shot,
      };
    }
    return { ok: true, configured: true, uploaded: localPaths.length, steps, screenshot: shot };
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
