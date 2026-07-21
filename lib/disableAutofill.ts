/**
 * Global autofill guard.
 *
 * Stamps `autocomplete="off"` plus the common password-manager opt-out hints on
 * every text <input>/<textarea> on EVERY route EXCEPT the login screen (where
 * credential autofill is wanted), including client-rendered fields (MutationObserver).
 *
 * NOTE: this is best-effort. Chrome on Android IGNORES autocomplete="off" for its
 * own autofill, so it does NOT reliably remove the keyboard's password/card/
 * location chip strip inside the native WebView — that strip is OS-level and can
 * only be turned off natively (WebView autofill importance) or in the device's
 * keyboard/Autofill settings. This still helps desktop/iOS browsers and password
 * managers, and it's harmless everywhere.
 */

const isLoginPath = (): boolean => {
  try {
    const p = location.pathname;
    return p === '/login' || p.startsWith('/login/');
  } catch { return false; }
};

const isTextField = (el: Element): el is HTMLInputElement | HTMLTextAreaElement => {
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName !== 'INPUT') return false;
  return (el as HTMLInputElement).type !== 'password';
};

function guardField(el: HTMLInputElement | HTMLTextAreaElement): void {
  if (el.getAttribute('data-af-guarded') === '1') return;
  el.setAttribute('autocomplete', 'off');
  el.setAttribute('data-lpignore', 'true');   // LastPass
  el.setAttribute('data-1p-ignore', '');       // 1Password
  el.setAttribute('data-bwignore', '');        // Bitwarden
  el.setAttribute('data-form-type', 'other');  // Dashlane
  el.setAttribute('data-af-guarded', '1');
}

function guardTree(root: ParentNode): void {
  if (isLoginPath()) return;
  root.querySelectorAll?.('input, textarea').forEach((el) => { if (isTextField(el)) guardField(el as HTMLInputElement | HTMLTextAreaElement); });
}

let installed = false;
export function installAutofillGuard(): void {
  if (installed || typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
  installed = true;
  guardTree(document);
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
