/**
 * Global autofill guard.
 *
 * The OS/keyboard autofill strip (the password "key", payment "card", and address
 * "location" icons above the keyboard) appears whenever the browser/OS decides a
 * text field is autofillable. We don't want ANY of that on the app's own fields —
 * search boxes, cost inputs, notes, etc. — because none of them are credentials.
 *
 * This stamps `autocomplete="off"` plus the common password-manager opt-out hints
 * on every <input>/<textarea> on EVERY route EXCEPT the login screen (where
 * credential autofill is wanted), and watches for client-rendered fields via a
 * MutationObserver. Real password fields are never touched (they only exist on
 * login, which is skipped entirely anyway).
 */

const isLoginPath = (): boolean => {
  try {
    const p = location.pathname;
    return p === '/login' || p.startsWith('/login/');
  } catch { return false; }
};

function guardField(el: HTMLInputElement | HTMLTextAreaElement): void {
  // Password fields must keep autofill (they live on the login screen only).
  if (el instanceof HTMLInputElement && el.type === 'password') return;
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
  root.querySelectorAll?.('input, textarea').forEach((el) => guardField(el as HTMLInputElement | HTMLTextAreaElement));
}

let installed = false;
export function installAutofillGuard(): void {
  if (installed || typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
  installed = true;
  guardTree(document);
  // Client-side navigation and lazy renders add fields after first paint — catch
  // them as they mount (the login-path check runs per batch, so login is spared).
  const obs = new MutationObserver((muts) => {
    if (isLoginPath()) return;
    for (const m of muts) {
      for (const node of Array.from(m.addedNodes)) {
        if (node.nodeType !== 1) continue;
        const el = node as Element;
        if (el.matches?.('input, textarea')) guardField(el as HTMLInputElement | HTMLTextAreaElement);
        el.querySelectorAll?.('input, textarea').forEach((c) => guardField(c as HTMLInputElement | HTMLTextAreaElement));
      }
    }
  });
  const start = () => { if (document.body) obs.observe(document.body, { childList: true, subtree: true }); };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
}
