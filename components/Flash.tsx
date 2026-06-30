import { createContext, useCallback, useContext, useState, useRef } from 'react';

// A lightweight bottom-of-app flash/toast — used for background results that
// land AFTER the user has moved on (e.g. the maintenance-ticket document upload
// that runs in the background once finalize is done). Lives at the app root so
// it survives route changes (the toast still shows after navigating home).

type FlashType = 'info' | 'success' | 'error';
interface FlashState { msg: string; type: FlashType }

interface FlashApi {
  /** Show a transient bottom toast. */
  flash: (msg: string, type?: FlashType, ms?: number) => void;
  /**
   * Fire the maintenance-ticket document upload in the background for an
   * inspection and toast the result. Safe to call then navigate away — this
   * runs at the app root, so the toast still appears when it resolves.
   */
  runTicketUpload: (inspectionId: string, ticketId?: number | null, pdfUrl?: string, which?: 'turnkey' | 'eviction' | 'capex') => void;
}

const FlashContext = createContext<FlashApi | null>(null);

export function FlashProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<FlashState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((msg: string, type: FlashType = 'info', ms = 6000) => {
    if (timer.current) clearTimeout(timer.current);
    setToast({ msg, type });
    // Pending (info) toasts stay until replaced; success/error auto-dismiss.
    if (ms > 0) timer.current = setTimeout(() => setToast(null), ms);
  }, []);

  const runTicketUpload = useCallback((inspectionId: string, ticketId?: number | null, pdfUrl?: string, which: 'turnkey' | 'eviction' | 'capex' = 'turnkey') => {
    // Label the toast by ticket kind so up-to-three concurrent uploads (Turnkey +
    // Eviction + CapEx) read clearly. 'turnkey' keeps the generic "maintenance"
    // wording (also used by the 1099/vacancy single-ticket flow).
    const label = which === 'eviction' ? 'Eviction' : which === 'capex' ? 'CapEx' : 'maintenance';
    // Pending toast (no auto-dismiss until the result replaces it).
    flash(`Attaching documents to the ${label} ticket…`, 'info', 0);
    (async () => {
      try {
        const r = await fetch(`/api/inspections/${inspectionId}/upload-ticket-docs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...(ticketId ? { ticketId } : {}), ...(pdfUrl ? { pdfUrl } : {}), which }),
        });
        const data = await r.json().catch(() => ({}));
        if (data?.skipped) { setToast(null); return; } // not configured / nothing to do → silent
        if (r.ok && data?.ok) {
          flash(`Documents attached to the ${label} ticket${data.ticketId ? ` #${data.ticketId}` : ''} ✅`, 'success', 8000);
        } else {
          flash(`Couldn't attach documents to the ${label} ticket ❌${data?.error ? ` — ${String(data.error).slice(0, 120)}` : ''}`, 'error', 12000);
        }
      } catch (e: any) {
        flash(`Couldn't attach documents to the ${label} ticket ❌`, 'error', 12000);
      }
    })();
  }, [flash]);

  const color = toast?.type === 'success' ? '#047857' : toast?.type === 'error' ? '#b91c1c' : '#111827';

  return (
    <FlashContext.Provider value={{ flash, runTicketUpload }}>
      {children}
      {toast && (
        <div
          role="status"
          style={{
            position: 'fixed', left: '50%', bottom: 24, transform: 'translateX(-50%)',
            zIndex: 9999, maxWidth: 'min(92vw, 560px)',
            background: color, color: '#fff', padding: '12px 18px', borderRadius: 10,
            boxShadow: '0 6px 24px rgba(0,0,0,0.25)', fontSize: 14, fontWeight: 600,
            display: 'flex', alignItems: 'center', gap: 12,
            fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
          }}
        >
          <span>{toast.msg}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            aria-label="Dismiss"
            style={{ background: 'transparent', border: 'none', color: '#fff', opacity: 0.85, cursor: 'pointer', fontSize: 16, lineHeight: 1 }}
          >×</button>
        </div>
      )}
    </FlashContext.Provider>
  );
}

export function useFlash(): FlashApi {
  const ctx = useContext(FlashContext);
  // No-op fallback so callers never crash if used outside the provider.
  return ctx || { flash: () => {}, runTicketUpload: () => {} };
}
