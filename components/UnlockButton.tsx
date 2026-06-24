// UnlockButton — one-tap Rently access code for the property an inspection is on.
//
// Calls the same-origin /api/rently/unlock proxy (which holds the VCB shared
// secret server-side and injects the signed-in user's email). The endpoint
// returns the issueVendorCode envelope; we branch on data.status (NOT res.status —
// the upstream Apps Script always replies HTTP 200). The resulting code is shown
// in a centered modal with a single OK button that dismisses straight back into
// the inspection. Renders identically on Chrome, Safari, and the native shells.
import { useState } from 'react';

/** Online/offline ring shown around the lock icon. null = no determination
 *  (unknown device) → no ring. */
export type LockRing = 'online' | 'offline' | null;

/**
 * Decide the lock ring from the property's Rently telemetry:
 *  - Unknown device type → null (no ring; we can't say).
 *  - A known device that is NOT a "Smart Home Hub" (e.g. a Bluetooth Lock) is
 *    treated as ONLINE → green ring.
 *  - A "Smart Home Hub" is ONLINE only when BOTH rently_sh_hub_status AND
 *    rently_sh_lock_status equal "Online"; if either is not "Online" the hub/lock
 *    is OFFLINE → red ring.
 */
export function lockRingFromProperty(
  deviceType: string | null | undefined,
  hubStatus: string | null | undefined,
  lockStatus: string | null | undefined,
): LockRing {
  const dt = (deviceType || '').trim();
  if (!dt) return null;
  if (dt.toLowerCase() !== 'smart home hub') return 'online';
  const isOnline = (s: string | null | undefined) => (s || '').trim().toLowerCase() === 'online';
  return isOnline(hubStatus) && isOnline(lockStatus) ? 'online' : 'offline';
}

interface UnlockButtonProps {
  /** HubSpot Property record id (preferred lookup path). */
  propertyId?: string;
  /** Address fallback (only used server-side if propertyId is absent). */
  address?: string;
  /** Optional inspection record id (round-tripped to label the Rently code). */
  inspectionId?: string;
  /** Online/offline ring around the lock icon (see lockRingFromProperty).
   *  Omit/null to render no ring. */
  lockRing?: LockRing;
  /** Extra classes if a caller needs to tweak the circle. */
  className?: string;
}

type ModalState =
  | { kind: 'success' | 'warn'; title: string; code?: string; subtitle?: string }
  | { kind: 'error'; title: string; subtitle?: string };

export function UnlockButton({ propertyId, address, inspectionId, lockRing, className }: UnlockButtonProps) {
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState<ModalState | null>(null);

  async function handleUnlock() {
    if (loading) return;
    setLoading(true);
    try {
      const res = await fetch('/api/rently/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId, address, inspectionId }),
      });
      const data = await res.json(); // branch on data.status, NOT res.status
      if (data.status === 'SUCCESS' || data.status === 'STUB') {
        const stub = data.status === 'STUB';
        setModal({
          kind: stub ? 'warn' : 'success',
          title: stub ? 'Test Code (Safe Mode is ON)' : 'Access Code',
          code: data.code,
          subtitle: stub
            ? 'Rently calls are disabled — this is a placeholder, not a real code.'
            : [durationText(data), data.address].filter(Boolean).join('\n'),
        });
      } else {
        setModal({ kind: 'error', title: 'Could not get a code', subtitle: friendlyError(data) });
      }
    } catch {
      setModal({
        kind: 'error',
        title: 'Connection problem',
        subtitle: 'Could not reach the code service. Check your connection and try again.',
      });
    } finally {
      setLoading(false);
    }
  }

  // Online/offline ring around the lock icon. Drawn INSET so the button keeps
  // its exact w-8 h-8 footprint and lines up with the other header buttons —
  // an outset/offset ring would balloon the visual diameter and look too tall.
  const ringClass =
    lockRing === 'online' ? 'ring-2 ring-inset ring-emerald-500 '
    : lockRing === 'offline' ? 'ring-2 ring-inset ring-red-500 '
    : '';
  const statusText =
    lockRing === 'online' ? 'Lock online. '
    : lockRing === 'offline' ? 'Lock/hub OFFLINE. '
    : '';
  const label = `${statusText}Unlock — get a Rently access code for this property`;

  return (
    <>
      <button
        type="button"
        onClick={handleUnlock}
        disabled={loading}
        aria-busy={loading}
        aria-label={label}
        title={label}
        className={
          'inline-flex items-center justify-center w-8 h-8 rounded-full text-black shrink-0 ' +
          'transition-colors disabled:cursor-default ' +
          (loading ? 'bg-[#A8EEEB] ' : 'bg-[#73E3DF] hover:bg-[#5fd8d3] active:scale-95 ') +
          ringClass +
          (className || '')
        }
      >
        {loading ? (
          <span className="inline-block w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin" aria-hidden />
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 9.9-1" />
          </svg>
        )}
      </button>
      {modal && <CodeModal modal={modal} onClose={() => setModal(null)} />}
    </>
  );
}

function durationText(d: any): string {
  return d?.family === 'BOLT'
    ? 'Valid for ~3 hours from first use.'
    : 'Valid for ~1 hour from first use.';
}

function friendlyError(d: any): string {
  switch (d?.errorClass) {
    case 'not_found':         return 'Lock not found at Rently. Check the Rently fields on this property in HubSpot.';
    case 'permission_denied': return 'Rently refused this request for this property.';
    case 'auth_fail':         return 'The code service could not authenticate to Rently. Notify ops.';
    case 'business_rule':     return d?.error || 'Rently rejected the request.';
    case 'network_error':     return 'Network error reaching the code service. Try again in a moment.';
    // Surface the real server detail (endpoint exception or deployment/access
    // diagnostic) so failures are actionable in the field, not opaque.
    case 'server_error':      return d?.error || 'Server error. Try again; if it persists, notify ops.';
    case 'unauthorized':      return 'This app is not authorized to request codes.';
    case 'forbidden':         return 'Your account is not authorized to request codes.';
    case 'not_configured':    return 'Unlock is not configured on the server yet. Notify ops.';
    case 'bad_request':       return 'This inspection is missing the property link needed to request a code.';
    default:                  return d?.error || 'Something went wrong. Try again.';
  }
}

function CodeModal({ modal, onClose }: { modal: ModalState; onClose: () => void }) {
  // brand pink for errors/OK, aqua for a live code, grey for the safe-mode stub.
  const accent = modal.kind === 'error' ? '#ff0060' : modal.kind === 'warn' ? '#9ca3af' : '#73E3DF';
  const code = 'code' in modal ? modal.code : undefined;
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl w-[86%] max-w-sm text-center shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ height: 6, background: accent }} />
        <div className="p-6">
          <h2 className="font-heading font-bold text-lg text-ink mb-1">{modal.title}</h2>
          {code && (
            <div className="text-4xl font-bold tracking-[0.3em] text-ink my-3 tabular-nums">{code}</div>
          )}
          {modal.subtitle && (
            <p className="whitespace-pre-line text-sm text-gray-500 mb-5">{modal.subtitle}</p>
          )}
          <button
            type="button"
            onClick={onClose}
            className="bg-brand hover:bg-brand-dark text-white font-heading font-semibold rounded-lg px-7 py-2.5 active:scale-[0.98] transition"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
