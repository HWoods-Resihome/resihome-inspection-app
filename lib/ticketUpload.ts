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
export async function uploadTicketDocuments(args: { ticketId: number; files: TicketUploadFile[]; ensureTicketType?: boolean }): Promise<TicketUploadResult> {
  const steps: string[] = [];
  const log = (s: string) => { steps.push(s); };
  // Whether to run the "force Ticket Type = Turnkey" UI step. Scope wants it
  // (default true); the 1099/vacancy flow passes false so it leaves the type
  // alone. Falls back to the HBMM_ENSURE_TICKET_TYPE env when not specified.
  const ensureType = args.ensureTicketType ?? (env('HBMM_ENSURE_TICKET_TYPE', '1') !== '0');

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
    // FULL bodies of the document-registration response(s) — they carry the S3
    // DocumentURL(s) we verify after upload (the truncated postResponses copy
    // cuts the URL off mid-query, so keep the untrimmed version separately).
    const docRegBodies: string[] = [];
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
        let full = '';
        if (isUpload) {
          try { full = await resp.text(); } catch { /* ignore */ }
        }
        // The document-registration call returns {"TicketDocs":[{DocumentURL,…}]}
        // — keep its FULL body so we can verify each stored object below.
        if (full && (/TicketDocumentUpload/i.test(u) || /"TicketDocs"\s*:/.test(full))) docRegBodies.push(full);
        const body = full ? full.replace(/\s+/g, ' ').slice(0, 300) : '';
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
    if (ensureType) {
      const target = env('HBMM_TICKET_TYPE_TARGET', 'Turnkey');
      const targetRe = new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      // Read the value shown next to the "Ticket Type :" label. CRITICAL: only
      // consider VISIBLE labels — the hidden edit form (#formAddTicket, ng-hide)
      // contains "Turnkey"/"Maintenance" as selectable options, and reading those
      // gave a false "already Turnkey". The read-only value is the bold label
      // (.lblbold) right after the visible "Ticket Type :" label.
      // Read the CURRENT ticket type. Prefer the live <select id="TicketType">
      // when it's actually visible (edit mode) — its selected option is the
      // source of truth. Otherwise fall back to the read-only bold label after
      // the visible "Ticket Type :" label. CRITICAL: only VISIBLE elements —
      // the hidden edit form carries "Turnkey"/"Maintenance" options that
      // previously produced a false "already Turnkey".
      const readType = async (): Promise<string> => page.evaluate(() => {
        const isVisible = (el: Element) => !!(el as HTMLElement).offsetParent;
        const sel = document.querySelector('#TicketType') as HTMLSelectElement | null;
        if (sel && isVisible(sel)) {
          const opt = sel.options[sel.selectedIndex];
          const t = (opt?.textContent || '').trim();
          if (t && !/^-?\s*select\s*-?$/i.test(t)) return t;
        }
        const labels = (Array.from(document.querySelectorAll('label')) as HTMLElement[]).filter(isVisible);
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
          // Wait for the edit control to actually render rather than guessing a
          // fixed delay (cold-start Lambda renders are slow; warm ones are fast).
          const editWait = Math.min(navTimeout, 10000);
          const sawSelect = await page.waitForSelector('#TicketType', { visible: true, timeout: editWait }).then(() => true).catch(() => false);
          log(`edit-mode #TicketType visible: ${sawSelect}`);
          if (!sawSelect) await sleep(1200); // fallback for non-#TicketType edit forms

          // Select the target type. The confirmed control is
          //   <select id="TicketType" ng-model="TicketDetail.TicketTypeId"
          //           ng-options="g.LookupId as g.LookupDesc for g in TicketTypes"
          //           ng-change="ChangeTicketType()">
          // i.e. an AngularJS-bound <select> whose options are LABELLED by text
          // ("Turnkey"). With ng-options the option's `value` attr is an Angular
          // tracking token (the array INDEX, e.g. "3"), NOT the LookupId — so we
          // match by VISIBLE TEXT, set value + selectedIndex, and dispatch a
          // native `change`. Angular's select directive then maps the selected
          // option back to its real LookupId inside its own $digest and fires
          // ng-change. We deliberately do NOT write the model ourselves: opt.value
          // is the index, so assigning it would clobber the correct LookupId the
          // change handler just set.
          const picked = await page.evaluate((t: string) => {
            const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            const norm = (s: string) => (s || '').replace(/\s+/g, ' ').trim();
            const driveSelect = (s: HTMLSelectElement): string => {
              const opts = Array.from(s.options);
              // Prefer an EXACT (case-insensitive) text match so "Turnkey" can't
              // grab "Non-Turnkey"/"Turnkey Plus"; fall back to a substring match.
              const opt = opts.find((o) => norm(o.textContent || '').toLowerCase() === t.toLowerCase())
                || opts.find((o) => re.test(norm(o.textContent || '')))
                || opts.find((o) => re.test(o.value || ''));
              if (!opt) return '';
              s.value = opt.value;
              s.selectedIndex = opts.indexOf(opt);
              s.dispatchEvent(new Event('input', { bubbles: true }));
              s.dispatchEvent(new Event('change', { bubbles: true }));
              return `select#${s.id || '?'}`;
            };
            // 1) The confirmed control by id.
            const byId = document.querySelector('#TicketType') as HTMLSelectElement | null;
            if (byId) { const r = driveSelect(byId); if (r) return r; }
            // 2) Any other select in the edit form.
            const root: ParentNode = document.querySelector('#formAddTicket, #divAddEdit') || document;
            for (const s of Array.from(root.querySelectorAll('select')) as HTMLSelectElement[]) {
              const r = driveSelect(s); if (r) return r;
            }
            // 3) Radio / clickable fallbacks.
            for (const r of Array.from(root.querySelectorAll('input[type=radio]')) as HTMLInputElement[]) {
              const lbl = (r.closest('label')?.textContent || (r.id && document.querySelector(`label[for="${r.id}"]`)?.textContent) || r.value || '');
              if (re.test(String(lbl))) { r.click(); return 'radio'; }
            }
            const clickables = Array.from(root.querySelectorAll('button, a, label, [role=button], .btn, li, span, div')) as HTMLElement[];
            const hit = clickables.find((e) => { const txt = (e.textContent || '').trim(); return txt.length > 0 && txt.length < 40 && re.test(txt); });
            if (hit) { hit.scrollIntoView({ block: 'center' }); hit.click(); return 'click'; }
            return '';
          }, target).catch(() => '');
          log(`selected ${target} via: ${picked || 'NONE'}`);
          // Wait until the select actually reflects the target (ng-model digested)
          // instead of a fixed pause. Harmless no-op when the control isn't #TicketType.
          await page.waitForFunction((t: string) => {
            const s = document.querySelector('#TicketType') as HTMLSelectElement | null;
            if (!s) return true;
            const opt = s.options[s.selectedIndex];
            return !!opt && (opt.textContent || '').trim().toLowerCase().includes(t.toLowerCase());
          }, { timeout: 4000 }, target).catch(() => {});

          // Save — the Edit button becomes Save in the same spot.
          const saveSel = env('HBMM_SEL_TICKET_SAVE', '[ng-click="SaveTicketDetails()"], [ng-click="UpdateTicket()"], [ng-click="SaveTicket()"], [ng-click="UpdateTicketDetails()"]');
          let clickedSave = await page.evaluate((sel: string) => { const el = document.querySelector(sel) as HTMLElement | null; if (el) { el.scrollIntoView({ block: 'center' }); el.click(); return true; } return false; }, saveSel).catch(() => false);
          if (!clickedSave) clickedSave = await clickByText('save', true);
          log(`clicked Save: ${clickedSave}`);
          // Wait for the save to settle — the edit form closes (#TicketType no
          // longer visible) when the round-trip returns to read-only — rather
          // than a blanket 3.5s pause.
          await page.waitForFunction(() => {
            const s = document.querySelector('#TicketType') as HTMLSelectElement | null;
            return !s || !s.offsetParent;
          }, { timeout: Math.min(navTimeout, 10000) }).catch(() => {});
          // CRITICAL: reload to a clean view BEFORE verifying — so the upload
          // isn't broken if we're stuck in edit mode (the "Upload Document"
          // button is hidden there) AND so the read reflects the PERSISTED value
          // rather than the edit form's still-open in-memory selection (which
          // always shows what we just picked → a false "✓").
          await page.goto(ticketUrl, { waitUntil: 'networkidle2' });
          // Wait until the ticket type is readable (label or bound select present)
          // before reading it back, then a brief settle for Angular to bind.
          await page.waitForFunction(() => {
            const labels = (Array.from(document.querySelectorAll('label')) as HTMLElement[]).filter((l) => l.offsetParent);
            return labels.some((l) => /^ticket type\s*:?\s*$/i.test((l.textContent || '').trim())) || !!document.querySelector('#TicketType');
          }, { timeout: Math.min(navTimeout, 10000) }).catch(() => {});
          await sleep(600);
          const after = await readType();
          const confirmed = !!after && targetRe.test(after);
          log(`reloaded ticket; type after save: "${after || '(unknown)'}"${confirmed ? ' ✓' : ' ✗ (NOT confirmed — still not ' + target + ')'}`);
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

    // Wait for the upload to reach a TERMINAL state before judging — and, just as
    // important, before the `finally` below CLOSES the browser. A fixed pause
    // could screenshot + return while a large rate-card PDF (many embedded photos
    // → tens of MB) is still streaming into HoneyBadger's S3; killing the browser
    // mid-flight leaves an orphaned document record whose object never landed —
    // exactly the "NoSuchKey" the inspector hits on click. So poll for the Kendo
    // widget to settle (success/error) and for the upload network to go quiet,
    // up to a generous ceiling (env HBMM_UPLOAD_WAIT_MS, default 60s).
    const uploadWaitMs = Number(process.env.HBMM_UPLOAD_WAIT_MS || 0) || 60000;
    const waitEnd = Date.now() + uploadWaitMs;
    let kendo = 'unknown';
    let lastPostCount = postResponses.length;
    let quietSince = Date.now();
    while (Date.now() < waitEnd) {
      await sleep(1000);
      kendo = await page.evaluate(() => {
        if (document.querySelector('.k-file-error, .k-file-invalid')) return 'error';
        if (document.querySelector('.k-file-success')) return 'success';
        return 'unknown';
      }).catch(() => 'unknown');
      // Track upload-network quiet: reset the timer whenever a new upload response
      // lands, so "quiet" means the byte transfer to S3 has genuinely settled.
      if (postResponses.length !== lastPostCount) { lastPostCount = postResponses.length; quietSince = Date.now(); }
      const quietMs = Date.now() - quietSince;
      if (kendo === 'error') break;                                   // explicit failure — stop now
      if (kendo === 'success' && quietMs >= 3000) break;              // success AND transfer settled
      // Some flows never paint a Kendo success class; accept the network verdict
      // once we've seen at least one upload response and it's been quiet a while.
      if (postResponses.length > postsBefore && quietMs >= 8000) break;
    }
    const newPosts = postResponses.slice(postsBefore);
    log(`upload network POST/PUT: ${newPosts.join(' | ') || '(NONE — file did not submit)'}`);
    if (reqPayloads.length) log(`upload request endpoints: ${reqPayloads.join(' | ')}`);
    log(`kendo file status: ${kendo}`);

    // VERIFY THE BYTES ACTUALLY LANDED. Field evidence shows HoneyBadger can
    // return 200 to every upload call AND register a document with a presigned S3
    // URL, yet never durably persist the object — so clicking it later serves S3
    // "NoSuchKey". The network verdict can't reveal that; only fetching the URL
    // HoneyBadger just handed back can. Pull every registered DocumentURL and
    // check it resolves — a genuinely-missing key is a silent loss we must NOT
    // report as success (and tells us EXACTLY which file HoneyBadger dropped).
    const docUrls = Array.from(new Set(
      docRegBodies.flatMap((b) => {
        try {
          const j = JSON.parse(b);
          const docs = Array.isArray(j?.TicketDocs) ? j.TicketDocs : [];
          const urls = docs.map((d: any) => d?.DocumentURL).filter((x: any) => typeof x === 'string' && x);
          if (urls.length) return urls as string[];
        } catch { /* not clean JSON — fall through to a URL scrape */ }
        return (b.match(/https?:\/\/[^"'\\\s]+/g) || []).filter((x) => /hb-documents|s3\.amazonaws/i.test(x));
      })
    ));
    const missingDocs: string[] = [];
    for (const du of docUrls) {
      let present = false;
      // Two looks, a few seconds apart, so a brief write lag isn't a false alarm.
      for (let attempt = 0; attempt < 2 && !present; attempt++) {
        if (attempt) await sleep(4000);
        try {
          const r = await fetch(du, { headers: { Range: 'bytes=0-0' } });
          if (r.ok) { present = true; break; }
          const txt = await r.text().catch(() => '');
          // ONLY a genuinely-missing key is a loss. A 403/expired-signature means
          // the object EXISTS but this short-lived presigned URL lapsed (the live
          // UI mints a fresh one), so it must not count as missing.
          if (!/NoSuchKey/i.test(txt) && r.status !== 404) { present = true; break; }
        } catch { /* network blip — retry once */ }
      }
      if (!present) missingDocs.push(du);
    }
    if (docUrls.length) {
      log(`verified ${docUrls.length} stored document URL(s); ${missingDocs.length ? `MISSING ${missingDocs.length}: ${missingDocs.map((u) => u.split('?')[0].slice(-40)).join(', ')}` : 'all present ✓'}`);
    } else {
      log('no DocumentURL returned to verify (registration response carried none)');
    }

    const shot = await screenshotB64();
    const had2xxPost = newPosts.some((s) => /^2\d\d /.test(s));
    const hadErrPost = newPosts.some((s) => /^[45]\d\d /.test(s));
    // A 2xx upload response can still carry an app-level failure in its BODY —
    // HoneyBadger returns HTTP 200 with {success:false,...} when its server-side
    // S3 write is rejected. Counting that as success is what logs a document the
    // store never actually persisted (→ NoSuchKey). Treat an explicit
    // success:false as a failure so we surface it and the doc isn't trusted.
    const hadBodyFailure = newPosts.some((s) => /["']?success["']?\s*[:=]\s*false\b/i.test(s));
    const succeeded = (kendo === 'success' || (had2xxPost && kendo !== 'error' && !hadErrPost)) && !hadBodyFailure && missingDocs.length === 0;
    if (!succeeded) {
      return {
        ok: false, configured: true, uploaded: 0, steps,
        error: missingDocs.length
          ? `HoneyBadger accepted the upload (HTTP 200) and registered ${docUrls.length} document(s), but ${missingDocs.length} of the stored object(s) are missing from its S3 bucket (NoSuchKey) — the file(s) were sent and registered but not durably saved on HoneyBadger's side. Missing: ${missingDocs.map((u) => u.split('?')[0].slice(-40)).join(', ')}.`
          : !newPosts.length
            ? `No upload request was sent (file may not have staged; widget status: ${kendo}).`
            : hadBodyFailure
              ? `Upload was rejected by HoneyBadger (server returned success:false). Responses: ${newPosts.join(', ')}; widget status: ${kendo}.`
              : `Upload did not confirm. Server responses: ${newPosts.join(', ')}; widget status: ${kendo}.`,
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
