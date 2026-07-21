/**
 * Global autofill guard.
 *
 * The OS/keyboard autofill strip (the password "key", payment "card", and address
 * "location" chips above the keyboard) appears whenever the browser/OS decides a
 * text field is autofillable. We don't want ANY of that on the app's own fields —
 * search boxes, cost inputs, notes, etc. — because none of them are credentials.
 *
 * Two layers, applied on EVERY route EXCEPT the login screen (where credential
 * autofill is wanted), to every text <input>/<textarea> — including client-
 * rendered ones (MutationObserver):
 *   1. autocomplete="off" + the common password-manager opt-out hints.
 *   2. A "readonly-until-focus" latch: the field is readOnly while idle, so at the
 *      instant the OS classifies it on focus it isn't an editable field and the
 *      autofill chips don't attach; a focus handler clears readOnly synchronously
 *      so the keyboard opens and typing works normally, and blur re-arms it.
 *
 * Chrome on Android ignores autocomplete="off" for its autofill, so layer 1 alone
 * isn't enough there — layer 2 is what actually keeps the chip strip away. Real
 * password fields are never touched (they live on /login, which is skipped).
 */

// input types that draw the password/card/address autofill heuristics; the latch
// applies only to these (+ textarea) so date/number/checkbox/etc. are left alone.
const LATCH_TYPES = new Set(['text', 'search', 'email', 'tel', 'url', '']);

const isLoginPath = (): boolean => {
  try {
    const p = location.pathname;
    return p === '/login' || p.startsWith('/login/');
  } catch { return false; }
};

const isTextField = (el: Element): el is HTMLInputElement | HTMLTextAreaElement => {
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag !== 'INPUT') return false;
  const t = (el as HTMLInputElement).type;
  return t !== 'password' && LATCH_TYPES.has(t);
};

function guardField(el: HTMLInputElement | HTMLTextAreaElement): void {
  if (el.getAttribute('data-af-guarded') === '1') return;
  el.setAttribute('autocomplete', 'off');
  el.setAttribute('data-lpignore', 'true');   // LastPass
  el.setAttribute('data-1p-ignore', '');       // 1Password
  el.setAttribute('data-bwignore', '');        // Bitwarden
  el.setAttribute('data-form-type', 'other');  // Dashlane
  el.setAttribute('data-af-guarded', '1');
  // Latch readOnly while idle (never on the field the user is currently in).
  if (el !== document.activeElement) el.readOnly = true;
}

function guardTree(root: ParentNode): void {
  if (isLoginPath()) return;
  root.querySelectorAll?.('input, textarea').forEach((el) => { if (isTextField(el)) guardField(el as HTMLInputElement | HTMLTextAreaElement); });
}

let installed = false;
export function installAutofillGuard(): void {
  if (installed || typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
  installed = true;

  // Clearing readOnly synchronously on focus lets the keyboard open + typing work;
  // re-arming on blur keeps the latch in place for the next focus. Both no-op on
  // the login screen and on fields we didn't guard.
  document.addEventListener('focusin', (e) => {
    const el = e.target as Element | null;
    if (el && (el as any).getAttribute?.('data-af-guarded') === '1') (el as HTMLInputElement | HTMLTextAreaElement).readOnly = false;
  }, true);
  document.addEventListener('focusout', (e) => {
    const el = e.target as Element | null;
    if (el && (el as any).getAttribute?.('data-af-guarded') === '1' && !isLoginPath()) (el as HTMLInputElement | HTMLTextAreaElement).readOnly = true;
  }, true);

  guardTree(document);
  // Client-side navigation and lazy renders add fields after first paint — catch
  // them as they mount (the login-path check runs per batch, so login is spared).
  const obs = new MutationObserver((muts) => {
    if (isLoginPath()) return;
    for (const m of muts) {
      for (const node of Array.from(m.addedNodes)) {
        if (node.nodeType !== 1) continue;
        const el = node as Element;
        if (isTextField(el)) guardField(el as HTMLInputElement | HTMLTextAreaElement);
        el.querySelectorAll?.('input, textarea').forEach((c) => { if (isTextField(c)) guardField(c as HTMLInputElement | HTMLTextAreaElement); });
      }
    }
  });
  const start = () => { if (document.body) obs.observe(document.body, { childList: true, subtree: true }); };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
}
