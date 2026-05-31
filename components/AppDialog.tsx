import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

// A small in-app replacement for window.alert / window.confirm so dialogs are
// branded "ResiHome Inspections" instead of showing the browser origin
// (e.g. "resihome-inspection-app.vercel.app says"), which the browser forces
// on native dialogs and cannot be changed.

type DialogKind = 'alert' | 'confirm';

interface DialogState {
  kind: DialogKind;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  resolve: (value: boolean) => void;
}

interface AppDialogApi {
  /** Branded replacement for window.alert. Resolves when dismissed. */
  alert: (message: string, opts?: { confirmLabel?: string }) => Promise<void>;
  /** Branded replacement for window.confirm. Resolves true/false. */
  confirm: (message: string, opts?: { confirmLabel?: string; cancelLabel?: string }) => Promise<boolean>;
}

const AppDialogContext = createContext<AppDialogApi | null>(null);

export function AppDialogProvider({ children }: { children: React.ReactNode }) {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  // Keep a stable ref so the api callbacks never change identity.
  const setDialogRef = useRef(setDialog);
  setDialogRef.current = setDialog;

  const alert = useCallback((message: string, opts?: { confirmLabel?: string }) => {
    return new Promise<void>((resolve) => {
      setDialogRef.current((prev) => {
        // If a dialog is already up, resolve its awaiter (as a cancel) so the
        // replaced promise never hangs forever.
        try { prev?.resolve(false); } catch { /* noop */ }
        return {
          kind: 'alert',
          message,
          confirmLabel: opts?.confirmLabel || 'OK',
          cancelLabel: '',
          resolve: () => resolve(),
        };
      });
    });
  }, []);

  const confirm = useCallback((message: string, opts?: { confirmLabel?: string; cancelLabel?: string }) => {
    return new Promise<boolean>((resolve) => {
      setDialogRef.current((prev) => {
        try { prev?.resolve(false); } catch { /* noop */ }
        return {
          kind: 'confirm',
          message,
          confirmLabel: opts?.confirmLabel || 'OK',
          cancelLabel: opts?.cancelLabel || 'Cancel',
          resolve,
        };
      });
    });
  }, []);

  const close = (result: boolean) => {
    if (dialog) dialog.resolve(result);
    setDialog(null);
  };
  // Stable handle to the latest close() for the keydown listener.
  const closeRef = useRef(close);
  closeRef.current = close;

  // Accessibility: trap Tab focus within the dialog, close on Escape, and
  // restore focus to whatever was focused before it opened.
  const panelRef = useRef<HTMLDivElement>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!dialog) return;
    lastFocusedRef.current = (typeof document !== 'undefined' ? (document.activeElement as HTMLElement) : null);
    const getFocusable = (): HTMLElement[] => {
      const node = panelRef.current;
      if (!node) return [];
      return Array.from(
        node.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
      ).filter((el) => !el.hasAttribute('disabled'));
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeRef.current(false);
        return;
      }
      if (e.key === 'Tab') {
        const items = getFocusable();
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement as HTMLElement;
        if (!panelRef.current?.contains(active)) { e.preventDefault(); first.focus(); return; }
        if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      try { lastFocusedRef.current?.focus?.(); } catch { /* element gone */ }
    };
  }, [dialog]);

  return (
    <AppDialogContext.Provider value={{ alert, confirm }}>
      {children}
      {dialog && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-[2px] p-4 animate-fadeIn"
          onClick={() => close(false)}
        >
          <div
            ref={panelRef}
            className="bg-white rounded-2xl shadow-2xl ring-1 ring-black/5 w-full max-w-sm overflow-hidden animate-popIn"
            onClick={(e) => e.stopPropagation()}
            role={dialog.kind === 'confirm' ? 'alertdialog' : 'dialog'}
            aria-modal="true"
          >
            <div className="px-5 pt-4 pb-2 border-b border-gray-100">
              <div className="font-heading font-bold text-ink text-base">
                ResiHome Inspection
              </div>
            </div>
            <div className="px-5 py-4 text-sm text-gray-800 whitespace-pre-line leading-relaxed">
              {dialog.message}
            </div>
            <div className="px-5 py-3 bg-gray-50 flex items-center justify-end gap-2">
              {dialog.kind === 'confirm' && (
                <button
                  type="button"
                  onClick={() => close(false)}
                  className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 font-heading font-semibold hover:bg-gray-100"
                >
                  {dialog.cancelLabel}
                </button>
              )}
              <button
                type="button"
                autoFocus
                onClick={() => close(true)}
                className="px-4 py-2 text-sm rounded-lg bg-brand text-white font-heading font-semibold hover:bg-brand-dark"
              >
                {dialog.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppDialogContext.Provider>
  );
}

export function useAppDialog(): AppDialogApi {
  const ctx = useContext(AppDialogContext);
  if (!ctx) {
    // Fallback to native dialogs if used outside the provider (shouldn't happen),
    // so callers never crash.
    return {
      alert: async (m: string) => { if (typeof window !== 'undefined') window.alert(m); },
      confirm: async (m: string) => (typeof window !== 'undefined' ? window.confirm(m) : false),
    };
  }
  return ctx;
}
